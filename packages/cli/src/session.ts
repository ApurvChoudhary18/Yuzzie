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
import { knownHandle, rememberHandle } from './identity.js'
import { printReconciliation, reconcile } from './reconcile.js'
import { ago } from './render/text.js'

/** No answer from /healthz in this long reads as offline (§18 Session 13). */
export const REACHABILITY_MS = 250

import { resolveCard } from './resolve.js'

export interface BoardSession {
  readonly board: Board
  readonly slug: string
  /** You: from the server when it answered, else remembered from last time. */
  readonly me: string | null
  /** Whether the server was reachable when the board opened. */
  readonly online: boolean
  /** Writes already queued when the command started. */
  readonly queuedAtOpen: number
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
  options: {
    live?: boolean
    /**
     * Queue writes the server cannot take right now, instead of failing (§9.3
     * step 8: a claim still creates its branch, and syncs later).
     */
    queue?: boolean
    /** Do not report what opening sent: the caller reports it (`yuzie sync`). */
    quiet?: boolean
  } = {},
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
  // Never blocked by the network (§18 Session 13): reads fall back to the
  // cache, writes queue, and a server that does not answer /healthz within the
  // budget is not waited on at all.
  const budget = Number(context.io.env.YUZIE_REACHABILITY_MS)
  const live = options.live === true && !offline
  const board = await client.connect(slug, {
    realtime: live,
    // `ws`, not the global (undici) WebSocket, and only when streaming (§18 Session 16).
    ...(live ? { webSocket: (await import('@yuzie/sdk/websocket')).nodeWebSocket } : {}),
    offline: 'queue',
    ...(offline
      ? {}
      : {
          reachabilityTimeoutMs: Number.isFinite(budget) && budget > 0 ? budget : REACHABILITY_MS,
        }),
    ...(cache === undefined ? {} : { cache }),
  })
  const online = !offline && board.online !== false

  const server = await context.server()
  let me = board.handle
  if (me !== null) await rememberHandle(context.home, server, me)
  else me = await knownHandle(context.home, server)

  // Opening sent what was queued before this command: say what came of it.
  const drained = board.lastDrain
  if (
    drained !== null &&
    drained.outcomes.length > 0 &&
    !context.output.json &&
    options.quiet !== true
  ) {
    printReconciliation(context.output, reconcile(drained, board.state))
  }
  const queuedAtOpen = board.queued

  return {
    board,
    slug,
    me,
    online,
    queuedAtOpen,
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
      if (!online) return []
      try {
        return await board.boards.presence()
      } catch {
        return []
      }
    },
    status() {
      const queued = board.queued > 0 ? `${board.queued} queued` : null
      if (online) return queued ?? 'synced'
      const syncedAt = cache?.sync.get(slug).syncedAt ?? null
      const age =
        syncedAt === null ? 'never synced' : `cached ${ago(context.now().getTime() - syncedAt)}`
      return ['offline', age, ...(queued === null ? [] : [queued])].join(' · ')
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
  options: { live?: boolean; queue?: boolean; quiet?: boolean } = {},
): Promise<T> {
  const session = await openBoard(context, options)
  try {
    const result = await run(session)
    // Every write that could not reach the server says so (§18 Session 13).
    const added = session.board.queued - session.queuedAtOpen
    if (added > 0 && !context.output.json) {
      context.output.warn(
        `queued (offline): ${added === 1 ? 'this change' : `${added} changes`} will sync when the server is back — \`yuzie sync\``,
      )
    }
    return result
  } finally {
    await session.close()
  }
}
