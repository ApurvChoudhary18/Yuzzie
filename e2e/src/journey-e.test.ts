/**
 * SPEC.md §6.5 Journey E, end to end (§18 Session 15): an agent as a
 * first-class board participant.
 *
 * Rahul issues @claude a token and assigns it #27. A scripted agent drives the
 * real `yuzie mcp` over stdio with the official MCP client: it claims the card
 * (a branch in its own checkout), narrates, ticks an item, and moves it to
 * review. Rahul's own client sees it working, marked (agent), and every step
 * in the activity log. Deleting without --allow-destructive is refused.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { parseOutput } from '@yuzie/core'
import { createClient } from '@yuzie/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CLI, type Machine, machine, repository, yuzie } from './__support__/cli.js'
import {
  createBoard,
  eventually,
  signIn,
  startWorld,
  type User,
  unique,
  type World,
} from './__support__/world.js'

let world: World
let rahul: User
let slug: string
let human: Machine
let agentMachine: Machine
let humanRepo: string
let agentRepo: string
let claude: string
let agentToken = ''
let client: Client | null = null
let transport: StdioClientTransport | null = null
let audit = ''

beforeAll(async () => {
  world = await startWorld()
  rahul = await signIn(world.baseUrl, unique('rahul'))
  slug = await createBoard(world.baseUrl, rahul)
  const board = await createClient({ baseUrl: world.baseUrl, token: rahul.token }).connect(slug, {
    realtime: false,
  })
  for (let number = 1; number <= 27; number += 1)
    await board.cards.create({ title: number === 27 ? 'Rate limit the webhook' : `Card ${number}` })
  for (const text of ['Read the handler', 'Add a token bucket', 'Tests'])
    await board.cards.addChecklistItem(27, text)
  await board.close()

  human = machine(world.baseUrl)
  agentMachine = machine(world.baseUrl)
  humanRepo = repository()
  agentRepo = repository()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: agentRepo, stdio: 'ignore' })
  git('config', 'user.email', 'claude@agents.dev')
  git('config', 'user.name', 'Claude')
  writeFileSync(join(agentRepo, 'README.md'), '# payments-api\n')
  git('add', '.')
  git('commit', '-m', 'init')
  claude = unique('claude')
})

afterAll(async () => {
  await client?.close()
  await world?.close()
})

/** Rahul at his terminal. */
function asRahul(args: string[]) {
  return yuzie(args, {
    cwd: humanRepo,
    env: { ...human.env, YUZIE_TOKEN: rahul.token, YUZIE_BOARD: slug },
  })
}

async function json(args: string[]) {
  const result = await asRahul([...args, '--json'])
  expect(result.code, `${args.join(' ')}: ${result.stdout}${result.stderr}`).toBe(0)
  const document = JSON.parse(result.stdout)
  parseOutput(document)
  return document as { kind: string; data: Record<string, unknown>; meta: Record<string, unknown> }
}

async function tool(name: string, args: Record<string, unknown>) {
  const result = await (client as Client).callTool({ name, arguments: args })
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? ''
  return { error: result.isError === true, text }
}

describe('Journey E — an agent claims a card (§6.5)', () => {
  it('Rahul issues @claude a token: shown once, scoped, and listed by who it is for', async () => {
    const created = await json(['token', 'create', 'claude-agent', '--agent', claude])
    expect(created.kind).toBe('TokenCreated')
    agentToken = created.data.token as string
    expect(agentToken).toMatch(/^yz_/)
    expect(created.data.apiToken).toMatchObject({ agent: claude, boardSlug: slug, role: 'member' })

    const listed = await json(['token', 'list'])
    expect(JSON.stringify(listed)).not.toContain(agentToken)
    const human = await asRahul(['token', 'list'])
    expect(human.stdout).toContain(`@${claude} (agent)`)
  })

  it('Rahul assigns #27 to the agent, and it says so', async () => {
    const assigned = await asRahul(['assign', '27', `@${claude}`])
    expect(assigned.code, assigned.stderr).toBe(0)
    expect(assigned.stdout).toContain(`✓ #27 assigned to @${claude} (agent)`)
  })

  it('the agent connects over MCP and sees the tools', async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp', '--allow-git'],
      cwd: agentRepo,
      env: {
        ...(agentMachine.env as Record<string, string>),
        YUZIE_TOKEN: agentToken,
        YUZIE_BOARD: slug,
      },
      stderr: 'pipe',
    })
    transport.stderr?.on('data', (chunk: Buffer) => {
      audit += chunk.toString()
    })
    client = new Client({ name: 'scripted-agent', version: '1.0.0' })
    await client.connect(transport)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('board_claim_card')
    expect(client.getInstructions()).toContain(`@${claude}`)
  })

  it('claims, narrates, ticks an item and moves it on — all as the agent', async () => {
    const claimed = await tool('board_claim_card', { card: 27 })
    expect(claimed.error, claimed.text).toBe(false)
    expect(JSON.parse(claimed.text).branch).toBe('task/27-rate-limit-the-webhook')
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: agentRepo })
    expect(branch.toString().trim()).toBe('task/27-rate-limit-the-webhook')

    // Rahul, live: the agent is working on #27, and marked as an agent.
    const working = new RegExp(`● @${claude} +working on #27 .*\\(agent\\)`)
    await eventually(
      async () => working.test((await asRahul(['who'])).stdout),
      `@${claude} working on #27 (agent) in yuzie who`,
    )

    expect(
      (await tool('board_comment', { card: 27, body: 'Starting. Plan: 3 steps…' })).error,
    ).toBe(false)
    expect((await tool('board_update_checklist', { card: 27, item: 1 })).error).toBe(false)
    expect((await tool('board_move_card', { card: 27, column: 'review' })).error).toBe(false)

    const card = await json(['card', '27'])
    expect(card.data).toMatchObject({ column: 'review', assignees: [claude] })
    expect((card.data.checklist as Array<{ doneBy: string | null }>)[0]?.doneBy).toBe(claude)
    expect((card.data.git as { branch: string }).branch).toBe('task/27-rate-limit-the-webhook')

    // Every step is in the log, attributed to the agent and marked.
    const activity = await asRahul(['activity', '--card', '27'])
    expect(activity.stdout).toContain(`@${claude} (agent) commented on #27`)
    const events = await json(['activity', '--card', '27', '--author', claude])
    expect((events.data as unknown as Array<{ type: string }>).map((e) => e.type)).toEqual(
      expect.arrayContaining(['card.moved', 'comment.created', 'checklist.updated']),
    )
  })

  it('a destructive call without --allow-destructive is a clear refusal, not a crash', async () => {
    const refused = await tool('board_delete_card', { card: 27 })
    expect(refused.error).toBe(true)
    expect(refused.text).toMatch(/without --allow-destructive\. Nothing was deleted/)
    // Still there, and the server is still answering.
    expect((await json(['card', '27'])).data.number).toBe(27)
    expect((await tool('board_get_card', { card: 27 })).error).toBe(false)
  })

  it('every call went to the audit log, and stdout stayed pure protocol', async () => {
    const lines = audit
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { tool: string; outcome: string; agent: string })
    expect(lines.map((line) => line.tool)).toEqual([
      'board_claim_card',
      'board_comment',
      'board_update_checklist',
      'board_move_card',
      'board_delete_card',
      'board_get_card',
    ])
    expect(lines.every((line) => line.agent === claude)).toBe(true)
    expect(lines.find((line) => line.tool === 'board_delete_card')?.outcome).toBe('refused')
  })

  it('revoking the token ends the agent’s access', async () => {
    await client?.close()
    client = null
    const revoked = await asRahul(['token', 'revoke', 'claude-agent'])
    expect(revoked.code, revoked.stderr).toBe(0)
    const board = createClient({ baseUrl: world.baseUrl, token: agentToken })
    await expect(board.me()).rejects.toThrow(/revoked/)
  })
})
