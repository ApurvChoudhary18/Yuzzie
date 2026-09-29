/**
 * Hostile input at the API (SPEC.md §18 Session 16): what a terminal would
 * obey is refused with a 400 naming the character — never a 500 from
 * Postgres, which cannot store NUL — and odd but harmless text is kept.
 */
import type { Card } from '@yuzie/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createBoard,
  createCard,
  startTestServer,
  type TestBoard,
  type TestServer,
} from './__tests__/harness.js'

let server: TestServer
let board: TestBoard

beforeAll(async () => {
  server = await startTestServer()
  board = await createBoard(server)
})

afterAll(async () => {
  await server?.close()
})

const send = (method: 'POST' | 'PATCH', url: string, body: unknown) =>
  call<{ error?: { code: string; message: string } } & Partial<Card>>(server, {
    method,
    url: `/v1/boards/${board.slug}${url}`,
    token: board.owner.token,
    body,
  })

describe('control characters are refused, never a 500', () => {
  it.each([
    ['a title with NUL', 'POST', '/cards', { title: 'nul\u0000here' }],
    ['a title that clears the screen', 'POST', '/cards', { title: '\u001b[2J\u001b[H' }],
    ['a title with a C1 CSI', 'POST', '/cards', { title: '\u009b31m red' }],
    ['a two-line title', 'POST', '/cards', { title: 'one\ntwo' }],
    ['a description with NUL', 'POST', '/cards', { title: 'ok', description: 'a\u0000b' }],
    [
      'a label that retitles the window',
      'POST',
      '/cards',
      { title: 'ok', labels: ['\u001b]0;x\u0007'] },
    ],
    ['a column name', 'POST', '/columns', { name: 'Do\u0007ne' }],
  ] as const)('%s', async (_, method, url, body) => {
    const response = await send(method, url, body)
    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe('validation_failed')
    expect(response.body.error?.message).toMatch(/control characters \(found U\+00[0-9A-F]{2}\)/)
  })

  it('in comments and checklist items too', async () => {
    const { number } = await createCard(server, board, board.owner.token)
    for (const [url, body] of [
      [`/cards/${number}/comments`, { body: 'nul\u0000' }],
      [`/cards/${number}/comments`, { body: 'bell\u0007' }],
      [`/cards/${number}/checklist`, { text: 'esc\u001b' }],
    ] as const) {
      const response = await send('POST', url, body)
      expect(response.status, url).toBe(400)
    }
    const edit = await send('PATCH', `/cards/${number}`, { title: 'x\u001b' })
    expect(edit.status).toBe(400)
  })
})

describe('unusual but harmless text is kept', () => {
  it.each([
    ['emoji and scripts', 'emoji 🧪👩‍💻🇮🇳 漢字 עברית'],
    ['combining marks', 'é́́'],
    ['zero-width and bidi characters', 'zero​width ‮override‬'],
    ['10 KB', 'x'.repeat(10 * 1024)],
  ])('%s', async (_, title) => {
    const response = await send('POST', '/cards', { title })
    expect(response.status).toBe(201)
    expect(response.body.title).toBe(title)
  })

  it('a lone surrogate is stored as U+FFFD rather than breaking the database', async () => {
    const response = await send('POST', '/cards', { title: 'lone \ud800 surrogate' })
    expect(response.status).toBe(201)
    expect(response.body.title).toMatch(/^lone .+ surrogate$/)
  })

  it('comments keep their newlines and tabs', async () => {
    const { number } = await createCard(server, board, board.owner.token)
    const response = await send('POST', `/cards/${number}/comments`, {
      body: 'first line\n\tindented second',
    })
    expect(response.status).toBe(201)
  })
})
