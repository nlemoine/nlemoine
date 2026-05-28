import { execSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import MarkdownIt from 'markdown-it'
import { createServer } from 'vite'
import { createScript, createStyleSheet } from '@poppinss/dumper/html'
import { renderReadme } from './src/render'

const templatePath = process.argv[2] ?? 'README.md.twig'
const templateAbs = resolve(templatePath)
const port = Number(process.env.PORT ?? 3000)

const require = createRequire(import.meta.url)
const css = await readFile(
  require.resolve('github-markdown-css/github-markdown.css'),
  'utf-8',
)
const md = new MarkdownIt({ html: true, linkify: true })

// @poppinss/dumper assets, injected once so {{ dump(x) }} output is themed + collapsible.
const dumperStyles = createStyleSheet()
const dumperScript = createScript()

// Cache-first: serve from .cache, and on a miss (e.g. you changed a function arg)
// fetch that one call live + persist it, so hot reload shows new data without
// re-running render-readme. Token comes from GITHUB_TOKEN or the gh CLI; without
// one we fall back to offline (cache-only, misses render blank).
function resolveToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  try {
    return execSync('gh auth token', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}
const token = resolveToken()
const mode: 'online' | 'offline' = token ? 'online' : 'offline'

const escapeHtml = (s: string): string =>
  s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))

function pageHtml(body: string, isError = false): string {
  const content = isError
    ? `<pre class="preview-error">${escapeHtml(body)}</pre>`
    : body
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>README preview</title>
<style>
${css}
body { margin: 0; }
.markdown-body { box-sizing: border-box; max-width: 900px; margin: 0 auto; padding: 32px 16px; }
.preview-error { white-space: pre-wrap; color: #cf222e; font-family: ui-monospace, SFMono-Regular, monospace; }
</style>
<style>${dumperStyles}</style>
<script>${dumperScript}</script>
</head>
<body>
<article class="markdown-body">${content}</article>
</body>
</html>`
}

// Cache-first render: cached calls are instant; a changed arg fetches once (online).
async function renderPageHtml(): Promise<string> {
  try {
    return pageHtml(md.render(await renderReadme({ templatePath, token, cache: { mode } })))
  } catch (e) {
    return pageHtml(`Render failed:\n\n${(e as Error).stack ?? (e as Error).message}`, true)
  }
}

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  appType: 'custom', // we serve our own HTML; no SPA/index.html fallback
  clearScreen: false,
  server: { port },
  plugins: [
    {
      name: 'twig-readme-preview',
      configureServer(vite) {
        // Full-reload the browser whenever the template changes. Driven off the
        // watcher's change event (stable across Vite versions) rather than the
        // handleHotUpdate hook, since the .twig isn't in Vite's module graph.
        vite.watcher.add(templateAbs)
        vite.watcher.on('change', (file) => {
          if (file === templateAbs || file.endsWith('.twig')) {
            vite.ws.send({ type: 'full-reload' })
          }
        })
        // Serve the rendered page after Vite's own middlewares (so /@vite/client
        // and HMR endpoints are handled by Vite first).
        return () => {
          vite.middlewares.use(async (req, res, next) => {
            const url = (req.url ?? '/').split('?')[0]
            if (url !== '/' && url !== '/index.html') return next()
            try {
              // transformIndexHtml injects Vite's HMR client (/@vite/client).
              const html = await vite.transformIndexHtml(url, await renderPageHtml())
              res.statusCode = 200
              res.setHeader('content-type', 'text/html; charset=utf-8')
              res.end(html)
            } catch (e) {
              next(e)
            }
          })
        }
      },
    },
  ],
})

await server.listen()
console.log(`Preview: http://localhost:${port}  (${mode}, watching ${templatePath})`)
