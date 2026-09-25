/**
 * Who may approve a device login (SPEC.md §6.1, §14.1).
 *
 * The person approving a device code chooses the handle it signs in as. If that
 * handle already belongs to someone who has signed in, approving must require
 * being that person — otherwise anyone could start their own login, approve it
 * as `rahul`, and walk away with Rahul's account.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, createUser, startTestServer, type TestServer, unique } from './__tests__/harness.js'

describe('device approval', () => {
  let server: TestServer

  beforeAll(async () => {
    server = await startTestServer()
  })

  afterAll(async () => {
    await server.close()
  })

  async function start() {
    const response = await call<{ deviceCode: string; userCode: string }>(server, {
      method: 'POST',
      url: '/v1/auth/device',
    })
    return response.body
  }

  async function approve(userCode: string, handle: string, token?: string) {
    return call<{ error?: { code: string } }>(server, {
      method: 'POST',
      url: '/v1/auth/device/approve',
      body: { userCode, handle },
      ...(token === undefined ? {} : { token }),
    })
  }

  async function poll(deviceCode: string) {
    return call<{ token?: string; user?: { handle: string } }>(server, {
      method: 'POST',
      url: '/v1/auth/device/token',
      body: { deviceCode },
    })
  }

  it('refuses to sign a stranger in as an existing user', async () => {
    const victim = await createUser(server)
    const attacker = await start()

    const approved = await approve(attacker.userCode, victim.handle)
    expect(approved.status).toBe(403)
    expect(approved.body.error?.code).toBe('forbidden')

    // And the attacker's device never receives a token for the victim.
    const polled = await poll(attacker.deviceCode)
    expect(polled.status).toBe(428)
    expect(polled.body.token).toBeUndefined()
  })

  it('lets an existing user approve a new device while signed in as themselves', async () => {
    const rahul = await createUser(server)
    const laptop = await start()
    expect((await approve(laptop.userCode, rahul.handle, rahul.token)).status).toBe(200)
    const polled = await poll(laptop.deviceCode)
    expect(polled.body.user?.handle).toBe(rahul.handle)
  })

  it('refuses when the approver is signed in as someone else', async () => {
    const rahul = await createUser(server)
    const priya = await createUser(server)
    const device = await start()
    expect((await approve(device.userCode, rahul.handle, priya.token)).status).toBe(403)
  })

  it('still lets a new person choose an unused handle on an open server', async () => {
    const device = await start()
    const handle = unique('newcomer')
    expect((await approve(device.userCode, handle)).status).toBe(200)
    expect((await poll(device.deviceCode)).body.user?.handle).toBe(handle)
  })

  it('lets someone who signed out everywhere sign in again (the documented gap)', async () => {
    // A self-hosted server has no identity provider: once every token of an
    // account is revoked, nothing distinguishes its owner from anyone else.
    // Refusing would lock out everyone who logs out on their only device.
    const rahul = await createUser(server)
    const revoked = await call(server, {
      method: 'DELETE',
      url: '/v1/tokens/current',
      token: rahul.token,
    })
    expect(revoked.status).toBe(200)
    expect((await call(server, { method: 'GET', url: '/v1/me', token: rahul.token })).status).toBe(
      401,
    )

    const device = await start()
    expect((await approve(device.userCode, rahul.handle)).status).toBe(200)
  })

  it('serves a page a person can approve from in a browser', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/device' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toMatch(/text\/html/)
    expect(response.body).toContain('/v1/auth/device/approve')
    // No third-party scripts or styles: the page must work on an air-gapped self-host.
    expect(response.body).not.toMatch(/<script[^>]+src=|<link[^>]+href="http/)
  })
})
