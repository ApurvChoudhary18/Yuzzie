#!/usr/bin/env node
/**
 * Follow a guide verbatim (SPEC.md §18 Session 17): every ```sh block in the
 * Markdown file, in order, as one bash script with `set -euo pipefail`, in an
 * empty directory. Other fences (```console, ```text) are for reading only.
 *
 *   node scripts/ci/follow-guide.mjs docs/self-hosting.md [workdir]
 *
 * Also checks that the guide's copy of deploy/docker-compose.yml is identical.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const [guide, workdir] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
if (guide === undefined) {
  console.error('usage: follow-guide.mjs <guide.md> [workdir]')
  process.exit(2)
}
const root = resolve(import.meta.dirname, '..', '..')
const text = readFileSync(guide, 'utf8')
const blocks = [...text.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((match) => match[1])
if (blocks.length === 0) {
  console.error(`${guide} has no \`\`\`sh blocks`)
  process.exit(1)
}

const compose = /cat > docker-compose\.yml <<'YAML'\n([\s\S]*?)^YAML$/m.exec(text)?.[1]
if (compose !== undefined) {
  const source = readFileSync(join(root, 'deploy', 'docker-compose.yml'), 'utf8')
  if (compose !== source) {
    console.error(`${guide}'s docker-compose.yml differs from deploy/docker-compose.yml`)
    process.exit(1)
  }
}
if (process.argv.includes('--check')) process.exit(0)

const cwd = workdir === undefined ? mkdtempSync(join(tmpdir(), 'guide-')) : resolve(workdir)
mkdirSync(cwd, { recursive: true })
const script = ['set -euo pipefail', 'set -x', ...blocks].join('\n')
console.log(`following ${guide} (${blocks.length} blocks) in ${cwd}`)
const result = spawnSync('bash', ['-c', script], { cwd, stdio: 'inherit' })
process.exit(result.status ?? 1)
