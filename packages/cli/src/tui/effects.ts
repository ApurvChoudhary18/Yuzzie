/**
 * What the TUI's keys do to the board: each effect from the reducer, carried
 * out through the SDK. Writes are optimistic there, so the screen changes the
 * moment a key is pressed; a write the server refuses is rolled back by the
 * SDK and reported by the source as a conflict (§18 Session 9).
 */
import { spawn } from 'node:child_process'
import { ConflictError } from '@yuzie/core'
import type { Repo } from '@yuzie/git'
import { type Board, matchColumn } from '@yuzie/sdk'
import { diffCard, editText, parseDocument, toDocument } from '../edit.js'
import { describeTarget, editorTarget, launch, staleness, webTarget } from '../open.js'
import type { SdkSource } from './source.js'
import type { Effect } from './state.js'

export const ENTER_ALT_SCREEN = '\u001b[?1049h\u001b[?25l'
export const LEAVE_ALT_SCREEN = '\u001b[?25h\u001b[?1049l'

export interface EffectContext {
  readonly board: Board
  readonly source: SdkSource
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stdout: { write(text: string): unknown }
  /** Where "done" goes, from the flow config (§10). */
  readonly doneColumn: () => Promise<string>
  /** Hand the terminal to a child process, then take it back (Ink's `suspendTerminal`). */
  readonly suspend: (run: () => Promise<void>) => Promise<void>
  readonly quit: () => void
  /** Tells the board which card is open (§8.5 presence). */
  readonly presence: { view(cardNo: number | null): void }
  /** The repository here, if any (for `o`, `g`, `c` and anchor staleness). */
  readonly repo: () => Promise<Repo | null>
  /** `git.baseBranch`, for compare views. */
  readonly baseBranch: () => Promise<string>
  /** False in CI: `o` and `g` say where they would go instead of launching (§18 Session 12). */
  readonly launchAllowed: boolean
  /** This CLI as a command line, to run `yuzie claim` for `c`. */
  readonly cli: readonly string[]
  readonly cwd: string
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const fix = (error as { fix?: unknown } | null)?.fix
  return typeof fix === 'string' && !text.includes(fix) ? `${text} ${fix}` : text
}

/** `o`: the editor at the card's anchor — the same path as `yuzie open` (§9.7). */
async function openAnchor(cardNo: number, context: EffectContext): Promise<void> {
  const card = context.board.state.cards[cardNo]
  if (card === undefined) return
  const target = editorTarget(card, await context.repo(), context.env)
  if (!context.launchAllowed) {
    context.source.say(`Would open: ${describeTarget(target)}`, 'info')
    return
  }
  let failure: unknown = null
  await context.suspend(async () => {
    context.stdout.write(LEAVE_ALT_SCREEN)
    try {
      await launch(target, context.env)
    } catch (error) {
      failure = error
    } finally {
      context.stdout.write(ENTER_ALT_SCREEN)
    }
  })
  if (failure !== null) context.source.say(message(failure), 'warn')
}

/** `g`: the card's PR, else its branch compare view — the same path as `yuzie open --github`. */
async function openBranch(cardNo: number, context: EffectContext): Promise<void> {
  const card = context.board.state.cards[cardNo]
  if (card === undefined) return
  const target = await webTarget(card, await context.repo(), context.env, 'github', {
    baseBranch: await context.baseBranch(),
  })
  if (!context.launchAllowed || context.env.YUZIE_NO_BROWSER === '1') {
    context.source.say(`Would open: ${describeTarget(target)}`, 'info')
    return
  }
  await launch(target, context.env)
  context.source.say(`Opened ${describeTarget(target)}`, 'info')
}

/**
 * `c`: `yuzie claim` itself, run as a child — the whole §9.3 flow, without
 * questions. A dirty tree or detached HEAD is reported, with how to choose.
 */
async function claimCard(cardNo: number, context: EffectContext): Promise<void> {
  const [program, ...base] = context.cli
  if (program === undefined) return
  const result = await new Promise<{ code: number; stdout: string }>((resolve) => {
    const child = spawn(program, [...base, 'claim', String(cardNo), '--yes', '--json'], {
      cwd: context.cwd,
      env: context.env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.on('error', () => resolve({ code: 1, stdout: '' }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }))
  })
  let document: {
    data?: { branch?: string | null; queued?: boolean }
    error?: { message?: string }
  }
  try {
    document = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}')
  } catch {
    document = {}
  }
  if (result.code === 0) {
    const branch = document.data?.branch
    context.source.say(
      `Claimed #${cardNo}${branch ? ` · on ${branch}` : ''}${document.data?.queued ? ' (queued)' : ''}`,
      'event',
    )
    return
  }
  const why = document.error?.message ?? `yuzie claim exited ${result.code}`
  context.source.say(
    result.code === 8 ? `${why} Run \`yuzie claim ${cardNo}\` in a shell to choose.` : why,
    'warn',
  )
}

/**
 * Run `$EDITOR` on the card as YAML front matter + markdown, then send what
 * changed. The terminal leaves the alternate screen for the editor and comes
 * back to a full redraw, whatever the editor did or how it exited.
 */
async function editCard(cardNo: number, context: EffectContext): Promise<void> {
  const { board, source } = context
  const card = board.state.cards[cardNo]
  if (card === undefined) return
  let text: string | null = null
  let failure: unknown = null
  await context.suspend(async () => {
    context.stdout.write(LEAVE_ALT_SCREEN)
    try {
      text = await editText(context.env, toDocument(card), `card-${card.number}.md`)
    } catch (error) {
      failure = error
    } finally {
      context.stdout.write(ENTER_ALT_SCREEN)
    }
  })
  if (failure !== null) {
    source.say(message(failure), 'warn')
    return
  }
  if (text === null) return
  const latest = board.state.cards[cardNo] ?? card
  const patch = diffCard(latest, parseDocument(text))
  const fields = Object.keys(patch)
  if (fields.length === 0) {
    source.say(`No changes to #${cardNo}`, 'info')
    return
  }
  await board.cards.update(cardNo, patch)
  source.say(`Updated #${cardNo} (${fields.join(', ')})`, 'event')
}

export async function runEffect(effect: Effect, context: EffectContext): Promise<void> {
  const { board, source } = context
  switch (effect.type) {
    case 'quit':
      context.quit()
      return
    case 'refresh':
      await board.refresh()
      source.say('Refreshed', 'info')
      return
    case 'open': {
      context.presence.view(effect.cardNo)
      const card = board.state.cards[effect.cardNo]
      if (card?.anchor) {
        const stale = await staleness(await context.repo(), card).catch(() => null)
        source.setStale(effect.cardNo, stale === true)
      }
      await source.loadActivity(effect.cardNo)
      return
    }
    case 'close':
      context.presence.view(null)
      return
    case 'move':
      await board.cards.move(effect.cardNo, effect.column)
      return
    case 'assign':
      await board.cards.assign(
        effect.cardNo,
        effect.on ? { add: [effect.handle] } : { remove: [effect.handle] },
      )
      return
    case 'comment':
      await board.cards.comment(effect.cardNo, effect.body)
      return
    case 'create': {
      const card = await board.cards.create({ title: effect.title, column: effect.column })
      if (card.number > 0) source.say(`Created #${card.number}`, 'event')
      return
    }
    case 'check':
      await board.cards.check(effect.cardNo, effect.position, effect.done)
      return
    case 'addItem':
      await board.cards.addChecklistItem(effect.cardNo, effect.text)
      return
    case 'delete':
      await board.cards.delete(effect.cardNo)
      source.say(`Deleted #${effect.cardNo}`, 'event')
      return
    case 'watch': {
      const me = board.handle
      const card = board.state.cards[effect.cardNo]
      const watching = me !== null && card?.watchers.includes(me) === true
      await board.cards.watch(effect.cardNo, !watching)
      source.say(`${watching ? 'Stopped watching' : 'Watching'} #${effect.cardNo}`, 'info')
      return
    }
    case 'done': {
      const wanted = await context.doneColumn()
      const column =
        matchColumn(board.state.columns, wanted) ??
        board.state.columns.find((candidate) => candidate.semantics === 'terminal')
      if (column === undefined) {
        source.say('This board has no done column.', 'info')
        return
      }
      await board.cards.move(effect.cardNo, column.key)
      return
    }
    case 'edit':
      await editCard(effect.cardNo, context)
      return
    case 'openAnchor':
      await openAnchor(effect.cardNo, context)
      return
    case 'openBranch':
      await openBranch(effect.cardNo, context)
      return
    case 'claim':
      await claimCard(effect.cardNo, context)
      return
  }
}

/** Run an effect in the background; failures become a toast, never a crash. */
export function perform(effect: Effect, context: EffectContext): void {
  const queuedBefore = context.board.queued
  runEffect(effect, context)
    .then(() => {
      // Offline, a write waits in the outbox: say so, since no event will confirm it.
      if (context.board.queued > queuedBefore)
        context.source.say('Saved offline; it will be sent when the server is back', 'info')
    })
    .catch((error: unknown) => {
      // The SDK has already rolled the change back and the source said so.
      if (error instanceof ConflictError) return
      context.source.say(message(error), 'warn')
    })
}
