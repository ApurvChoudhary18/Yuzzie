/**
 * `yuzie mcp` (SPEC.md §13.4, §18 Session 15): the board as an MCP server on
 * stdio, for an AI coding agent. Run it with the agent's token (`YUZIE_TOKEN`,
 * from `yuzie token create --agent <handle>`) so everything it does is
 * attributed to the agent.
 *
 * stdout carries the protocol and nothing else; the audit log — one JSON line
 * per tool call — goes to stderr, and to `--audit-log <file>` if given.
 */
import { resolve } from 'node:path'
import type { Context } from '../context.js'
import { UsageError } from '../exit.js'
import { withBoard } from '../session.js'
import { VERSION } from '../version.js'

export interface McpOptions {
  readonly allowDestructive?: boolean
  readonly allowGit?: boolean
  readonly auditLog?: string
}

export async function mcp(context: Context, options: McpOptions): Promise<number> {
  if (context.output.json)
    throw new UsageError('`yuzie mcp` speaks MCP on stdout; --json does not apply.')
  const { config } = await context.config()
  const { serveStdio } = await import('@yuzie/mcp')
  return withBoard(
    context,
    async (session) => {
      const who = session.me === null ? 'an unknown user' : `@${session.me}`
      context.io.stderr.write(
        `yuzie mcp · ${session.slug} as ${who}${options.allowGit === true ? ' · --allow-git' : ''}${options.allowDestructive === true ? ' · --allow-destructive' : ''}\n`,
      )
      await serveStdio({
        board: session.board,
        slug: session.slug,
        version: VERSION,
        allowDestructive: options.allowDestructive === true,
        allowGit: options.allowGit === true,
        git: {
          cwd: context.io.cwd,
          baseBranch: config.git.baseBranch,
          branchTemplate: config.git.branchTemplate,
          startColumn: config.flow.startColumn,
        },
        stdin: context.io.stdin as unknown as NodeJS.ReadableStream,
        stdout: context.io.stdout as unknown as NodeJS.WritableStream,
        stderr: context.io.stderr as unknown as NodeJS.WritableStream,
        ...(options.auditLog === undefined
          ? {}
          : { auditFile: resolve(context.io.cwd, options.auditLog) }),
      })
      return 0
    },
    { live: true, quiet: true },
  )
}
