/**
 * One line per event, for `yuzie feed` and `yuzie activity` (SPEC.md §7.2, §6.4):
 *
 *     09:14  @priya  moved #15 Login flow → Done
 */
import type { BoardState, EventEnvelope } from '@yuzie/core'
import { columnName } from './cards.js'
import { plural, truncate } from './text.js'

function title(state: BoardState, number: number | undefined): string {
  if (number === undefined) return ''
  const card = state.cards[number]
  return card === undefined ? `#${number}` : `#${number} ${card.title}`
}

/** What happened, in words — without the actor, which the caller prints. */
export function describeEvent(event: EventEnvelope, state: BoardState): string {
  switch (event.type) {
    case 'card.created':
      return `created #${event.payload.number} ${event.payload.title}`
    case 'card.updated': {
      const fields = Object.keys(event.payload.fields)
      if (fields.length === 1 && fields[0] === 'watchers')
        return `changed who watches ${title(state, event.cardNo)}`
      return `edited ${title(state, event.cardNo)} (${fields.join(', ')})`
    }
    case 'card.moved':
      return `moved ${title(state, event.cardNo)} → ${columnName(state.columns, event.payload.to)}`
    case 'card.assigned': {
      const parts = [
        ...(event.payload.added.length === 0
          ? []
          : [`assigned ${event.payload.added.map((h) => `@${h}`).join(', ')} to`]),
        ...(event.payload.removed.length === 0
          ? []
          : [`unassigned ${event.payload.removed.map((h) => `@${h}`).join(', ')} from`]),
      ]
      return `${parts.join(' and ')} ${title(state, event.cardNo)}`
    }
    case 'card.deleted':
      return `deleted #${event.payload.number}`
    case 'comment.created':
      return `commented on ${title(state, event.cardNo)}: "${truncate(event.payload.body.replace(/\s+/g, ' '), 60)}"`
    case 'checklist.updated':
      return `${event.payload.done ? 'checked' : 'unchecked'} an item on ${title(state, event.cardNo)}`
    case 'card.branch.linked':
      return `linked ${title(state, event.cardNo)} to ${event.payload.branch}`
    case 'card.git.updated': {
      const stats = [
        ...(event.payload.commits === undefined ? [] : [plural(event.payload.commits, 'commit')]),
        ...(event.payload.filesChanged === undefined
          ? []
          : [plural(event.payload.filesChanged, 'file')]),
      ]
      return `updated git for ${title(state, event.cardNo)}${stats.length === 0 ? '' : ` (${stats.join(' · ')})`}`
    }
    case 'card.commits.attached':
      return `attached ${plural(event.payload.shas.length, 'commit')} to ${title(state, event.cardNo)}`
    case 'card.anchor.set':
      return `anchored ${title(state, event.cardNo)} at ${event.payload.path}${event.payload.line === null ? '' : `:${event.payload.line}`}`
    case 'member.joined':
      return `added @${event.payload.handle} as ${event.payload.role}`
    case 'member.left':
      return `removed @${event.payload.handle}`
    case 'board.updated':
      return `updated the board (${Object.keys(event.payload.fields).join(', ')})`
  }
}

export function actor(event: EventEnvelope): string {
  return event.actor === null ? 'yuzie' : `@${event.actor}`
}
