/**
 * Keys all the way to the server and back (§18 Session 9 acceptance): a real
 * SDK board on a fake API, the real app in a sized terminal, and the effects
 * that join them.
 *
 * - A write that 409s paints at once, then visibly reverts with a conflict marker.
 * - `e` suspends the app for `$EDITOR` and restores the terminal completely,
 *   whether the editor saves or exits non-zero.
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Card } from '@yuzie/core'
import type { Board } from '@yuzie/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeApi, openBoard, problem, reply } from './__tests__/fake-api.js'
import { card, column, mountSource, tick } from './__tests__/fixtures.js'
import { type EffectContext, ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN, perform } from './effects.js'
import { SdkSource } from './source.js'
import { textWidth } from './text.js'

const COLUMNS = [
  column('todo', 'Todo', 0, 'backlog'),
  column('doing', 'Doing', 1, 'in_progress'),
  column('done', 'Done', 2, 'terminal'),
]

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function waitFor(check: () => boolean, what: string, ms = 8_000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function start(cards: Card[], env: Record<string, string | undefined> = {}) {
  const api = new FakeApi(COLUMNS, cards)
  const board: Board = await openBoard(api)
  const source = new SdkSource(board, 'b')
  source.synced = true
  let suspend: EffectContext['suspend'] = async (run) => run()
  const written: string[] = []
  const context: EffectContext = {
    board,
    source,
    // Never a real editor: a test that presses `e` by mistake fails instead of hanging.
    env: { ...process.env, EDITOR: 'false', VISUAL: '', ...env },
    stdout: { write: (text: string) => written.push(text) },
    doneColumn: async () => 'done',
    suspend: (run) => suspend(run),
    quit: () => {},
    presence: { view: () => {} },
  }
  const app = mountSource(source, 100, 30, {
    onEffect: (effect) => perform(effect, context),
    onSuspend: (inkSuspend) => {
      suspend = inkSuspend
    },
  })
  cleanup.push(
    () => app.instance.unmount(),
    () => source.dispose(),
    () => board.close(),
  )
  await tick()
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      app.keyboard.write(key)
      await tick()
    }
  }
  const frame = () => app.terminal.lastFrame()
  /** The column a card is drawn in, read off the screen. */
  const columnOf = (title: string) => {
    for (const line of frame().split('\n')) {
      const at = line.indexOf(title)
      if (at === -1) continue
      // Board columns are ~31 wide at 100 columns: todo, doing, done.
      return ['todo', 'doing', 'done'][Math.min(2, Math.floor((at - 3) / 32))]
    }
    return undefined
  }
  return { api, board, source, app, press, frame, columnOf, written }
}

function checkShape(frame: string) {
  const lines = frame.split('\n')
  expect(lines).toHaveLength(30)
  for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(100)
  expect(lines[0]).toMatch(/┐$/)
  expect(lines.at(-1)).toMatch(/^└─+┘$/)
}

describe('optimistic writes and rollback', () => {
  it('a move that 409s paints at once, marks pending, then reverts with a conflict marker', async () => {
    const original = card(1, { title: 'Fix login redirect', version: 1 })
    const t = await start([original])
    let answer: (response: ReturnType<typeof reply>) => void = () => {}
    t.api.on(
      'POST',
      /^\/boards\/b\/cards\/1\/move$/,
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    expect(t.columnOf('Fix login redirect')).toBe('todo')

    // m, pick Doing, enter: the card moves before the server has said anything.
    await t.press('m', 'j', '\r')
    await waitFor(() => t.api.writes().includes('POST /boards/b/cards/1/move'), 'the move')
    expect(t.columnOf('Fix login redirect')).toBe('doing')
    expect(t.frame()).toContain('#1◌ Fix login redirect')

    // Someone else changed it first: the server refuses, with its current card.
    answer(
      reply(
        409,
        problem('version_conflict', 409, {
          number: 1,
          current: { ...original, title: 'Fix login redirect', version: 2 },
        }),
      ),
    )
    await waitFor(() => t.columnOf('Fix login redirect') === 'todo', 'the rollback')
    await tick()
    const after = t.frame()
    checkShape(after)
    expect(after).toContain('#1⟳ Fix login redirect')
    expect(after).toContain('⟳ #1 changed on the server; your edit was undone')
    expect(after).not.toContain('◌')
  })

  it('the open card shows the pending and conflict markers in its header', async () => {
    const original = card(1, { title: 'Fix login redirect', version: 1 })
    const t = await start([original])
    let answer: (response: ReturnType<typeof reply>) => void = () => {}
    t.api.on(
      'POST',
      /^\/boards\/b\/cards\/1\/assign$/,
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    await t.press('\r', 'a', '\r')
    await waitFor(() => t.frame().includes('saving…'), 'the pending marker')
    expect(t.frame()).toContain('ASSIGNEE  @rahul')
    answer(
      reply(
        409,
        problem('version_conflict', 409, { number: 1, current: { ...original, version: 2 } }),
      ),
    )
    await waitFor(
      () => t.frame().includes('changed on the server; your edit was undone'),
      'the conflict',
    )
    expect(t.frame()).toContain('ASSIGNEE  —')
  })

  it('keys reach the server: create, comment, check, add item, delete', async () => {
    const withList = card(1, {
      title: 'Fix login redirect',
      checklist: [
        {
          id: '99999999-9999-4999-8999-000000000001',
          position: 1,
          text: 'Repro',
          doneAt: null,
          doneBy: null,
        },
      ],
    })
    const t = await start([withList])
    t.api.on('POST', /^\/boards\/b\/cards$/, (init) =>
      reply(201, card(2, { title: JSON.parse(String(init.body)).title, version: 1 })),
    )
    t.api.on('POST', /^\/boards\/b\/cards\/1\/comments$/, () =>
      reply(201, {
        id: '77777777-7777-4777-8777-000000000001',
        cardNumber: 1,
        author: 'rahul',
        body: 'on it',
        createdAt: '2026-08-19T10:00:00.000Z',
        editedAt: null,
      }),
    )
    t.api.on('PATCH', /^\/boards\/b\/cards\/1\/checklist\/[0-9a-f-]+$/, () => reply(200, withList))
    t.api.on('POST', /^\/boards\/b\/cards\/1\/checklist$/, () => reply(200, withList))
    t.api.on('DELETE', /^\/boards\/b\/cards\/1$/, () => reply(200, { deleted: true, number: 1 }))

    await t.press('n', 'S', 'h', 'i', 'p', '\r')
    await waitFor(() => t.api.writes().includes('POST /boards/b/cards'), 'create')
    expect(
      t.api.calls.find((c) => c.path === '/boards/b/cards' && c.method === 'POST')?.body,
    ).toMatchObject({
      title: 'Ship',
      column: 'todo',
    })

    await t.press('\r', 'C', 'o', 'n', ' ', 'i', 't', '\u0004')
    await waitFor(() => t.api.writes().includes('POST /boards/b/cards/1/comments'), 'comment')

    await t.press('x', 'x', '\u001b')
    // Ink holds a lone Esc briefly in case an escape sequence follows.
    await new Promise((resolve) => setTimeout(resolve, 100))
    await waitFor(
      () => t.api.writes().some((w) => w.startsWith('PATCH /boards/b/cards/1/checklist/')),
      'check',
    )

    await t.press('+', 'M', 'o', 'r', 'e', '\r')
    await waitFor(() => t.api.writes().includes('POST /boards/b/cards/1/checklist'), 'add item')

    await t.press('D', 'y')
    await waitFor(() => t.api.writes().includes('DELETE /boards/b/cards/1'), 'delete')
    await waitFor(() => !t.frame().includes('Fix login redirect'), 'the card to go')
    expect(t.frame()).toContain('? help')
  })
})

describe('$EDITOR suspend and resume', () => {
  function fakeEditor(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'yuzie-editor-'))
    const path = join(dir, 'editor.sh')
    writeFileSync(path, `#!/bin/sh\n${script}\n`)
    chmodSync(path, 0o755)
    return path
  }

  function restoredAfterSuspend(t: Awaited<ReturnType<typeof start>>) {
    // Out of the alternate screen for the editor, and back into it after.
    const leave = t.written.indexOf(LEAVE_ALT_SCREEN)
    const enter = t.written.lastIndexOf(ENTER_ALT_SCREEN)
    expect(leave).toBeGreaterThanOrEqual(0)
    expect(enter).toBeGreaterThan(leave)
    // Raw mode handed to the editor, then taken back.
    const modes = t.app.keyboard.rawModes
    expect(modes.lastIndexOf(false)).toBeGreaterThan(-1)
    expect(modes.at(-1)).toBe(true)
    // And a complete frame drawn again, with the keys working.
    checkShape(t.frame())
  }

  it('edits the card, then hands the terminal back exactly as it was', async () => {
    const editor = fakeEditor(`sed -i.bak 's/^title: .*/title: Renamed in the editor/' "$1"`)
    const original = card(1, { title: 'Fix login redirect', version: 1 })
    const t = await start([original], { EDITOR: editor, VISUAL: '' })
    t.api.on('PATCH', /^\/boards\/b\/cards\/1$/, () =>
      reply(200, { ...original, title: 'Renamed in the editor', version: 2 }),
    )

    await t.press('e')
    await waitFor(() => t.api.writes().includes('PATCH /boards/b/cards/1'), 'the update')
    expect(t.api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      title: 'Renamed in the editor',
    })
    await waitFor(() => t.frame().includes('Renamed in the editor'), 'the new title')
    restoredAfterSuspend(t)
    expect(t.frame()).toContain('Updated #1 (title)')

    await t.press('\r')
    expect(t.frame()).toContain('#1 Renamed in the editor')
  })

  it('an editor that exits non-zero changes nothing and still restores the terminal', async () => {
    const editor = fakeEditor('exit 3')
    const t = await start([card(1, { title: 'Fix login redirect' })], {
      EDITOR: editor,
      VISUAL: '',
    })

    await t.press('e')
    await waitFor(() => t.frame().includes('exited with 3'), 'the failure toast')
    expect(t.api.writes()).toEqual([])
    restoredAfterSuspend(t)
    expect(t.frame()).toContain('Fix login redirect')

    // Still responsive afterwards.
    await t.press('\r')
    expect(t.frame()).toContain('esc back')
  })
})
