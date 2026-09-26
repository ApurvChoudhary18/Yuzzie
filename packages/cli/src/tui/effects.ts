/**
 * What the TUI's keys do to the board: each effect from the reducer, carried
 * out through the SDK. Writes are optimistic there, so the screen changes the
 * moment a key is pressed; a write the server refuses is rolled back by the
 * SDK and reported by the source as a conflict (§18 Session 9).
 */
import { ConflictError } from '@yuzie/core'
import { type Board, matchColumn } from '@yuzie/sdk'
import { diffCard, editText, parseDocument, toDocument } from '../edit.js'
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
}

/** What a key does until its feature exists: how to do it from the CLI instead. */
function laterHint(effect: Effect): string | null {
  switch (effect.type) {
    case 'claim':
      return 'Claiming arrives with git integration.'
    case 'openAnchor':
    case 'openBranch':
      return 'Opening code and branches arrives with git integration.'
    default:
      return null
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
    case 'open':
      context.presence.view(effect.cardNo)
      await source.loadActivity(effect.cardNo)
      return
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
      source.say(card.number > 0 ? `Created #${card.number}` : 'Created (queued)', 'event')
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
    default: {
      const hint = laterHint(effect)
      if (hint !== null) source.say(hint, 'info')
    }
  }
}

/** Run an effect in the background; failures become a toast, never a crash. */
export function perform(effect: Effect, context: EffectContext): void {
  runEffect(effect, context).catch((error: unknown) => {
    // The SDK has already rolled the change back and the source said so.
    if (error instanceof ConflictError) return
    context.source.say(message(error), 'warn')
  })
}
