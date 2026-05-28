import { writeFile } from 'node:fs/promises'
import { renderReadme } from './src/render'

// Fetches fresh data (refresh mode) and warms the cache the preview reads from.
// Set OCTOFOLIO_OFFLINE=1 to rebuild README.md from the cache without any API calls.
const offline = process.env.OCTOFOLIO_OFFLINE === '1'
const token = process.env.GITHUB_TOKEN
if (!offline && !token) {
  console.error('GITHUB_TOKEN is required (or set OCTOFOLIO_OFFLINE=1 to render from cache)')
  process.exit(1)
}

const templatePath = process.argv[2] ?? 'README.md.twig'
const outputPath = process.argv[3] ?? 'README.md'

const output = await renderReadme({
  templatePath,
  token,
  cache: { mode: offline ? 'offline' : 'refresh' },
})

await writeFile(outputPath, output)
console.log(`Wrote ${outputPath} (${output.length} bytes)`)
