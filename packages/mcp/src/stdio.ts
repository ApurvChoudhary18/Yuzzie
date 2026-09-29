/**
 * Serving the board over stdio, the way an agent host (Claude Code, an IDE)
 * launches MCP servers: JSON-RPC on stdin and stdout, and nothing else on
 * stdout — the audit log goes to stderr, one JSON line per tool call.
 */

import { appendFile } from 'node:fs/promises'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { type AuditEntry, createYuzieMcpServer, type YuzieMcpOptions } from './server.js'

export interface StdioOptions extends Omit<YuzieMcpOptions, 'audit'> {
  readonly stdin?: NodeJS.ReadableStream
  readonly stdout?: NodeJS.WritableStream
  readonly stderr?: NodeJS.WritableStream
  /** Also append the audit log to this file. */
  readonly auditFile?: string
}

/** Resolves when the host closes the connection. */
export async function serveStdio(options: StdioOptions): Promise<void> {
  const stderr = options.stderr ?? process.stderr
  const audit = (entry: AuditEntry) => {
    const line = `${JSON.stringify({ audit: 'yuzie-mcp', ...entry })}\n`
    stderr.write(line)
    if (options.auditFile !== undefined) void appendFile(options.auditFile, line).catch(() => {})
  }
  const server = createYuzieMcpServer({ ...options, audit })
  const transport = new StdioServerTransport(
    (options.stdin ?? process.stdin) as never,
    (options.stdout ?? process.stdout) as never,
  )
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve()
  })
  await server.connect(transport)
  // A host that goes away closes stdin; that is the end of the session.
  ;(options.stdin ?? process.stdin).once('end', () => void server.close())
  await closed
}
