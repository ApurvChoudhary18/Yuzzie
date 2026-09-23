/**
 * The device-code flow (SPEC.md §6.1, §12.1).
 *
 * Chosen over an OAuth redirect because it works over SSH and inside dev
 * containers, where there is no browser to redirect back to (§10.3).
 *
 * `POST /auth/device/approve` is the seam where a GitHub OAuth callback would
 * sit. A self-hosted server has no GitHub app, so possession of the short-lived
 * user code — which is only ever printed in the requesting terminal — is what
 * authorises the exchange. `YUZIE_SIGNUP=invite` requires the handle to exist
 * already, which is how a closed team locks that door.
 */
import { boardError } from '@yuzie/core'
import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { generateDeviceCode, generateToken, generateUserCode, hashToken } from '../auth/tokens.js'
import { apiTokens, deviceCodes, users } from '../db/schema.js'
import { toUser } from '../services/serialize.js'
import { type AppContext, parseBody } from './helpers.js'

const ApproveRequestSchema = z.object({
  userCode: z.string().min(1),
  handle: z
    .string()
    .min(1)
    .max(39)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  email: z.email().optional(),
  displayName: z.string().min(1).optional(),
})

export function registerAuthRoutes(app: FastifyInstance, context: AppContext): void {
  const { db, config } = context

  app.post('/auth/device', async (_request, reply) => {
    const deviceCode = generateDeviceCode()
    const userCode = generateUserCode()
    const expiresAt = new Date(Date.now() + config.deviceCodeTtlMs)

    await db.insert(deviceCodes).values({ deviceCode, userCode, expiresAt })

    return reply.status(201).send({
      deviceCode,
      userCode,
      verifyUrl: `${config.publicUrl.replace(/\/+$/, '')}/device`,
      interval: config.devicePollIntervalSeconds,
      expiresIn: Math.floor(config.deviceCodeTtlMs / 1000),
    })
  })

  app.post('/auth/device/approve', async (request, reply) => {
    const body = parseBody(ApproveRequestSchema, request.body)

    const [pending] = await db
      .select()
      .from(deviceCodes)
      .where(and(eq(deviceCodes.userCode, body.userCode), isNull(deviceCodes.approvedAt)))

    if (pending === undefined) {
      throw boardError('card_not_found', 'That code is not waiting for approval. Check the code.', {
        status: 404,
      })
    }
    if (pending.expiresAt.getTime() <= Date.now()) {
      throw boardError('validation_failed', 'That code has expired. Run `yuzie login` again.')
    }

    const [existing] = await db.select().from(users).where(eq(users.handle, body.handle))

    let userId: string
    if (existing !== undefined) {
      userId = existing.id
    } else {
      if (config.signupMode === 'invite') {
        throw boardError(
          'forbidden',
          `No account for @${body.handle}. This server only accepts invited users; ask an owner to invite you.`,
        )
      }
      const [createdUser] = await db
        .insert(users)
        .values({
          handle: body.handle,
          email: body.email ?? null,
          displayName: body.displayName ?? null,
          kind: 'human',
        })
        .returning()
      if (createdUser === undefined) throw boardError('internal', 'Could not create the account')
      userId = createdUser.id
    }

    await db
      .update(deviceCodes)
      .set({ userId, approvedAt: new Date() })
      .where(eq(deviceCodes.deviceCode, pending.deviceCode))

    return reply.status(200).send({ approved: true, handle: body.handle })
  })

  app.post('/auth/device/token', async (request, reply) => {
    const body = parseBody(z.object({ deviceCode: z.string().min(1) }), request.body)

    const [pending] = await db
      .select()
      .from(deviceCodes)
      .where(eq(deviceCodes.deviceCode, body.deviceCode))

    if (pending === undefined) {
      throw boardError('unauthenticated', 'Unknown device code. Run `yuzie login` again.')
    }
    if (pending.expiresAt.getTime() <= Date.now()) {
      throw boardError('unauthenticated', 'That login attempt expired. Run `yuzie login` again.')
    }
    if (pending.consumedAt !== null) {
      throw boardError('unauthenticated', 'That device code was already used.')
    }
    if (pending.approvedAt === null || pending.userId === null) {
      // The CLI polls on this, so it is a normal state, not a fault.
      return reply.status(428).send({
        error: {
          code: 'unauthenticated',
          message: 'Still waiting for you to approve the login.',
          status: 428,
          details: { pending: true, interval: config.devicePollIntervalSeconds },
        },
      })
    }

    const [user] = await db.select().from(users).where(eq(users.id, pending.userId))
    if (user === undefined) throw boardError('unauthenticated', 'That account no longer exists.')

    const token = generateToken()
    await db.insert(apiTokens).values({
      userId: user.id,
      boardId: null,
      name: 'cli',
      tokenHash: hashToken(token),
      role: 'owner',
    })

    await db
      .update(deviceCodes)
      .set({ consumedAt: new Date() })
      .where(eq(deviceCodes.deviceCode, pending.deviceCode))

    return reply.status(200).send({ token, user: toUser(user) })
  })
}
