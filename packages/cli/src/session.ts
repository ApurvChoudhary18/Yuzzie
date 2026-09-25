/**
 * Opening the current board for a command (SPEC.md §7.1, §13.1).
 *
 * Every board command reads through `@yuzie/sdk` with the local cache from
 * `@yuzie/store`, so a read works offline and a write under `--offline` queues.
 * One-shot commands do not stream; `yuzie feed` does.
 */
import type { Card, Presence } from '@yuzie/core'
import type { Board } from '@yuzie/sdk'
import { openCache, type YuzieCache } from '@yuzie/store'
import type { Context } from './context.js'
import { UsageError } from './exit.js'
import { resolveCard } from './resolve.js'

export interface BoardSession {
  readonly board: Board
  readonly slug: string
  /** Whether the server was reachable when the board opened. */
  readonly online: boolean
  card(reference: string): Promise<Card>
  presence(): Promise<readonly Presence[]>
  /** `synced`, or `offline · 2 queued`, for footers (§7.3). */
  status(): string
  close(): Promise<void>
}

export async function currentSlug(context: Context): Promise<string> {
  const { config } = await context.config()
  if (config.board === undefined) {
    throw new UsageError(
      'No board here.',
      'Run `yuzie init` in this repository, or pass --board <slug>.',
    )
  }
  return config.board
}

export async function openBoard(
  context: Context,
  options: { live?: boolean } = {},
): Promise<BoardSession> {
  const slug = await currentSlug(context)
  const client = await context.client()

  let cache: YuzieCache | undefined
  try {
    cache = openCache({
      boardSlug: slug,
      cwd: context.io.cwd,
      home: context.home,
      env: context.io.env,
    })
  } catch (error) {
    // No cache is a slower CLI, not a broken one.
    context.output.debug(
      `cache unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const offline = context.options.offline === true
  const board = await client.connect(slug, {
    realtime: options.live === true && !offline,
    offline: offline ? 'queue' : 'fail',
    ...(cache === undefined ? {} : { cache }),
  })

  return {
    board,
    slug,
    online: !offline,
    card: (reference) =>
      resolveCard(
        {
          state: board.state,
          slug,
          prompter: context.prompter.canAsk ? context.prompter : null,
        },
        reference,
      ),
    async presence() {
      if (offline) return []
      try {
        return await board.boards.presence()
      } catch {
        return []
      }
    },
    status() {
      if (!offline) return board.queued > 0 ? `${board.queued} queued` : 'synced'
      return board.queued > 0 ? `offline · ${board.queued} queued` : 'offline · cached'
    },
    async close() {
      await board.close()
      cache?.close()
    },
  }
}

/** Open, run, and always close — the shape of every board command. */
export async function withBoard<T>(
  context: Context,
  run: (session: BoardSession) => Promise<T>,
  options: { live?: boolean } = {},
): Promise<T> {
  const session = await openBoard(context, options)
  try {
    return await run(session)
  } finally {
    await session.close()
  }
}
