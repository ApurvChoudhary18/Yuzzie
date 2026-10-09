/**
 * `GET /device` — where `yuzie login` sends people to approve a sign-in
 * (SPEC.md §6.1). A self-hosted server has no other website, so it serves this
 * one page itself: no external scripts, styles or fonts, and a Content Security
 * Policy that allows exactly the inline script and style below, by hash.
 *
 * With GitHub sign-in configured the page is a single "Sign in with GitHub"
 * form instead: the code goes to `/v1/auth/github/start`, which sends the
 * browser on to GitHub (routes/github.ts).
 */
import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { githubSignIn, type ServerConfig } from '../config.js'

const STYLE = `
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; color: #1b1b1f; background: #fafafa; }
  @media (prefers-color-scheme: dark) { body { color: #e8e8ec; background: #16161a; } input { background: #222228; color: inherit; } }
  h1 { font-size: 1.25rem; } label { display: block; margin: 1rem 0 .25rem; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; padding: .5rem; font: inherit; border: 1px solid #8888; border-radius: 6px; }
  button { margin-top: 1.25rem; padding: .6rem 1.2rem; font: inherit; border-radius: 6px; border: 0; background: #5b5bd6; color: #fff; cursor: pointer; }
  small { color: #888; } #result { margin-top: 1.25rem; min-height: 1.5rem; }
`

const SCRIPT = `
  const form = document.getElementById('approve');
  const result = document.getElementById('result');
  const params = new URLSearchParams(location.search);
  if (params.get('code')) form.userCode.value = params.get('code');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    result.textContent = 'Approving…';
    const headers = { 'content-type': 'application/json' };
    const token = form.token.value.trim();
    if (token) headers.authorization = 'Bearer ' + token;
    try {
      const response = await fetch('/v1/auth/device/approve', {
        method: 'POST',
        headers,
        body: JSON.stringify({ userCode: form.userCode.value.trim().toUpperCase(), handle: form.handle.value.trim() }),
      });
      const body = await response.json().catch(() => ({}));
      result.textContent = response.ok
        ? 'Approved. You can return to your terminal.'
        : (body.error && body.error.message) || 'That did not work (' + response.status + ').';
    } catch {
      result.textContent = 'Could not reach the server.';
    }
  });
`

function sha256(source: string): string {
  return `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to Yuzie</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Sign in to Yuzie</h1>
<p>Enter the code shown in your terminal and the handle you want to sign in as.</p>
<form id="approve">
  <label for="userCode">Code</label>
  <input id="userCode" name="userCode" autocomplete="off" placeholder="WXYZ-4821" required>
  <label for="handle">Handle</label>
  <input id="handle" name="handle" autocomplete="username" placeholder="rahul" required>
  <label for="token">Existing token <small>(only if this handle has signed in before)</small></label>
  <input id="token" name="token" type="password" autocomplete="off" placeholder="yz_…">
  <button type="submit">Approve</button>
</form>
<p id="result" role="status"></p>
<script>${SCRIPT}</script>
</body>
</html>
`

const POLICY = [
  "default-src 'none'",
  `script-src ${sha256(SCRIPT)}`,
  `style-src ${sha256(STYLE)}`,
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ')

const GITHUB_SCRIPT = `
  const params = new URLSearchParams(location.search);
  if (params.get('code')) document.getElementById('code').value = params.get('code');
`

function githubPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to Yuzie</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Sign in to Yuzie</h1>
<p>Enter the code shown in your terminal, then sign in with GitHub. Your GitHub username is your
Yuzie handle.</p>
<form method="get" action="/v1/auth/github/start">
  <label for="code">Code</label>
  <input id="code" name="code" autocomplete="off" placeholder="WXYZ-4821" required>
  <button type="submit">Sign in with GitHub</button>
</form>
<script>${GITHUB_SCRIPT}</script>
</body>
</html>
`
}

function githubPolicy(githubUrl: string): string {
  return [
    "default-src 'none'",
    `script-src ${sha256(GITHUB_SCRIPT)}`,
    `style-src ${sha256(STYLE)}`,
    // The form goes to this server, which redirects to GitHub; browsers check
    // form-action against the redirect too.
    `form-action 'self' ${new URL(githubUrl).origin}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ')
}

function send(reply: FastifyReply, html: string, policy: string, status = 200): FastifyReply {
  return reply
    .status(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('content-security-policy', policy)
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .send(html)
}

/** A page with a heading and a sentence, for the end of the GitHub round trip. */
export function sendMessagePage(
  reply: FastifyReply,
  heading: string,
  message: string,
  status = 200,
): FastifyReply {
  const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${escapeHtml(heading)}</h1>
<p>${escapeHtml(message)}</p>
</body>
</html>
`
  const policy = [
    "default-src 'none'",
    `style-src ${sha256(STYLE)}`,
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ')
  return send(reply, html, policy, status)
}

export function registerDevicePage(app: FastifyInstance, config: ServerConfig): void {
  const github = githubSignIn(config)
  const html = github ? githubPage() : PAGE
  const policy = github ? githubPolicy(config.githubUrl) : POLICY
  app.get('/device', async (_request, reply) => send(reply, html, policy))
}
