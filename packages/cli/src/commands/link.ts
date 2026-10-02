/**
 * `yuzie link <board>` and `yuzie unlink` (SPEC.md §7.2): attach this
 * repository to a board that already exists, or detach it. Only the
 * repository's `.yuzie/config.json` changes; the board on the server is never
 * touched.
 */
import { NotFoundError } from '@yuzie/core'
import { type ConfigLayer, repoConfigPath, writeLayer } from '../config.js'
import type { Context } from '../context.js'
import { ignoreCache } from './init.js'
import { requireRepo } from './setup.js'

export async function link(context: Context, slug: string): Promise<void> {
  const repo = await requireRepo(context)
  context.requireNetwork('Linking a board')
  const client = await context.client()
  const wanted = slug.trim().toLowerCase()
  const board = (await client.boards.list()).find((candidate) => candidate.slug === wanted)
  if (board === undefined) {
    throw new NotFoundError('board_not_found', `No board "${slug}" that you are a member of.`)
  }

  const loaded = await context.config()
  const previous = loaded.repoLayer.board
  const layer: ConfigLayer = {
    ...loaded.repoLayer,
    version: 1,
    board: board.slug,
    server: loaded.config.server,
  }
  await writeLayer(context.options.config ?? repoConfigPath(repo.root), layer)
  context.reloadConfig()
  await ignoreCache(repo.root)

  const { output } = context
  if (previous === board.slug) output.success(`Already linked to "${board.name}"`)
  else if (previous === undefined) output.success(`Linked ${repo.name} to "${board.name}"`)
  else output.success(`Linked ${repo.name} to "${board.name}" (was ${previous})`)
  output.result(
    'Link',
    { board: board.slug, previous: previous ?? null, repo: repo.name },
    { boardSlug: board.slug },
  )
}

export async function unlink(context: Context): Promise<void> {
  const repo = await requireRepo(context)
  const loaded = await context.config()
  const { board: previous, ...rest } = loaded.repoLayer
  const { output } = context
  if (previous === undefined) {
    output.success('This repository is not linked to a board')
    output.result('Unlink', { board: null, repo: repo.name })
    return
  }
  await writeLayer(context.options.config ?? repoConfigPath(repo.root), rest)
  context.reloadConfig()
  output.success(`Unlinked ${repo.name} from ${previous}`)
  output.line(
    output.paint('dim', '  The board is still on the server; `yuzie link` reattaches it.'),
  )
  output.result('Unlink', { board: previous, repo: repo.name })
}
