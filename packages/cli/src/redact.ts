/**
 * Redaction (SPEC.md §15, §18 Session 16): what goes into the log file and the
 * diagnostic bundle never carries a secret or the user's own paths.
 *
 * Tokens are recognisable (`yz_…`, §13.3), and so are bearer headers, URL
 * passwords and anything named like a secret. The home directory becomes `~`.
 * It errs on the side of hiding: a bundle is meant to be attached to an issue.
 */

const TOKEN = /\byz_[A-Za-z0-9_-]{8,}/g
const BEARER = /\b(Bearer|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi
/** `password=…`, `"token": "…"`, `API_KEY: …` and the like. */
const NAMED_SECRET =
  /\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|credential)[A-Za-z0-9_-]*)(["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi

export const REDACTED = '[redacted]'

/** A name that says its value is a secret: `YUZIE_TOKEN`, `GITHUB_PASSWORD`, `apiKey`. */
export function isSecretName(name: string): boolean {
  return /token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|cookie|session/i.test(
    name,
  )
}

export function redact(text: string, home?: string): string {
  let out = text
    .replace(TOKEN, `yz_${REDACTED}`)
    .replace(BEARER, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(
      URL_PASSWORD,
      (_match, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`,
    )
    .replace(
      NAMED_SECRET,
      (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`,
    )
  if (home !== undefined && home.length > 1) out = out.split(home).join('~')
  return out
}

/** Deep-copy `value` with secret-named keys replaced and every string redacted. */
export function redactValue(value: unknown, home?: string): unknown {
  if (typeof value === 'string') return redact(value, home)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, home))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        isSecretName(key) && item !== undefined && item !== null
          ? REDACTED
          : redactValue(item, home),
      ]),
    )
  }
  return value
}
