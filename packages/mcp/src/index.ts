/**
 * @yuzie/mcp — the Model Context Protocol server that puts an AI coding agent
 * on a Yuzie board (SPEC.md §13.4). `yuzie mcp` runs it over stdio.
 */
export const PACKAGE_NAME = '@yuzie/mcp' as const

export {
  type AuditEntry,
  createYuzieMcpServer,
  type GitSettings,
  SERVER_NAME,
  TOOL_NAMES,
  type ToolName,
  type YuzieMcpOptions,
} from './server.js'
export { type StdioOptions, serveStdio } from './stdio.js'
