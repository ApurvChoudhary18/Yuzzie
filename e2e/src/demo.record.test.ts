/**
 * Records docs/demo.svg, the README's animated demo (SPEC.md §18 Session 17):
 * the real TUI in a real pseudo-terminal, against a real server, while a
 * teammate works through the SDK. Skipped unless YUZIE_RECORD_DEMO=1:
 *
 *   YUZIE_RECORD_DEMO=1 pnpm --filter @yuzie/e2e exec vitest run src/demo.record.test.ts
 */
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@yuzie/sdk'
import { afterAll, describe, it } from 'vitest'
import { machine } from './__support__/cli.js'
import { animatedSvg, capture, type Frame } from './__support__/svg.js'
import { startTui, type Tui } from './__support__/tty.js'
import { signIn, startWorld, type World } from './__support__/world.js'

const OUT = new URL('../../docs/demo.svg', import.meta.url)
let world: World | undefined
let tui: Tui | undefined

afterAll(async () => {
  tui?.kill()
  await world?.close()
})

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(process.env.YUZIE_RECORD_DEMO !== '1')('the README demo', () => {
  it('records docs/demo.svg', async () => {
    world = await startWorld({ devicePollIntervalSeconds: 1 })
    const { baseUrl } = world
    const rahul = await signIn(baseUrl, 'rahul')
    const adarsh = await signIn(baseUrl, 'adarsh')
    const priya = await signIn(baseUrl, 'priya')

    const owner = createClient({ baseUrl, token: rahul.token })
    await owner.boards.create({
      name: 'payments-api',
      repoRemote: 'github.com/acme/payments-api',
      baseBranch: 'main',
    })
    const board = await owner.connect('payments-api', { realtime: false })
    await board.members.invite({ handle: 'adarsh', role: 'member' })
    await board.members.invite({ handle: 'priya', role: 'member' })
    const add = (title: string, column: string, extra: Record<string, unknown> = {}) =>
      board.cards.create({ title, column, ...extra })
    await add('Rate limits on /v1/cards', 'todo', { priority: 1, labels: ['api'] })
    const webhooks = await add('Retry webhooks with backoff', 'todo', { labels: ['api'] })
    await add('Dark mode for the dashboard', 'todo', { priority: 3 })
    const oauth = await add('Fix GitHub OAuth callback', 'doing', {
      priority: 0,
      labels: ['auth'],
      assignees: ['rahul'],
      description:
        'The callback drops the `state` parameter when the user signs in from a second tab, so the login loops.',
    })
    await board.cards.addChecklistItem(oauth.number, 'Reproduce with two tabs')
    await board.cards.addChecklistItem(oauth.number, 'Keep state per attempt')
    await board.cards.addChecklistItem(oauth.number, 'Regression test')
    await board.cards.check(oauth.number, 1, true)
    await board.cards.updateGit(oauth.number, {
      branch: `task/${oauth.number}-fix-github-oauth-callback`,
      baseBranch: 'main',
      commits: 3,
      filesChanged: 5,
      additions: 120,
      deletions: 14,
      pushed: true,
      lastActivityAt: new Date().toISOString(),
    })
    await board.cards.setAnchor(oauth.number, { path: 'src/auth/callback.ts', line: 42 })
    await add('Paginate the activity feed', 'doing', { assignees: ['adarsh'] })
    await add('Cache board snapshots', 'review', { assignees: ['priya'], labels: ['perf'] })
    await add('Ship the CLI', 'done', { assignees: ['rahul'] })
    await board.close()

    // A teammate, live on the same board.
    const teammate = await createClient({ baseUrl, token: adarsh.token }).connect('payments-api')
    const reviewer = await createClient({ baseUrl, token: priya.token }).connect('payments-api')
    teammate.setPresence({ state: 'viewing' })
    reviewer.setPresence({ state: 'viewing' })

    const computer = machine(baseUrl)
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-demo-')))
    const { NO_COLOR: _plain, ...colourful } = computer.env
    const env = { ...colourful, YUZIE_TOKEN: rahul.token, YUZIE_BOARD: 'payments-api' }
    tui = startTui({ cwd, env: { ...env, COLORTERM: 'truecolor' }, cols: 110, rows: 26 })
    const frames: Frame[] = []
    const shot = async (ms: number, wait?: string | RegExp) => {
      if (wait !== undefined) await tui?.waitFor(wait)
      await settle()
      frames.push(capture((tui as Tui).terminal, ms))
    }

    await shot(2200, 'Fix GitHub OAuth')
    await tui.press('l')
    await shot(900)
    // @adarsh picks up the webhooks card, on his machine: it moves here, live.
    await teammate.cards.assign(webhooks.number, ['adarsh'])
    await teammate.cards.move(webhooks.number, 'doing')
    teammate.setPresence({ state: 'working', cardNo: webhooks.number })
    await shot(2600, /DOING \(3/)
    await tui.press('\r')
    await shot(3600, 'Keep state per attempt')
    await tui.press('\u001b')
    await shot(600, 'DOING')
    await tui.press('m')
    await shot(1200, /Review/)
    await tui.press('j')
    await shot(700)
    await tui.press('\r')
    await shot(2400, /REVIEW \(2/)
    // @priya comments from her terminal.
    await reviewer.cards.comment(oauth.number, 'Looking now — nice catch on the second tab.')
    await tui.press('?')
    await shot(2600, 'Keys')
    await tui.press('x')
    await shot(1200)

    writeFileSync(OUT, animatedSvg(frames, 'yuzie — payments-api'))
    // YUZIE_DEMO_FRAMES=<dir> also writes each frame on its own, to look at.
    const each = process.env.YUZIE_DEMO_FRAMES
    if (each !== undefined)
      for (const [index, frame] of frames.entries())
        writeFileSync(join(each, `frame-${index}.svg`), animatedSvg([frame], `frame ${index}`))
    await teammate.close()
    await reviewer.close()
  }, 120_000)
})
