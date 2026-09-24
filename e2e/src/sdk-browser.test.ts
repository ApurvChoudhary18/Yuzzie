/**
 * SPEC.md §18 Session 5 acceptance: "The SDK compiles and runs in Node and in a
 * browser-like environment (jsdom smoke test) with no Node-only imports in the
 * core path."
 *
 * The SDK is bundled for `platform: 'browser'` — which fails outright on any
 * Node built-in — and the bundle is loaded as a <script> in a jsdom window, so
 * it runs in the window's own JavaScript context. There, `process` and `require` genuinely do not exist,
 * and `WebSocket` is the window's. It then talks to a real server.
 */
import { readFileSync } from 'node:fs'
import type * as SdkModule from '@yuzie/sdk'
import { JSDOM } from 'jsdom'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBoard, eventually, signIn, startWorld, type World } from './__support__/world.js'

type Sdk = typeof SdkModule

let world: World
let dom: JSDOM
let sdk: Sdk

beforeAll(async () => {
  world = await startWorld()
  const bundle = process.env.SDK_BROWSER_BUNDLE
  if (bundle === undefined) throw new Error('SDK_BROWSER_BUNDLE is not set; see global-setup.ts')

  dom = new JSDOM('<!doctype html><title>yuzie</title>', {
    url: 'http://localhost/',
    runScripts: 'dangerously',
  })
  const window = dom.window as unknown as { fetch: typeof fetch; YuzieSDK: Sdk }
  // Every browser has fetch; jsdom does not implement it, so it is supplied.
  window.fetch = fetch
  // Loaded the way a page loads it: a <script> element, run in the window's context.
  const script = dom.window.document.createElement('script')
  script.textContent = readFileSync(bundle, 'utf8')
  dom.window.document.head.appendChild(script)
  sdk = window.YuzieSDK
})

afterAll(async () => {
  dom.window.close()
  await world.close()
})

describe('the SDK in a browser-like environment', () => {
  it('runs where Node does not exist', () => {
    expect(dom.window.eval('typeof process')).toBe('undefined')
    expect(dom.window.eval('typeof require')).toBe('undefined')
    expect(dom.window.eval('typeof WebSocket')).toBe('function')
    expect(typeof sdk.Yuzie.connect).toBe('function')
  })

  it('connects, writes, and receives another client’s write live', async () => {
    const alice = await signIn(world.baseUrl)
    const bob = await signIn(world.baseUrl)
    const slug = await createBoard(world.baseUrl, alice, [bob])

    const board = await sdk.Yuzie.connect(slug, { baseUrl: world.baseUrl, token: alice.token })
    try {
      expect(board.status).toBe('live')
      const created = await board.cards.create({ title: 'From the browser' })
      expect(board.state.cards[created.number]?.title).toBe('From the browser')

      const other = await sdk.Yuzie.connect(slug, {
        baseUrl: world.baseUrl,
        token: bob.token,
        realtime: false,
      })
      await other.cards.move(created.number, 'done')
      await other.close()

      await eventually(
        () => board.state.cards[created.number]?.column === 'done',
        'the move to arrive over the browser WebSocket',
      )
    } finally {
      await board.close()
    }
  })
})
