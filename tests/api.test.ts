import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { BookingService } from '../src/services/booking-service.js'
import { MunicipalityRegistry, STRICT_DEFAULTS } from '../src/policy/municipality.js'
import { createStore, type Store } from '../src/store/memory.js'
import { makeAvailability, makeClient, makeOperator, makeWorker } from './fixtures.js'

const PSEUDONYM_KEY = 'k'.repeat(32)
const NOW = '2026-06-15T18:00:00.000Z'
const START = '2026-06-15T20:00:00.000Z'

let app: FastifyInstance
let store: Store
let operatorId: string
let workerId: string
let otherWorkerId: string
let clientId: string

const contacts = [
  { name: 'Beheerder', phone: '+31600000000', order: 0, kind: 'operator_beheerder' as const },
]

function worker(id: string) {
  return { 'x-actor-kind': 'worker', 'x-actor-id': id }
}
const client = () => ({ 'x-actor-kind': 'client', 'x-actor-id': clientId })
const operatorHeaders = () => ({ 'x-actor-kind': 'operator', 'x-actor-id': operatorId })

beforeEach(async () => {
  store = createStore()
  const registry = new MunicipalityRegistry()
  registry.register({
    code: 'GM0363',
    ...STRICT_DEFAULTS,
    allowPrivateResidenceBookings: true,
    sourceReference: 'test',
  })

  const operator = makeOperator()
  operatorId = operator.id
  store.operators.set(operator.id, operator)

  // Round-the-clock boundaries so the test does not depend on Amsterdam local time.
  const wide = { earliestStartHour: 0, latestStartHour: 23, refusedServices: [], maxBookingMinutes: 180, allowedLocationTypes: ['hotel' as const, 'private_residence' as const] }
  const w1 = makeWorker(operator.id, { displayName: 'Robin', boundaries: wide, directPhone: '+31611111111', payoutIban: 'NL01' })
  const w2 = makeWorker(operator.id, { displayName: 'Sam', boundaries: wide, directPhone: '+31622222222', payoutIban: 'NL02' })
  workerId = w1.id
  otherWorkerId = w2.id
  store.workers.set(w1.id, w1)
  store.workers.set(w2.id, w2)
  store.availability.set('a1', makeAvailability(w1.id, { id: 'a1' }))
  store.availability.set('a2', makeAvailability(w2.id, { id: 'a2' }))

  const c = makeClient()
  clientId = c.id
  store.clients.set(c.id, c)

  const service = new BookingService(store, {
    registry,
    safetyGraceMinutes: 20,
    checkInGraceMinutes: 45,
    now: () => NOW,
  })

  app = buildServer({ store, service, pseudonymKey: PSEUDONYM_KEY, now: () => NOW, mode: 'demo', logger: false })
  await app.ready()
})

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    operatorId,
    clientId,
    requestedStart: START,
    durationMinutes: 60,
    location: {
      type: 'hotel',
      municipality: 'GM0363',
      addressLine: 'Teststraat 1',
      postalCode: '1011AB',
      venueName: 'Test Hotel',
    },
    requestedServices: [],
    agreedRateCents: 20000,
    ...overrides,
  }
}

async function createBooking(overrides: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: '/bookings', payload: requestBody(overrides) })
}

describe('booking creation', () => {
  it('offers a valid request to both eligible workers', async () => {
    const res = await createBooking()
    expect(res.statusCode).toBe(201)
    expect(res.json().offeredToWorkerCount).toBe(2)
  })

  it('refuses an invalid body', async () => {
    const res = await app.inject({ method: 'POST', url: '/bookings', payload: { operatorId } })
    expect(res.statusCode).toBe(400)
  })

  it('refuses a request the screening blocks, without leaking why', async () => {
    const res = await createBooking({
      location: { ...requestBody().location, municipality: 'GM9999' },
    })
    expect(res.statusCode).toBe(422)
    const body = res.json()
    expect(body.code).toBe('booking_refused')
    // No screening internals reach the client.
    expect(JSON.stringify(body)).not.toContain('municipality_not_configured')
  })
})

describe('the offer is not an assignment', () => {
  it('withholds the address until the worker has accepted', async () => {
    await createBooking()

    const before = await app.inject({ method: 'GET', url: '/me/offers', headers: worker(workerId) })
    expect(before.json().offers[0].location.addressLine).toBeNull()
    expect(before.json().offers[0].location.municipality).toBe('GM0363')

    const bookingId = [...store.bookings.keys()][0]!
    const accept = await app.inject({
      method: 'POST', url: `/bookings/${bookingId}/accept`, headers: worker(workerId),
    })
    expect(accept.statusCode).toBe(200)
    expect(accept.json().booking.location.addressLine).toBe('Teststraat 1')
  })

  it('stops a second worker accepting a taken booking', async () => {
    await createBooking()
    const bookingId = [...store.bookings.keys()][0]!
    await app.inject({ method: 'POST', url: `/bookings/${bookingId}/accept`, headers: worker(workerId) })

    const second = await app.inject({
      method: 'POST', url: `/bookings/${bookingId}/accept`, headers: worker(otherWorkerId),
    })
    expect(second.statusCode).toBe(409)
  })

  it('rejects an unauthenticated caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/me/offers' })
    expect(res.statusCode).toBe(401)
  })
})

describe('the journey', () => {
  async function acceptedBooking() {
    await createBooking()
    const bookingId = [...store.bookings.keys()][0]!
    await app.inject({ method: 'POST', url: `/bookings/${bookingId}/accept`, headers: worker(workerId) })
    await app.inject({ method: 'POST', url: `/bookings/${bookingId}/confirm`, headers: client() })
    return bookingId
  }

  it('opens a safety session the moment the worker departs', async () => {
    const bookingId = await acceptedBooking()
    const res = await app.inject({
      method: 'POST', url: `/bookings/${bookingId}/depart`,
      headers: worker(workerId), payload: { escalationContacts: contacts },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().safetySessionId).toBeTruthy()
    expect(store.safetySessions.size).toBe(1)
  })

  it('refuses to let a worker depart with no escalation contact', async () => {
    const bookingId = await acceptedBooking()
    const res = await app.inject({
      method: 'POST', url: `/bookings/${bookingId}/depart`,
      headers: worker(workerId), payload: { escalationContacts: [] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('escalation_contacts_required')
    // And the booking has not advanced.
    expect(store.bookings.get(bookingId)?.status).toBe('confirmed')
  })

  it('runs departure, arrival and completion, closing the session', async () => {
    const bookingId = await acceptedBooking()
    await app.inject({
      method: 'POST', url: `/bookings/${bookingId}/depart`,
      headers: worker(workerId), payload: { escalationContacts: contacts },
    })
    await app.inject({ method: 'POST', url: `/bookings/${bookingId}/arrive`, headers: worker(workerId) })
    const done = await app.inject({ method: 'POST', url: `/bookings/${bookingId}/complete`, headers: worker(workerId) })

    expect(done.statusCode).toBe(200)
    expect(store.bookings.get(bookingId)?.status).toBe('completed')
    expect([...store.safetySessions.values()][0]?.state).toBe('closed')
  })

  it('lets the worker cancel mid-booking and closes the session', async () => {
    const bookingId = await acceptedBooking()
    await app.inject({
      method: 'POST', url: `/bookings/${bookingId}/depart`,
      headers: worker(workerId), payload: { escalationContacts: contacts },
    })
    await app.inject({ method: 'POST', url: `/bookings/${bookingId}/arrive`, headers: worker(workerId) })

    const res = await app.inject({
      method: 'POST', url: `/bookings/${bookingId}/cancel`,
      headers: worker(workerId), payload: { reason: null },
    })
    expect(res.statusCode).toBe(200)
    expect(store.bookings.get(bookingId)?.status).toBe('cancelled_by_worker')
    expect([...store.safetySessions.values()][0]?.state).toBe('closed')
  })

  it('escalates on panic', async () => {
    const bookingId = await acceptedBooking()
    const departed = await app.inject({
      method: 'POST', url: `/bookings/${bookingId}/depart`,
      headers: worker(workerId), payload: { escalationContacts: contacts },
    })
    const sessionId = departed.json().safetySessionId

    const res = await app.inject({
      method: 'POST', url: `/safety/${sessionId}/panic`, headers: worker(workerId),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().state).toBe('escalated')
    expect(res.json().contacts[0].kind).toBe('operator_beheerder')
  })

  it('does not let another worker touch someone else booking', async () => {
    const bookingId = await acceptedBooking()
    const res = await app.inject({
      method: 'POST', url: `/bookings/${bookingId}/complete`, headers: worker(otherWorkerId),
    })
    expect(res.statusCode).toBe(409)
  })
})

describe('operator oversight', () => {
  it('exposes the risk signals for the roster', async () => {
    // Point both workers at one payout account.
    const w = store.workers.get(otherWorkerId)!
    store.workers.set(w.id, { ...w, payoutIban: 'NL01' })

    const res = await app.inject({
      method: 'GET', url: `/operators/${operatorId}/risk`, headers: operatorHeaders(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().signals.map((s: { code: string }) => s.code)).toContain('shared_payout_iban')
  })

  it('serves a pseudonymised administration', async () => {
    await createBooking()
    const bookingId = [...store.bookings.keys()][0]!
    await app.inject({ method: 'POST', url: `/bookings/${bookingId}/accept`, headers: worker(workerId) })

    const res = await app.inject({
      method: 'GET', url: `/operators/${operatorId}/administration`, headers: operatorHeaders(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.payload
    expect(res.json().vergunningNumber).toBe('ESC-2026-0001')
    expect(body).not.toContain(workerId)
    expect(body).not.toContain('Teststraat')
  })

  it('refuses operator endpoints to a worker', async () => {
    const res = await app.inject({
      method: 'GET', url: `/operators/${operatorId}/risk`, headers: worker(workerId),
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('the access gate', () => {
  const GATE = { user: 'reviewer', password: 'x'.repeat(20) }

  async function gated() {
    const registry = new MunicipalityRegistry()
    registry.register({ code: 'GM0363', ...STRICT_DEFAULTS, sourceReference: 'test' })
    const s = createStore()
    const service = new BookingService(s, {
      registry, safetyGraceMinutes: 20, checkInGraceMinutes: 45, now: () => NOW,
    })
    const a = buildServer({
      store: s, service, pseudonymKey: PSEUDONYM_KEY, now: () => NOW,
      mode: 'demo', logger: false, accessGate: GATE,
    })
    await a.ready()
    return a
  }

  const creds = (user: string, password: string) =>
    `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

  it('refuses an unauthenticated request', async () => {
    const a = await gated()
    const res = await a.inject({ method: 'GET', url: '/me/offers' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toContain('Basic')
  })

  it('refuses wrong credentials', async () => {
    const a = await gated()
    const res = await a.inject({
      method: 'GET', url: '/me/offers',
      headers: { authorization: creds('reviewer', 'wrong-password-entirely') },
    })
    expect(res.statusCode).toBe(401)
  })

  it('refuses a malformed authorization header', async () => {
    const a = await gated()
    for (const authorization of ['Bearer abc', 'Basic !!!!', 'Basic ' + Buffer.from('nocolon').toString('base64')]) {
      const res = await a.inject({ method: 'GET', url: '/me/offers', headers: { authorization } })
      expect(res.statusCode).toBe(401)
    }
  })

  it('lets correct credentials through to the normal auth layer', async () => {
    const a = await gated()
    const res = await a.inject({
      method: 'GET', url: '/me/offers',
      headers: { authorization: creds(GATE.user, GATE.password) },
    })
    // Past the curtain, so now it is the missing worker identity that refuses.
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('worker_auth_required')
  })

  it('leaves /health open for platform health checks', async () => {
    const a = await gated()
    const res = await a.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json().mode).toBe('demo')
  })

  it('serves a disallow-all robots.txt without credentials', async () => {
    const a = await gated()
    const res = await a.inject({ method: 'GET', url: '/robots.txt' })
    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('Disallow: /')
  })

  it('marks demo responses noindex', async () => {
    const a = await gated()
    const res = await a.inject({ method: 'GET', url: '/health' })
    expect(res.headers['x-robots-tag']).toContain('noindex')
  })
})
