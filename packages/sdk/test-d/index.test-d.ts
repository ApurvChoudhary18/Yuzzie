/**
 * Type tests for the public surface (SPEC.md §18 Session 5: "tsd type tests
 * pass"). These run against the built declarations, so they check what a
 * consumer actually sees.
 */
import type {
  BoardState,
  Card,
  CardMovedEvent,
  Comment,
  EventEnvelope,
  Presence,
} from '@yuzie/core'
import type { YuzieCache } from '@yuzie/store'
import { expectAssignable, expectError, expectType } from 'tsd'
import {
  type Board,
  type CacheLike,
  type ConflictError,
  type ConflictEvent,
  type ConnectionStatus,
  OfflineError,
  type SyncReport,
  Yuzie,
} from '../dist/index.js'
import { Yuzie as NodeYuzie, type ResolvedCredential, resolveToken } from '../dist/node.js'

declare const board: Board

// §13.1, line by line.
expectType<Promise<Board>>(
  Yuzie.connect('payments-api', {
    token: 'yz_x',
    baseUrl: 'https://api.yuzie.dev/v1',
    offline: 'queue',
  }),
)
expectError(Yuzie.connect('payments-api', { offline: 'sometimes' }))

expectType<Promise<Card[]>>(board.cards.list({ column: 'doing', assignee: 'rahul' }))
expectType<Promise<Card>>(board.cards.get(18))
expectType<Promise<Card>>(
  board.cards.create({ title: 'Fix OAuth', assignee: 'rahul', column: 'todo', labels: ['bug'] }),
)
expectError(board.cards.create({ assignee: 'rahul' }))
expectType<Promise<Card>>(board.cards.move(18, 'review'))
expectType<Promise<Card>>(board.cards.assign(18, ['rahul']))
expectType<Promise<Comment>>(board.cards.comment(18, 'OAuth callback is broken'))
expectType<Promise<Card>>(board.cards.check(18, 3, true))
board.cards.linkBranch(18, 'task/18-fix-github-oauth')
board.cards.updateGit(18, { commits: 3, filesChanged: 7 })
expectError(board.cards.updateGit(18, { commits: 'three' }))

// `on` narrows the payload by event type.
board.on('card.moved', (event) => {
  expectType<CardMovedEvent>(event)
  expectType<string>(event.payload.from)
  expectType<string>(event.payload.to)
})
board.on('presence', (users) => expectType<readonly Presence[]>(users))
board.on('conflict', (conflict) => {
  expectType<ConflictEvent>(conflict)
  expectType<ConflictError>(conflict.error)
})
board.on('status', (status) => expectType<ConnectionStatus>(status))
board.on('*', (event) => expectType<EventEnvelope>(event))
expectError(board.on('card.teleported', () => {}))
expectType<() => void>(board.on('change', () => {}))

// State is readable synchronously.
expectType<BoardState>(board.state)
expectType<Promise<SyncReport>>(board.sync())
expectType<Promise<void>>(board.close())

// The store's cache plugs straight in, without the SDK depending on the store.
expectAssignable<CacheLike>({} as YuzieCache)

// Errors are the typed classes from @yuzie/core.
expectAssignable<Error>(new OfflineError('offline_network_required', 'x'))

// The Node entry finds the token itself, so `token` is optional there.
expectType<Promise<Board>>(NodeYuzie.connect('payments-api'))
expectType<Promise<ResolvedCredential | undefined>>(resolveToken('https://api.yuzie.dev/v1'))
declare const credential: ResolvedCredential
expectType<'env' | 'keychain' | 'file'>(credential.source)
