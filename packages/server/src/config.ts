/**
 * Server configuration, validated once at startup so a typo in an environment
 * variable is a clear message rather than a runtime surprise (Appendix E rule 5).
 */
import { z } from 'zod'

export const ConfigSchema = z.object({
  databaseUrl: z.string().min(1),
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().positive().default(8787),
  /** Trusted origin used to build the device-flow verification URL. */
  publicUrl: z.url().default('http://localhost:8787'),
  /**
   * `open` lets an unknown handle claim a device code and become a user, which is
   * how a self-hosted server with no GitHub app onboards its first team. `invite`
   * requires the user to exist already.
   */
  signupMode: z.enum(['open', 'invite']).default('open'),
  /** SPEC.md §12.1: 600 reads/min, 120 writes/min per token. */
  readRateLimit: z.number().int().positive().default(600),
  writeRateLimit: z.number().int().positive().default(120),
  rateLimitEnabled: z.boolean().default(true),
  /** §12.1: the server stores an idempotency key -> response for 24 hours. */
  idempotencyTtlMs: z
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60 * 1000),
  deviceCodeTtlMs: z
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  devicePollIntervalSeconds: z.number().int().positive().default(5),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
})

export type ServerConfig = z.infer<typeof ConfigSchema>
export type ServerConfigInput = z.input<typeof ConfigSchema>

function optionalInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) ? parsed : Number.NaN
}

/** Build config from the environment, letting explicit overrides win. */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  overrides: Partial<ServerConfigInput> = {},
): ServerConfig {
  const fromEnv: Partial<ServerConfigInput> = {
    databaseUrl: env.DATABASE_URL,
    host: env.HOST,
    port: optionalInt(env.PORT),
    publicUrl: env.YUZIE_PUBLIC_URL,
    signupMode: env.YUZIE_SIGNUP as ServerConfigInput['signupMode'],
    logLevel: env.LOG_LEVEL as ServerConfigInput['logLevel'],
  }

  const merged: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fromEnv)) {
    if (value !== undefined) merged[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = value
  }

  const parsed = ConfigSchema.safeParse(merged)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid server configuration:\n${problems}\n\nSet DATABASE_URL and retry.`)
  }
  return parsed.data
}
