/**
 * `yuzie token create | list | revoke` (SPEC.md §13.3, §18 Session 15).
 *
 * A token is for CI, a script, or an agent. It has a role that can only narrow
 * what its holder may do, and usually one board. `--agent <handle>` issues it
 * to an agent instead of to you: the agent joins the board and everything it
 * does is attributed to it, marked `(agent)`. The plaintext is printed once,
 * here, and stored nowhere.
 */
import { type ApiToken, type Role, RoleSchema } from '@yuzie/core'
import type { Context } from '../context.js'
import { parseDuration } from '../dates.js'
import { UsageError } from '../exit.js'
import { pad, shortDate } from '../render/text.js'
import { currentSlug } from '../session.js'

export interface TokenCreateOptions {
  readonly role?: string
  readonly allBoards?: boolean
  readonly agent?: string
  readonly allowDestructive?: boolean
  readonly expires?: string
}

function parseRole(input: string | undefined): Role {
  const parsed = RoleSchema.safeParse((input ?? 'member').toLowerCase())
  if (!parsed.success) throw new UsageError('--role must be owner, member or viewer.')
  return parsed.data
}

export async function tokenCreate(
  context: Context,
  name: string,
  options: TokenCreateOptions,
): Promise<void> {
  const role = parseRole(options.role)
  const agent = options.agent?.replace(/^@/, '')
  if (agent !== undefined && options.allBoards === true)
    throw new UsageError('An agent token belongs to one board; drop --all-boards.')
  if (agent !== undefined && role === 'owner')
    throw new UsageError('An agent can be a member or a viewer, never an owner (§14.2).')
  if (options.allowDestructive === true && agent === undefined)
    throw new UsageError('--allow-destructive is for agent tokens (with --agent).')
  const expiresAt =
    options.expires === undefined
      ? undefined
      : new Date(context.now().getTime() + parseDuration(options.expires)).toISOString()
  context.requireNetwork('Creating a token')

  // Scoped to this board (the repository's, or --board) unless told otherwise:
  // the narrowest token that does the job is the one to hand out.
  const boardSlug = options.allBoards === true ? undefined : await currentSlug(context)
  const client = await context.client()
  const created = await client.tokens.create({
    name,
    role,
    ...(boardSlug === undefined ? {} : { boardSlug }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(agent === undefined ? {} : { agent }),
    ...(options.allowDestructive === true ? { allowDestructive: true } : {}),
  })

  const { output } = context
  const who = agent === undefined ? 'you' : `@${agent} (agent)`
  output.success(
    `Created token "${name}" for ${who} · ${role} · ${boardSlug === undefined ? 'all your boards' : boardSlug}`,
  )
  if (!output.json) {
    output.line('')
    output.line(`  ${created.token}`)
    output.line('')
    output.warn('This is the only time it is shown. Copy it now; Yuzie keeps only a hash.')
    if (agent !== undefined) {
      output.line(
        output.paint(
          'dim',
          `  Give it to the agent as YUZIE_TOKEN, e.g.:\n  claude mcp add yuzie -e YUZIE_TOKEN=<token> -- yuzie mcp --board ${boardSlug}`,
        ),
      )
    }
  }
  output.result('TokenCreated', created)
}

function describeToken(token: ApiToken, now: number): string {
  const holder = token.agent === null ? 'you' : `@${token.agent} (agent)`
  const used =
    token.lastUsedAt === null ? 'never used' : `used ${shortDate(token.lastUsedAt, new Date(now))}`
  const expires =
    token.expiresAt === null ? '' : ` · expires ${shortDate(token.expiresAt, new Date(now))}`
  const destructive = token.allowDestructive ? ' · may delete' : ''
  return `${pad(token.name, 18)} ${pad(holder, 20)} ${pad(token.boardSlug ?? 'all boards', 18)} ${pad(token.role, 7)} ${used}${expires}${destructive}  ${token.id.slice(0, 8)}`
}

export async function tokenList(context: Context): Promise<void> {
  context.requireNetwork('Listing tokens')
  const client = await context.client()
  const tokens = await client.tokens.list()
  const now = context.now().getTime()
  for (const token of tokens) context.output.line(describeToken(token, now))
  if (tokens.length === 0)
    context.output.line('No tokens yet. Create one with `yuzie token create`.')
  context.output.result('ApiTokenList', tokens, { count: tokens.length })
}

/** `revoke <id | id prefix | name>`: one token, or a usage error that says which. */
export async function tokenRevoke(context: Context, reference: string): Promise<void> {
  context.requireNetwork('Revoking a token')
  const client = await context.client()
  const tokens = await client.tokens.list()
  const matches = tokens.filter(
    (token) => token.id === reference || token.id.startsWith(reference) || token.name === reference,
  )
  if (matches.length === 0)
    throw new UsageError(`No token matches "${reference}".`, 'See them with `yuzie token list`.')
  if (matches.length > 1)
    throw new UsageError(
      `"${reference}" matches ${matches.length} tokens: ${matches.map((t) => t.id.slice(0, 8)).join(', ')}.`,
      'Use more of the id.',
    )
  const token = matches[0] as ApiToken
  await client.tokens.revoke(token.id)
  context.output.success(
    `Revoked "${token.name}"${token.agent === null ? '' : ` (@${token.agent}, agent)`}`,
  )
  context.output.result('TokenRevoked', { id: token.id, revoked: true })
}
