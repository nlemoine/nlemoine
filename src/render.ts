import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import Twig from 'twig'
import { createOctofolio } from '@n5s/octofolio'
import TimeAgo from 'javascript-time-ago'
import en from 'javascript-time-ago/locale/en'
import { dump as dumpToHtml } from '@poppinss/dumper/html'

// Sort an array of objects by a field. Pass 'desc' as the second arg for descending order.
// Usage in template: {{ list|sortBy('stargazerCount', 'desc') }}
Twig.extendFilter('sortBy', (value: unknown, params?: unknown[]) => {
  if (!Array.isArray(value)) return value
  const field = params?.[0] as string
  const dir = params?.[1] === 'desc' ? -1 : 1
  return [...value].sort((a, b) => {
    const x = (a as Record<string, unknown>)?.[field] as never
    const y = (b as Record<string, unknown>)?.[field] as never
    if (x < y) return -1 * dir
    if (x > y) return 1 * dir
    return 0
  })
})

// Humanized relative time via javascript-time-ago. Usage: {{ repo.pushedAt|timeAgo }}.
// Locale is en; swap the locale import + constructor arg for another language.
TimeAgo.addDefaultLocale(en)
const timeAgo = new TimeAgo('en-US')
Twig.extendFilter('timeAgo', (value: unknown) => {
  if (!value) return ''
  const date = new Date(value as string | number | Date)
  return Number.isNaN(date.getTime()) ? '' : timeAgo.format(date)
})

// Count-aware singular/plural via Intl.PluralRules — locale plural categories rather
// than a hardcoded n===1 rule, and no assumed suffix (pass both forms explicitly):
// {{ n|pluralize('commit', 'commits') }} -> "1 commit" / "5 commits".
const pluralRules = new Intl.PluralRules('en')
Twig.extendFilter('pluralize', (value: unknown, params?: unknown[]) => {
  const count = Number(value) || 0
  const one = String(params?.[0] ?? '')
  const other = params?.[1] != null ? String(params[1]) : one
  return `${count} ${pluralRules.select(count) === 'one' ? one : other}`
})

// Rich, collapsible value dump via @poppinss/dumper — the JS equivalent of symfony's
// VarDumper. Returns self-styled HTML; the preview also injects the dumper's stylesheet
// + script (theming + collapsible nodes). Filter ({{ pr|dump }}) and function override
// ({{ dump(pr) }}).
// expand: open nodes by default (use 'all' to expand every nested level).
const dumpConfig = { expand: true } as const
Twig.extendFilter('dump', (value: unknown) => dumpToHtml(value, dumpConfig))
Twig.extendFunction('dump', (...args: unknown[]) =>
  dumpToHtml(args.length === 1 ? args[0] : args, dumpConfig),
)

// Cache modes, all backed by .cache/<method>-<argHash>.json:
//   online  — cache-first: serve from cache, and on a miss fetch that one call once
//             and persist it. The preview default, so changing a template arg
//             hot-reloads the new data without re-running anything. Repeated reloads
//             stay cache-only, so it doesn't hammer GitHub's 30/min Search API.
//   refresh — always fetch fresh + write. The explicit "get new data" step used by
//             render-readme.ts and the CI workflow.
//   offline — cache-only: never touch the network; a miss renders blank. Used when
//             no token is available.
export type CacheMode = 'online' | 'refresh' | 'offline'

export interface CacheOptions {
  dir: string
  mode: CacheMode
}

const MISS = Symbol('cache-miss')

async function readCache<T>(file: string): Promise<T | typeof MISS> {
  if (!existsSync(file)) return MISS
  try {
    return JSON.parse(await readFile(file, 'utf-8')).data as T
  } catch {
    return MISS
  }
}

async function withCache<T>(
  cache: CacheOptions,
  method: string,
  args: unknown[],
  fetchFresh: () => Promise<T>,
): Promise<T> {
  const suffix = args.length
    ? `-${createHash('sha1').update(JSON.stringify(args)).digest('hex').slice(0, 12)}`
    : ''
  const file = `${cache.dir}/${method}${suffix}.json`

  // online + offline both serve from cache first; only refresh skips the read.
  if (cache.mode !== 'refresh') {
    const cached = await readCache<T>(file)
    if (cached !== MISS) return cached
    if (cache.mode === 'offline') {
      console.warn(`[offline] cache miss: ${method}() — run \`bun render-readme.ts\` to fetch it`)
      return [] as unknown as T // safe empty for iteration, property access and filters
    }
  }

  // online miss or refresh: fetch once and persist
  const data = await fetchFresh()
  await mkdir(cache.dir, { recursive: true })
  await writeFile(file, JSON.stringify({ timestamp: Date.now(), data }))
  return data
}

// Wrap an octofolio instance so every method call is transparently cached to disk.
// Lives here, not in octofolio — the library stays a pure data layer with no templating
// or caching concerns. The wrapped instance is still called the same way in templates:
// me.repos({ count: 10 }) hits the cache; only a miss reaches the GitHub API.
function withDiskCache<T extends object>(instance: T, cache: CacheOptions): T {
  return new Proxy(instance, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) =>
        withCache(cache, String(prop), args, () => value.apply(target, args))
    },
  })
}

/* TODO: revisit — count merged PRs by repo primaryLanguage. Disabled for now.
// Count merged PRs whose target repo's primaryLanguage matches `language`.
// The PullRequest object only carries repoNameWithOwner, so language comes from a
// per-repo me.repo() lookup (deduped here; the disk cache dedupes across renders).
// Capped at `count`: this is "PHP-repo PRs among the last N merged", not a lifetime total.
async function countMergedPrsByLanguage(
  me: ReturnType<typeof createOctofolio>,
  language: string,
  count: number,
): Promise<number> {
  const prs = await me.pullRequests({ state: 'MERGED', count })
  const langByRepo = new Map<string, string | null>()
  let total = 0
  for (const pr of prs) {
    if (!langByRepo.has(pr.repoNameWithOwner)) {
      let lang: string | null = null
      try {
        const repo = await me.repo(pr.repoNameWithOwner)
        // offline cache-miss returns [] from the proxy; guard against it.
        lang = repo && !Array.isArray(repo) ? repo.primaryLanguage : null
      } catch {
        lang = null // deleted/renamed/inaccessible repo
      }
      langByRepo.set(pr.repoNameWithOwner, lang)
    }
    if (langByRepo.get(pr.repoNameWithOwner) === language) total++
  }
  return total
}
*/

export interface RenderOptions {
  templatePath: string
  token?: string // required for refresh; unused in offline mode
  cache?: Partial<CacheOptions>
}

export async function renderReadme({
  templatePath,
  token = '',
  cache,
}: RenderOptions): Promise<string> {
  const cacheOptions: CacheOptions = {
    dir: cache?.dir ?? '.cache',
    mode: cache?.mode ?? 'refresh',
  }
  const me = withDiskCache(createOctofolio({ token }), cacheOptions)
  // TODO: revisit PHP merged-PR stat — re-enable, then pass `stats` to renderAsync below.
  // const stats = { phpMergedPrs: await countMergedPrsByLanguage(me, 'PHP', 100) }
  const data = await readFile(templatePath, 'utf-8')
  // rethrow: surface compile/runtime errors instead of Twig.js's default of
  // logging them and rendering empty (which shows as a silent blank preview).
  return Twig.twig({ data, rethrow: true }).renderAsync({ me })
}
