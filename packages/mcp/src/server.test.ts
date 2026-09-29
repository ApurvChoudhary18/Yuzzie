/**
 * MCP protocol conformance (SPEC.md §18 Session 15): initialise, list the
 * tools, call every one, and the error paths — driven by the official MCP
 * client over an in-memory transport, against a scripted board.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { type Card, type Column, NotFoundError, PermissionError } from '@yuzie/core'
import type { Board } from '@yuzie/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { type AuditEntry, createYuzieMcpServer, TOOL_NAMES, type YuzieMcpOptions } from './index.js'

const COLUMNS: Column[] = ['todo', 'doing', 'review', 'done'].map((key, index) => ({
  id: `66666666-6666-4666-8666-00000000000${index}`,
  boardId: '11111111-1111-4111-8111-111111111111',
  key,
  name: key.charAt(0).toUpperCase() + key.slice(1),
  rank: String.fromCharCode(97 + index),
  semantics: key === 'doing' ? 'in_progress' : key === 'done' ? 'terminal' : null,
  wipLimit: null,
}))

function card(number: number, overrides: Partial<Card> = {}): Card {
  return {
    id: `33333333-3333-4333-8333-${String(number).padStart(12, '0')}`,
    boardId: '11111111-1111-4111-8111-111111111111',
    number,
    column: 'todo',
    rank: `a${number}`,
    title: `Card ${number}`,
    description: null,
    priority: null,
    dueAt: null,
    assignees: [],
    labels: [],
    watchers: [],
    checklist: [],
    comments: [],
    commits: [],
    git: null,
    anchor: null,
    createdBy: 'rahul',
    archivedAt: null,
    createdAt: '2026-08-19T09:00:00Z',
    updatedAt: '2026-08-19T09:00:00Z',
    version: 1,
    ...overrides,
  }
}

/** A board that does what the API would, and remembers what it was asked. */
class ScriptedBoard {
  handle: string | null = 'claude'
  readonly calls: string[] = []
  readonly presence: Array<Record<string, unknown>> = []
  readonly state = {
    columns: COLUMNS,
    cards: { 27: card(27, { title: 'Rate limits' }) } as Record<number, Card>,
  }

  setPresence(frame: Record<string, unknown>): boolean {
    this.presence.push(frame)
    return true
  }

  private find(number: number): Card {
    const found = this.state.cards[number]
    if (found === undefined)
      throw new NotFoundError('card_not_found', `Card #${number} does not exist`)
    return found
  }

  private save(next: Card): Card {
    this.state.cards[next.number] = next
    return next
  }

  readonly cards = {
    list: async (filter: Record<string, unknown>) => {
      this.calls.push(`list ${JSON.stringify(filter)}`)
      return Object.values(this.state.cards)
    },
    get: async (number: number) => this.find(number),
    create: async (input: { title: string }) => {
      this.calls.push(`create ${input.title}`)
      return this.save(card(28, { title: input.title }))
    },
    move: async (number: number, column: string) => {
      this.calls.push(`move ${number} ${column}`)
      return this.save({ ...this.find(number), column })
    },
    assign: async (number: number, change: { add: string[] }) => {
      this.calls.push(`assign ${number} ${change.add.join(',')}`)
      return this.save({ ...this.find(number), assignees: change.add })
    },
    comment: async (number: number, body: string) => {
      this.find(number)
      this.calls.push(`comment ${number} ${body}`)
      return {
        id: '55555555-5555-4555-8555-000000000001',
        cardNumber: number,
        author: this.handle,
        body,
        createdAt: '2026-08-19T09:00:00Z',
        editedAt: null,
      }
    },
    check: async (number: number, item: number, done: boolean) => {
      this.calls.push(`check ${number} ${item} ${done}`)
      return this.find(number)
    },
    addChecklistItem: async (number: number, text: string) => {
      this.calls.push(`add-item ${number} ${text}`)
      return this.find(number)
    },
    linkBranch: async (number: number, branch: string) => {
      this.calls.push(`link ${number} ${branch}`)
      return {}
    },
    delete: async (number: number) => {
      this.calls.push(`delete ${number}`)
      if (number === 99)
        throw new PermissionError('forbidden', 'This agent token cannot delete cards.')
      delete this.state.cards[number]
    },
  }
}

const open: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of open.splice(0)) await close()
})

async function connect(options: Partial<YuzieMcpOptions> = {}) {
  const board = new ScriptedBoard()
  const audit: AuditEntry[] = []
  const server = createYuzieMcpServer({
    board: board as unknown as Board,
    slug: 'payments-api',
    version: '1.2.3',
    audit: (entry) => audit.push(entry),
    now: () => new Date('2026-08-20T09:00:00Z'),
    ...options,
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'conformance', version: '1.0.0' })
  await server.connect(serverSide)
  await client.connect(clientSide)
  open.push(async () => {
    await client.close()
    await server.close()
  })
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    return { error: result.isError === true, text }
  }
  return { board, client, call, audit }
}

describe('initialise', () => {
  it('names itself and says how to behave on the board', async () => {
    const { client } = await connect()
    expect(client.getServerVersion()).toMatchObject({ name: 'yuzie', version: '1.2.3' })
    expect(client.getServerCapabilities()?.tools).toBeDefined()
    expect(client.getInstructions()).toMatch(/Narrate progress with board_comment/)
  })
})

describe('list tools', () => {
  it('offers the §13.4 tools and the guarded delete, each with a schema', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort())
    for (const tool of tools) {
      expect(tool.description?.length, tool.name).toBeGreaterThan(10)
      expect(tool.inputSchema.type).toBe('object')
    }
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
    expect(byName.board_delete_card?.annotations?.destructiveHint).toBe(true)
    expect(byName.board_list_cards?.annotations?.readOnlyHint).toBe(true)
    expect(byName.board_comment?.inputSchema.required).toEqual(['card', 'body'])
  })
})

describe('call each tool', () => {
  it('board_list_cards passes filters through and summarises cards', async () => {
    const { board, call } = await connect()
    const result = await call('board_list_cards', { column: 'todo', search: 'rate' })
    expect(result.error).toBe(false)
    expect(JSON.parse(result.text)).toEqual([expect.objectContaining({ number: 27 })])
    expect(board.calls).toEqual(['list {"column":"todo","search":"rate"}'])
  })

  it('board_get_card returns everything, and says the agent is viewing it', async () => {
    const { board, call } = await connect()
    const result = await call('board_get_card', { card: '#27' })
    expect(JSON.parse(result.text)).toMatchObject({ number: 27, title: 'Rate limits' })
    expect(board.presence).toEqual([{ state: 'viewing', cardNo: 27 }])
  })

  it('board_create_card, board_move_card, board_comment and board_update_checklist', async () => {
    const { board, call } = await connect()
    expect((await call('board_create_card', { title: 'New thing' })).error).toBe(false)
    expect((await call('board_move_card', { card: 27, column: 'review' })).error).toBe(false)
    expect((await call('board_comment', { card: 27, body: 'Starting. Plan: 3 steps' })).error).toBe(
      false,
    )
    expect((await call('board_update_checklist', { card: 27, item: 1 })).error).toBe(false)
    expect((await call('board_update_checklist', { card: 27, add: 'Tests' })).error).toBe(false)
    expect(board.calls).toEqual([
      'create New thing',
      'move 27 review',
      'comment 27 Starting. Plan: 3 steps',
      'check 27 1 true',
      'add-item 27 Tests',
    ])
  })

  it('board_claim_card with --allow-git assigns, moves, branches and works', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-mcp-repo-')))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    git('init', '-b', 'main')
    git('config', 'user.email', 'claude@agents.dev')
    git('config', 'user.name', 'Claude')
    writeFileSync(join(repo, 'README.md'), 'hi\n')
    git('add', '.')
    git('commit', '-m', 'init')

    const { board, call } = await connect({
      allowGit: true,
      git: { cwd: repo, baseBranch: 'main', branchTemplate: 'task/{id}-{slug}' },
    })
    const result = await call('board_claim_card', { card: 27 })
    expect(result.error, result.text).toBe(false)
    expect(JSON.parse(result.text)).toMatchObject({ branch: 'task/27-rate-limits' })
    expect(board.calls).toEqual([
      'assign 27 claude',
      'move 27 doing',
      'link 27 task/27-rate-limits',
    ])
    expect(board.presence.at(-1)).toEqual({
      state: 'working',
      cardNo: 27,
      branch: 'task/27-rate-limits',
    })
    const current = execFileSync('git', ['branch', '--show-current'], { cwd: repo }).toString()
    expect(current.trim()).toBe('task/27-rate-limits')
  })

  it('board_delete_card with --allow-destructive deletes', async () => {
    const { board, call } = await connect({ allowDestructive: true })
    expect(JSON.parse((await call('board_delete_card', { card: 27 })).text)).toEqual({
      deleted: 27,
    })
    expect(board.state.cards[27]).toBeUndefined()
  })
})

describe('error paths', () => {
  it('a destructive call without the flag is a clear refusal, and nothing is deleted', async () => {
    const { board, call, audit } = await connect()
    const result = await call('board_delete_card', { card: 27 })
    expect(result.error).toBe(true)
    expect(result.text).toMatch(/started without --allow-destructive\. Nothing was deleted/)
    expect(board.calls).toEqual([])
    expect(audit).toEqual([
      expect.objectContaining({ tool: 'board_delete_card', cardNo: 27, outcome: 'refused' }),
    ])
  })

  it('claiming without --allow-git is refused before anything happens', async () => {
    const { board, call } = await connect()
    const result = await call('board_claim_card', { card: 27 })
    expect(result.error).toBe(true)
    expect(result.text).toMatch(/without --allow-git/)
    expect(board.calls).toEqual([])
  })

  it('the server’s own refusal is passed on with its code', async () => {
    const { call, audit } = await connect({ allowDestructive: true })
    const result = await call('board_delete_card', { card: 99 })
    expect(result.error).toBe(true)
    expect(result.text).toMatch(/^forbidden: This agent token cannot delete cards\./)
    expect(audit.at(-1)).toMatchObject({ outcome: 'refused' })
  })

  it('a card that does not exist is an error result, not a crash', async () => {
    const { call, client } = await connect()
    const result = await call('board_comment', { card: 404, body: 'hello?' })
    expect(result.error).toBe(true)
    expect(result.text).toMatch(/^card_not_found: Card #404 does not exist/)
    // …and the server is still there.
    expect((await client.listTools()).tools.length).toBe(TOOL_NAMES.length)
  })

  it('arguments that do not fit the schema are rejected', async () => {
    const { call, board } = await connect()
    const missing = await call('board_move_card', { card: 27 })
    expect(missing.error).toBe(true)
    expect(missing.text).toMatch(/column/)
    const wrong = await call('board_get_card', { card: 'twenty-seven' })
    expect(wrong.error).toBe(true)
    expect(board.calls).toEqual([])
  })

  it('an unknown tool is an error', async () => {
    const { call } = await connect()
    const result = await call('board_archive_everything')
    expect(result.error).toBe(true)
    expect(result.text).toMatch(/not found/i)
  })

  it('every call is audited with the agent and the board', async () => {
    const { call, audit } = await connect()
    await call('board_get_card', { card: 27 })
    expect(audit).toEqual([
      {
        at: '2026-08-20T09:00:00.000Z',
        agent: 'claude',
        board: 'payments-api',
        tool: 'board_get_card',
        cardNo: 27,
        outcome: 'ok',
      },
    ])
  })
})
