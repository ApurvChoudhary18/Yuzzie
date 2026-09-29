/**
 * The board as an MCP server for AI coding agents (SPEC.md §13.4, §18 Session 15).
 *
 * Built on `@yuzie/sdk`: every call is an ordinary API request made with the
 * agent's own token, so the server — not this process — decides what the agent
 * may do, and every action is attributed to the agent in the event log. On top
 * of that, two guardrails an operator turns on deliberately:
 *
 * - `--allow-destructive` for deleting cards (the token must allow it too);
 * - `--allow-git` for claiming, which creates and checks out a branch.
 *
 * Refusals come back as tool errors an agent can read and act on, never as a
 * crash. Each call is written to the audit log.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { type BoardError, branchFor, type Card, isBoardError } from '@yuzie/core'
import { BranchError, dirtyFiles, findRepo, head, switchToBranch } from '@yuzie/git'
import { type Board, matchColumn } from '@yuzie/sdk'
import { z } from 'zod'

export const SERVER_NAME = 'yuzie'

/** The tools of §13.4, plus the one destructive tool the guardrail exists for. */
export const TOOL_NAMES = [
  'board_list_cards',
  'board_get_card',
  'board_create_card',
  'board_move_card',
  'board_comment',
  'board_claim_card',
  'board_update_checklist',
  'board_delete_card',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

/** One line of the audit log: what the agent asked for and what came of it. */
export interface AuditEntry {
  readonly at: string
  readonly agent: string | null
  readonly board: string
  readonly tool: ToolName
  readonly cardNo: number | null
  readonly outcome: 'ok' | 'refused' | 'error'
  readonly message?: string
}

export interface GitSettings {
  /** Where the agent's checkout is. */
  readonly cwd: string
  readonly baseBranch: string
  readonly branchTemplate: string
  /** The column a claim moves to (`flow.startColumn`), else the first in-progress one. */
  readonly startColumn?: string
}

export interface YuzieMcpOptions {
  readonly board: Board
  readonly slug: string
  readonly allowDestructive?: boolean
  readonly allowGit?: boolean
  readonly git?: GitSettings
  readonly version?: string
  /** Where each call is recorded. Defaults to nothing; `serveStdio` sends it to stderr. */
  readonly audit?: (entry: AuditEntry) => void
  readonly now?: () => Date
}

/** A refusal: the agent asked for something this server was not started to allow. */
class Refusal extends Error {}

const CardRef = z
  .union([z.number().int().positive(), z.string().regex(/^#?\d+$/)])
  .describe('The card number, e.g. 27 or "#27"')

function cardNumber(reference: number | string): number {
  return typeof reference === 'number' ? reference : Number(reference.replace(/^#/, ''))
}

function json(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value } as Record<string, unknown>,
  }
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

function explain(error: BoardError): string {
  const fix = error.suggestedFix
  return `${error.code}: ${error.message}${fix.length > 0 ? `\nFix: ${fix}` : ''}`
}

export function createYuzieMcpServer(options: YuzieMcpOptions): McpServer {
  const { board, slug } = options
  const now = options.now ?? (() => new Date())
  const server = new McpServer(
    { name: SERVER_NAME, version: options.version ?? '0.0.0' },
    {
      instructions: [
        `You are working on the Yuzie board "${slug}" as @${board.handle ?? 'an agent'}.`,
        'Narrate progress with board_comment as you go, tick checklist items as you finish them,',
        'move the card to review (not done) when your part is finished, and never delete anything',
        'silently. Humans see every action, marked (agent).',
      ].join(' '),
    },
  )

  // What this agent is doing, for presence (§8.5): working beats viewing.
  let working: { cardNo: number; branch?: string } | null = null
  const viewing = (cardNo: number) => {
    if (working === null) board.setPresence({ state: 'viewing', cardNo })
  }
  const work = (cardNo: number, branch?: string) => {
    working = { cardNo, ...(branch === undefined ? {} : { branch }) }
    board.setPresence({ state: 'working', ...working })
  }

  /** Register a tool whose every call is audited and whose failures are readable. */
  function tool<Shape extends z.ZodRawShape>(
    name: ToolName,
    config: { title: string; description: string; destructive?: boolean; readOnly?: boolean },
    shape: Shape,
    run: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
  ): void {
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: shape,
        annotations: {
          title: config.title,
          readOnlyHint: config.readOnly === true,
          destructiveHint: config.destructive === true,
          idempotentHint: config.readOnly === true,
          openWorldHint: false,
        },
      },
      (async (args: z.infer<z.ZodObject<Shape>>) => {
        const card = (args as { card?: number | string }).card
        const cardNo = card === undefined ? null : cardNumber(card)
        const record = (outcome: AuditEntry['outcome'], message?: string) =>
          options.audit?.({
            at: now().toISOString(),
            agent: board.handle,
            board: slug,
            tool: name,
            cardNo,
            outcome,
            ...(message === undefined ? {} : { message }),
          })
        try {
          const result = await run(args)
          record('ok')
          return json(result)
        } catch (error) {
          if (error instanceof Refusal) {
            record('refused', error.message)
            return failure(error.message)
          }
          if (isBoardError(error)) {
            record(error.code === 'forbidden' ? 'refused' : 'error', error.message)
            return failure(explain(error))
          }
          const message = error instanceof Error ? error.message : String(error)
          record('error', message)
          return failure(`internal: ${message}`)
        }
      }) as never,
    )
  }

  tool(
    'board_list_cards',
    {
      title: 'List cards',
      description:
        'Cards on the board, filtered. Search matches every word in titles, descriptions, comments, labels and assignees.',
      readOnly: true,
    },
    {
      column: z.string().optional().describe('A column key or name, e.g. "doing"'),
      assignee: z.string().optional().describe('A handle, e.g. "@priya"'),
      label: z.string().optional(),
      search: z.string().optional(),
      mine: z.boolean().optional().describe('Only cards assigned to you'),
      watching: z.boolean().optional(),
      stale: z.string().optional().describe('A duration such as "2d": no progress for that long'),
      limit: z.number().int().positive().max(500).optional(),
    },
    async (filter) => {
      const cards = await board.cards.list(
        Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined)),
      )
      return cards.map((card) => ({
        number: card.number,
        title: card.title,
        column: card.column,
        assignees: card.assignees,
        labels: card.labels,
        priority: card.priority,
        branch: card.git?.branch ?? null,
      }))
    },
  )

  tool(
    'board_get_card',
    {
      title: 'Get a card',
      description:
        'Everything about one card: description, checklist, comments, commits, git state and code anchor.',
      readOnly: true,
    },
    { card: CardRef },
    async ({ card }) => {
      const number = cardNumber(card)
      const found = await board.cards.get(number)
      viewing(number)
      return found
    },
  )

  tool(
    'board_create_card',
    { title: 'Create a card', description: 'Add a card to the board.' },
    {
      title: z.string().min(1),
      description: z.string().optional(),
      column: z.string().optional().describe('Defaults to the first column'),
      labels: z.array(z.string().min(1)).optional(),
      assignees: z.array(z.string().min(1)).optional(),
      priority: z.number().int().min(0).max(3).optional(),
    },
    async (input) =>
      board.cards.create({
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.column === undefined ? {} : { column: input.column }),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
        ...(input.assignees === undefined
          ? {}
          : { assignees: input.assignees.map((handle) => handle.replace(/^@/, '')) }),
        ...(input.priority === undefined ? {} : { priority: input.priority as 0 | 1 | 2 | 3 }),
      }),
  )

  tool(
    'board_move_card',
    { title: 'Move a card', description: 'Move a card to another column, e.g. "review".' },
    { card: CardRef, column: z.string().min(1) },
    async ({ card, column }) => board.cards.move(cardNumber(card), column),
  )

  tool(
    'board_comment',
    {
      title: 'Comment on a card',
      description:
        'Post a comment. Narrate progress this way — what you are about to do, what you did, what is left.',
    },
    { card: CardRef, body: z.string().min(1) },
    async ({ card, body }) => board.cards.comment(cardNumber(card), body),
  )

  tool(
    'board_update_checklist',
    {
      title: 'Update a checklist',
      description: 'Tick (or untick) a checklist item by its position, or add an item with `add`.',
    },
    {
      card: CardRef,
      item: z.number().int().positive().optional().describe('The item’s position, from 1'),
      done: z.boolean().optional().describe('Defaults to true'),
      add: z.string().min(1).optional().describe('Text of a new item'),
    },
    async ({ card, item, done, add }) => {
      const number = cardNumber(card)
      if (add !== undefined) return board.cards.addChecklistItem(number, add)
      if (item === undefined) throw new Refusal('Give `item` (a position) to tick, or `add`.')
      return board.cards.check(number, item, done ?? true)
    },
  )

  tool(
    'board_claim_card',
    {
      title: 'Claim a card',
      description:
        'Assign the card to yourself, move it into progress, and create and check out its branch. Needs the server started with --allow-git.',
    },
    { card: CardRef },
    async ({ card }) => {
      if (options.allowGit !== true || options.git === undefined)
        throw new Refusal(
          'Refused: claiming creates and checks out a Git branch, and this MCP server was started without --allow-git. Ask the operator to restart it with --allow-git, or use board_move_card and board_comment instead.',
        )
      return claim(board, cardNumber(card), options.git, work)
    },
  )

  tool(
    'board_delete_card',
    {
      title: 'Delete a card',
      description:
        'Delete a card. Destructive: refused unless the server was started with --allow-destructive and the token allows it.',
      destructive: true,
    },
    { card: CardRef },
    async ({ card }) => {
      if (options.allowDestructive !== true)
        throw new Refusal(
          'Refused: deleting is destructive, and this MCP server was started without --allow-destructive. Nothing was deleted. Move the card to Done or comment instead, or ask the operator.',
        )
      const number = cardNumber(card)
      await board.cards.delete(number)
      return { deleted: number }
    },
  )

  return server
}

/** `yuzie claim`, for an agent: never prompts, never stashes (§9.3). */
async function claim(
  board: Board,
  number: number,
  git: GitSettings,
  work: (cardNo: number, branch?: string) => void,
): Promise<{ card: Card; branch: string | null }> {
  const me = board.handle
  if (me === null) throw new Refusal('Cannot tell who you are: the server has not answered yet.')
  const card = await board.cards.get(number)

  let branch: string | null = null
  const repo = await findRepo(git.cwd)
  if (repo !== null) {
    const where = await head(repo.root)
    if (where.kind === 'detached')
      throw new Refusal('HEAD is detached. Check out a branch first, then claim again.')
    const name = card.git?.branch ?? branchFor(card, git.branchTemplate, { user: me })
    if (where.name !== name) {
      const dirty = await dirtyFiles(repo.root)
      if (dirty.length > 0)
        throw new Refusal(
          `Refused: the working tree has uncommitted changes (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''}). Commit them first; an agent never stashes someone's work.`,
        )
    }
    try {
      await switchToBranch(repo.root, name, git.baseBranch, { current: where.name })
    } catch (error) {
      if (error instanceof BranchError) throw new Refusal(error.message)
      throw error
    }
    branch = name
  }

  if (!card.assignees.includes(me)) await board.cards.assign(number, { add: [me] })
  const columns = board.state.columns
  const target =
    (git.startColumn === undefined ? undefined : matchColumn(columns, git.startColumn)) ??
    columns.find((column) => column.semantics === 'in_progress')
  if (target !== undefined && card.column !== target.key) await board.cards.move(number, target.key)
  if (branch !== null && card.git?.branch !== branch)
    await board.cards.linkBranch(number, branch, git.baseBranch)

  work(number, branch ?? undefined)
  return { card: board.state.cards[number] ?? card, branch }
}
