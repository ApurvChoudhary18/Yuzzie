/**
 * The permission matrix from SPEC.md §14.2, encoded once.
 *
 * The agent column is "member role, except destructive operations". §13.4 places
 * the `--allow-destructive` gate in the MCP server, but a client-side flag is no
 * protection at all, so the API denies agent card deletion outright and says
 * where the capability actually lives. A human member can still delete their own
 * card, and an owner can delete any.
 */
import { boardError, type Role, type UserKind } from '@yuzie/core'

export type Action =
  | 'board.read'
  | 'card.write'
  | 'card.assign'
  | 'card.delete'
  | 'comment.create'
  | 'checklist.write'
  | 'git.write'
  | 'watch.write'
  | 'column.manage'
  | 'label.manage'
  | 'member.invite'
  | 'board.update'
  | 'board.archive'

export const ACTIONS: readonly Action[] = [
  'board.read',
  'card.write',
  'card.assign',
  'card.delete',
  'comment.create',
  'checklist.write',
  'git.write',
  'watch.write',
  'column.manage',
  'label.manage',
  'member.invite',
  'board.update',
  'board.archive',
]

export interface Actor {
  readonly role: Role
  readonly kind: UserKind
  /** True when the actor created the card being acted on. */
  readonly ownsCard?: boolean
}

export function can(action: Action, actor: Actor): boolean {
  const { role, kind } = actor

  switch (action) {
    // Everyone who is a member of the board can read it and comment on it.
    case 'board.read':
    case 'comment.create':
    case 'watch.write':
      return true

    // Viewers are read-only; owners, members and agents may write.
    case 'card.write':
    case 'card.assign':
    case 'checklist.write':
    case 'git.write':
      return role !== 'viewer'

    case 'card.delete':
      if (role === 'owner') return true
      if (role === 'viewer') return false
      // role === 'member'
      if (kind === 'agent') return false
      return actor.ownsCard === true

    // Board shape and membership are the owner's alone.
    case 'column.manage':
    case 'label.manage':
    case 'member.invite':
    case 'board.update':
    case 'board.archive':
      return role === 'owner'

    default:
      // Unknown actions are denied, so adding one to the union without adding a
      // rule fails closed rather than open.
      return false
  }
}

const EXPLANATIONS: Partial<Record<Action, string>> = {
  'card.delete': 'Only the card owner or a board owner can delete a card.',
  'column.manage': 'Only a board owner can manage columns.',
  'label.manage': 'Only a board owner can manage labels.',
  'member.invite': 'Only a board owner can invite members or change roles.',
  'board.update': 'Only a board owner can change board settings.',
  'board.archive': 'Only a board owner can archive a board.',
}

/** Throw the §12.1 `forbidden` error unless the actor may perform `action`. */
export function authorize(action: Action, actor: Actor): void {
  if (can(action, actor)) return

  const agentDelete = action === 'card.delete' && actor.kind === 'agent'
  const detail = agentDelete
    ? 'Agents cannot delete cards over the API. Run the MCP server with --allow-destructive if an operator wants to permit it.'
    : (EXPLANATIONS[action] ?? `Your role (${actor.role}) does not permit this.`)

  throw boardError('forbidden', `Not allowed: ${action}. ${detail}`, {
    details: { action, role: actor.role, kind: actor.kind },
  })
}
