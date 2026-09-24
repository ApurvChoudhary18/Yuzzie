/**
 * Who is on a board right now (SPEC.md §8.5, §12.2).
 *
 * Presence is transient: it is never written to the event log and a restart
 * forgets it. Entries are kept per *connection*, because one person may have the
 * TUI open and a `yuzie watch` running, and are merged per *handle* when shown,
 * so they appear once with whatever they are most engaged in.
 *
 * Time is passed in rather than read, so expiry can be tested to the second.
 */
import type { ClientPresenceFrame, Presence, PresenceState, UserKind } from '@yuzie/core'

export interface PresenceUser {
  readonly handle: string
  readonly kind: UserKind
}

interface LocalEntry {
  presence: Presence
  /** Milliseconds; any frame from the connection refreshes it. */
  lastSeen: number
}

interface RemoteList {
  readonly users: readonly Presence[]
  readonly receivedAt: number
}

/** Working beats viewing beats merely online when one person has two sessions. */
const ENGAGEMENT: Record<PresenceState, number> = { online: 0, viewing: 1, working: 2 }

function moreEngaged(a: Presence, b: Presence): Presence {
  const rank = ENGAGEMENT[a.state] - ENGAGEMENT[b.state]
  if (rank !== 0) return rank > 0 ? a : b
  // Same state: the most recent change is the most truthful.
  return (a.since ?? '') >= (b.since ?? '') ? a : b
}

export function mergeByHandle(lists: Iterable<readonly Presence[]>): Presence[] {
  const byHandle = new Map<string, Presence>()
  for (const list of lists) {
    for (const entry of list) {
      const existing = byHandle.get(entry.handle)
      byHandle.set(entry.handle, existing === undefined ? entry : moreEngaged(existing, entry))
    }
  }
  return [...byHandle.values()].sort((a, b) => a.handle.localeCompare(b.handle))
}

export class BoardPresence {
  private readonly local = new Map<string, LocalEntry>()
  private readonly remote = new Map<string, RemoteList>()

  /** A connection opened: its user is online from `now`. */
  join(connectionId: string, user: PresenceUser, now: number): void {
    this.local.set(connectionId, {
      presence: {
        handle: user.handle,
        kind: user.kind,
        state: 'online',
        cardNo: null,
        branch: null,
        since: new Date(now).toISOString(),
      },
      lastSeen: now,
    })
  }

  /** Apply a client `presence` frame. Returns whether anything visible changed. */
  update(connectionId: string, frame: ClientPresenceFrame, now: number): boolean {
    const entry = this.local.get(connectionId)
    if (entry === undefined) return false
    entry.lastSeen = now

    // The client says `idle`; the domain calls that `online` (§8.5).
    const state: PresenceState = frame.state === 'idle' ? 'online' : frame.state
    const cardNo = state === 'online' ? null : (frame.cardNo ?? null)
    const branch = state === 'working' ? (frame.branch ?? null) : null

    const current = entry.presence
    if (current.state === state && current.cardNo === cardNo && current.branch === branch) {
      return false
    }
    entry.presence = { ...current, state, cardNo, branch, since: new Date(now).toISOString() }
    return true
  }

  /** A heartbeat: keeps the entry alive without changing what anyone sees. */
  touch(connectionId: string, now: number): void {
    const entry = this.local.get(connectionId)
    if (entry !== undefined) entry.lastSeen = now
  }

  /** A clean goodbye removes the entry at once rather than waiting out the TTL. */
  leave(connectionId: string): boolean {
    return this.local.delete(connectionId)
  }

  /**
   * Drop local entries not heard from within `ttlMs`, and remote lists whose node
   * has stopped refreshing them. Returns whether anything was removed.
   */
  expire(now: number, ttlMs: number): boolean {
    let changed = false
    for (const [id, entry] of this.local) {
      if (now - entry.lastSeen >= ttlMs) {
        this.local.delete(id)
        changed = true
      }
    }
    for (const [node, list] of this.remote) {
      if (now - list.receivedAt >= ttlMs) {
        this.remote.delete(node)
        changed = true
      }
    }
    return changed
  }

  /** Replace what another node reports for this board. */
  setRemote(node: string, users: readonly Presence[], now: number): void {
    if (users.length === 0) this.remote.delete(node)
    else this.remote.set(node, { users, receivedAt: now })
  }

  /** This node's own entries, merged; what it tells the other nodes. */
  localUsers(): Presence[] {
    return mergeByHandle([[...this.local.values()].map((entry) => entry.presence)])
  }

  /** Everyone, across every node. */
  users(): Presence[] {
    const remote = [...this.remote.values()].map((list) => list.users)
    return mergeByHandle([this.localUsers(), ...remote])
  }

  get localSize(): number {
    return this.local.size
  }

  get remoteSize(): number {
    return this.remote.size
  }
}
