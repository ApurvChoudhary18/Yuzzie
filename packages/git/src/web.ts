/**
 * Remote URLs → the forge's web pages (SPEC.md §9.1, §18 Session 12): the
 * branch, the compare view, the repository — for GitHub, GitLab, Bitbucket
 * and self-hosted forges, from SSH and HTTPS remotes alike.
 */

export type Forge = 'github' | 'gitlab' | 'bitbucket' | 'unknown'

export interface WebRepo {
  readonly forge: Forge
  /** `https://github.com/acme/payments-api`: no credentials, no `.git`. */
  readonly base: string
  readonly host: string
  /** `acme` — for a nested GitLab group, everything before the last segment. */
  readonly owner: string
  readonly repo: string
}

function forgeFor(host: string): Forge {
  if (host.includes('github')) return 'github'
  if (host.includes('gitlab')) return 'gitlab'
  if (host.includes('bitbucket')) return 'bitbucket'
  return 'unknown'
}

function tidyPath(path: string): string {
  return path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
}

/**
 * The web home of a remote, or null for a local path. SSH ports are dropped
 * (they are not the web port); an HTTPS port and path prefix are kept.
 */
export function webRepo(remoteUrl: string): WebRepo | null {
  const url = remoteUrl.trim()
  let scheme = 'https'
  let authority: string
  let path: string

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    if (parsed.protocol === 'file:' || parsed.hostname.length === 0) return null
    const web = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    if (parsed.protocol === 'http:') scheme = 'http'
    authority = parsed.hostname.toLowerCase() + (web && parsed.port !== '' ? `:${parsed.port}` : '')
    path = decodeURIComponent(parsed.pathname)
  } else {
    const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(url)
    if (scp === null) return null
    authority = (scp[1] as string).toLowerCase()
    path = scp[2] as string
  }

  const tidy = tidyPath(path)
  const segments = tidy.split('/').filter(Boolean)
  const repo = segments.at(-1)
  if (repo === undefined || segments.length < 2) return null
  const host = authority.replace(/:\d+$/, '')
  return {
    forge: forgeFor(host),
    base: `${scheme}://${authority}/${tidy}`,
    host,
    owner: segments.slice(0, -1).join('/'),
    repo,
  }
}

/** A branch name in a URL path: slashes kept, everything else escaped. */
function segment(name: string): string {
  return name.split('/').map(encodeURIComponent).join('/')
}

/** The branch's page. */
export function branchUrl(web: WebRepo, branch: string): string {
  switch (web.forge) {
    case 'gitlab':
      return `${web.base}/-/tree/${segment(branch)}`
    case 'bitbucket':
      return `${web.base}/src/${segment(branch)}`
    default:
      return `${web.base}/tree/${segment(branch)}`
  }
}

/** The compare view of `branch` against `base`, where a PR would be opened from. */
export function compareUrl(web: WebRepo, base: string, branch: string): string {
  switch (web.forge) {
    case 'gitlab':
      return `${web.base}/-/compare/${segment(base)}...${segment(branch)}`
    case 'bitbucket':
      return `${web.base}/branches/compare/${segment(branch)}%0D${segment(base)}`
    default:
      return `${web.base}/compare/${segment(base)}...${segment(branch)}`
  }
}

/** The REST endpoint listing pull requests for a branch — GitHub and GitHub Enterprise. */
export function pullsApiUrl(web: WebRepo, branch: string): string | null {
  if (web.forge === 'gitlab' || web.forge === 'bitbucket') return null
  const api =
    web.host === 'github.com'
      ? 'https://api.github.com'
      : `${web.base.slice(0, web.base.length - `/${web.owner}/${web.repo}`.length)}/api/v3`
  const owner = web.owner.split('/')[0] ?? web.owner
  const query = new URLSearchParams({ head: `${owner}:${branch}`, state: 'all', per_page: '1' })
  return `${api}/repos/${web.owner}/${web.repo}/pulls?${query.toString()}`
}
