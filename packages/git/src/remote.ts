/**
 * Git remote URLs → `github.com/acme/payments-api` (SPEC.md §6.1).
 *
 * Pure, so every URL shape is tested without a repository: scp-style SSH,
 * `ssh://` with a port, HTTPS with credentials, and local paths.
 */

export interface Remote {
  /** The URL as configured. */
  readonly url: string
  /** Host without user or port, e.g. `github.com`; null for a local path. */
  readonly host: string | null
  /** Owner and repository, e.g. `acme/payments-api`. */
  readonly path: string
  /** The repository name, e.g. `payments-api`. */
  readonly name: string
  /** `github.com/acme/payments-api` — how the CLI prints and stores it. */
  readonly display: string
}

function tidy(path: string): string {
  return path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
}

function build(url: string, host: string | null, rawPath: string): Remote | null {
  const path = tidy(rawPath)
  const name = path.split('/').filter(Boolean).at(-1)
  if (name === undefined || name.length === 0) return null
  return { url, host, path, name, display: host === null ? path : `${host}/${path}` }
}

export function parseRemote(input: string): Remote | null {
  const url = input.trim()
  if (url.length === 0) return null

  // ssh://git@host:2222/org/repo.git, https://user:token@host/org/repo.git, git://…
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'file:') return build(url, null, parsed.pathname)
      return build(url, parsed.hostname.toLowerCase(), decodeURIComponent(parsed.pathname))
    } catch {
      return null
    }
  }

  // scp-like: git@github.com:acme/payments-api.git (a colon before any slash)
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(url)
  if (scp !== null) return build(url, (scp[1] as string).toLowerCase(), scp[2] as string)

  // A local path: /srv/git/repo.git or ../repo
  return build(url, null, url)
}
