/**
 * Point testcontainers at whatever Docker runtime this machine actually has.
 *
 * testcontainers looks for `/var/run/docker.sock`, which Docker Desktop and CI
 * provide but colima, Rancher and podman do not — they publish a socket under
 * the user's home and register it as a Docker *context*. Rather than asking
 * every developer to export two environment variables, the active context is
 * read here and translated into the variables testcontainers understands.
 *
 * `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` is the path the Ryuk reaper container
 * bind-mounts *inside* the VM, which is always `/var/run/docker.sock` regardless
 * of where the host socket lives.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const STANDARD_SOCKET = '/var/run/docker.sock'

function activeContextEndpoint(): string | null {
  try {
    const endpoint = execFileSync(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    return endpoint.length > 0 ? endpoint : null
  } catch {
    return null
  }
}

if (process.env.DOCKER_HOST === undefined && !existsSync(STANDARD_SOCKET)) {
  const endpoint = activeContextEndpoint()
  if (endpoint !== null) {
    process.env.DOCKER_HOST = endpoint
  }
}

const host = process.env.DOCKER_HOST
if (
  process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE === undefined &&
  host !== undefined &&
  host.startsWith('unix://') &&
  host !== `unix://${STANDARD_SOCKET}`
) {
  process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE = STANDARD_SOCKET
}
