import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod'
import type { DeployMode } from '../config.js'
import type { Uuid } from '../domain/types.js'
import { detectSignals } from '../risk/indicators.js'
import { extend, panic, sweep } from '../safety/session.js'
import { toAdministrationRecord } from '../privacy/retention.js'
import { pseudonymFor } from '../store/pseudonym.js'
import { offersVisibleTo, openSafetySessions, workersOf, type Store } from '../store/memory.js'
import type { BookingService, ServiceResult } from '../services/booking-service.js'
import { bookingForClient, bookingForWorker } from './serialize.js'

/**
 * HTTP layer. Thin on purpose: it decodes, identifies the actor, and delegates.
 * No rule lives here that does not also live in the domain, because this is not
 * the only way the domain will eventually be called.
 */

export interface ServerDeps {
  store: Store
  service: BookingService
  /** HMAC key for administration pseudonyms. Injected, never defaulted. */
  pseudonymKey: string
  now: () => string
  /** Stamped on every response so an instance's mode is never in doubt. */
  mode: DeployMode
  /** False in tests. */
  logger?: boolean
  logLevel?: string
  trustProxy?: boolean
}

const locationSchema = z.object({
  type: z.enum(['hotel', 'private_residence', 'operator_premises']),
  municipality: z.string().min(1),
  addressLine: z.string().min(1),
  postalCode: z.string().min(1),
  venueName: z.string().nullable().default(null),
})

const createBookingSchema = z.object({
  operatorId: z.string().uuid(),
  clientId: z.string().uuid(),
  requestedStart: z.string().datetime(),
  durationMinutes: z.number().int().positive().max(24 * 60),
  location: locationSchema,
  requestedServices: z.array(z.string()).default([]),
  agreedRateCents: z.number().int().positive(),
})

const escalationContactSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  order: z.number().int().nonnegative(),
  kind: z.enum(['operator_beheerder', 'trusted_person', 'emergency_services']),
})

/**
 * Actor identification.
 *
 * PLACEHOLDER. Production must replace this with real authentication -- session
 * tokens for workers and operator staff, and a separate short-lived credential
 * for clients. Trusting a header here would let anyone act as any worker, which
 * on this platform means anyone could accept bookings in someone else's name.
 * See docs/threat-model.md.
 */
interface Actor {
  kind: 'worker' | 'client' | 'operator'
  id: Uuid
}

function actorOf(request: FastifyRequest): Actor | null {
  const kind = request.headers['x-actor-kind']
  const id = request.headers['x-actor-id']
  if (typeof kind !== 'string' || typeof id !== 'string') return null
  if (kind !== 'worker' && kind !== 'client' && kind !== 'operator') return null
  return { kind, id }
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    /**
     * Logging is deliberately lobotomised.
     *
     * Logs are the classic leak path for exactly the data this platform exists
     * to protect: a request line carrying a booking id, an address, or a worker
     * id ends up in a log aggregator with far weaker access controls than the
     * database, and stays there. So requests are logged by *route pattern*
     * (`/bookings/:id`, never the id), and headers, body, query and params are
     * dropped before they reach a serialiser.
     */
    logger:
      deps.logger === false
        ? false
        : {
            level: deps.logLevel ?? 'info',
            serializers: {
              // Typed structurally: pino's reply serializer receives a shape
              // whose routeOptions is optional, so naming FastifyReply here
              // silently pushes the whole instance onto the http2 overload.
              req(request: { method: string; routeOptions?: { url?: string | undefined } }) {
                return {
                  method: request.method,
                  route: request.routeOptions?.url ?? 'unmatched',
                }
              },
              res(reply: { statusCode: number }) {
                return { statusCode: reply.statusCode }
              },
            },
            redact: {
              paths: ['req.headers', 'req.body', 'req.query', 'req.params', 'req.url'],
              remove: true,
            },
          },
    trustProxy: deps.trustProxy ?? false,
    disableRequestLogging: false,
  })
  const { store, service } = deps

  void app.register(helmet, {
    // No profile page or API response should ever be framed by a third party,
    // and referrers must not carry booking ids off-site.
    contentSecurityPolicy: { directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] } },
    referrerPolicy: { policy: 'no-referrer' },
    // Match the CSP rather than helmet's SAMEORIGIN default, which contradicts
    // frame-ancestors 'none' for anything reading the legacy header.
    frameguard: { action: 'deny' },
  })

  void app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    // Verification and booking endpoints are the ones worth enumerating
    // against; a global ceiling is the floor, not the whole answer.
    keyGenerator: (request) => {
      const actor = request.headers['x-actor-id']
      return typeof actor === 'string' ? `actor:${actor}` : `ip:${request.ip}`
    },
  })

  /** Every response says which mode produced it. */
  app.addHook('onSend', async (_request, reply, payload) => {
    void reply.header('x-deliverho-mode', deps.mode)
    if (deps.mode === 'demo') {
      void reply.header(
        'x-deliverho-warning',
        'DEMO INSTANCE -- synthetic data only, nothing persisted, auth is forgeable',
      )
    }
    return payload
  })

  app.get('/health', async () => ({
    ok: true,
    at: deps.now(),
    mode: deps.mode,
    ...(deps.mode === 'demo'
      ? { warning: 'Demo instance. Synthetic data only. Do not enter real data.' }
      : {}),
  }))

  // -- Client: request a booking -------------------------------------------

  app.post('/bookings', async (request, reply) => {
    const parsed = createBookingSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ code: 'invalid_body', detail: parsed.error.flatten() })
    }

    const result = service.createBooking(parsed.data)
    if (!result.ok) return sendError(reply, result)

    const { booking, report } = result.value
    if (report.outcome.decision === 'block') {
      // The client is told the request was refused and nothing else. Screening
      // internals would tell a determined client exactly which gate to work
      // around, and the rejection reasons concern other people's workers.
      return reply.code(422).send({
        code: 'booking_refused',
        message: 'This request cannot be accepted.',
        bookingId: booking.id,
      })
    }

    return reply.code(201).send({
      booking: bookingForClient(booking, null),
      offeredToWorkerCount: report.outcome.workerIds.length,
    })
  })

  // -- Worker: see and answer offers ---------------------------------------

  app.get('/me/offers', async (request, reply) => {
    const actor = actorOf(request)
    if (actor === null || actor.kind !== 'worker') {
      return reply.code(401).send({ code: 'worker_auth_required' })
    }
    const bookings = offersVisibleTo(store, actor.id)
    return { offers: bookings.map((b) => bookingForWorker(b, actor.id)) }
  })

  app.post('/bookings/:id/accept', async (request, reply) => {
    const actor = actorOf(request)
    if (actor === null || actor.kind !== 'worker') {
      return reply.code(401).send({ code: 'worker_auth_required' })
    }
    const id = (request.params as { id: string }).id
    const result = service.command(id, { type: 'worker_accept', workerId: actor.id })
    if (!result.ok) return sendError(reply, result)
    return { booking: bookingForWorker(result.value, actor.id) }
  })

  app.post('/bookings/:id/decline', async (request, reply) => {
    const actor = actorOf(request)
    if (actor === null || actor.kind !== 'worker') {
      return reply.code(401).send({ code: 'worker_auth_required' })
    }
    const id = (request.params as { id: string }).id
    const body = z.object({ reason: z.string().nullable().default(null) }).safeParse(request.body ?? {})
    const reason = body.success ? body.data.reason : null
    const result = service.command(id, { type: 'worker_decline', workerId: actor.id, reason })
    if (!result.ok) return sendError(reply, result)
    return { ok: true }
  })

  // -- Client: confirm ------------------------------------------------------

  app.post('/bookings/:id/confirm', async (request, reply) => {
    const actor = actorOf(request)
    if (actor === null || actor.kind !== 'client') {
      return reply.code(401).send({ code: 'client_auth_required' })
    }
    const id = (request.params as { id: string }).id
    const result = service.command(id, { type: 'client_confirm', clientId: actor.id })
    if (!result.ok) return sendError(reply, result)
    const worker = result.value.workerId === null ? null : store.workers.get(result.value.workerId)
    return { booking: bookingForClient(result.value, worker?.displayName ?? null) }
  })

  // -- Worker: the journey --------------------------------------------------

  app.post('/bookings/:id/depart', async (request, reply) => {
    const actor = actorOf(request)
    if (actor === null || actor.kind !== 'worker') {
      return reply.code(401).send({ code: 'worker_auth_required' })
    }
    const parsed = z
      .object({ escalationContacts: z.array(escalationContactSchema).min(1) })
      .safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'escalation_contacts_required',
        message: 'At least one escalation contact is required before travelling.',
      })
    }
    const id = (request.params as { id: string }).id
    const result = service.depart(id, actor.id, parsed.data.escalationContacts)
    if (!result.ok) return sendError(reply, result)
    return {
      booking: bookingForWorker(result.value.booking, actor.id),
      safetySessionId: result.value.safetySessionId,
    }
  })

  app.post('/bookings/:id/arrive', async (request, reply) =>
    workerTransition(request, reply, (id, workerId) => service.arrive(id, workerId)),
  )

  app.post('/bookings/:id/complete', async (request, reply) =>
    workerTransition(request, reply, (id, workerId) => service.complete(id, workerId)),
  )

  app.post('/bookings/:id/cancel', async (request, reply) => {
    const actor = actorOf(request)
    if (actor === null) return reply.code(401).send({ code: 'auth_required' })
    const id = (request.params as { id: string }).id
    const body = z.object({ reason: z.string().nullable().default(null) }).safeParse(request.body ?? {})
    const reason = body.success ? body.data.reason : null

    const result =
      actor.kind === 'worker'
        ? service.workerCancel(id, actor.id, reason)
        : service.command(id, { type: 'client_cancel', clientId: actor.id, reason })

    if (!result.ok) return sendError(reply, result)
    return { ok: true, status: result.value.status }
  })

  // -- Safety ---------------------------------------------------------------

  app.post('/safety/:id/panic', async (request, reply) => {
    const actor = actorOf(request)
    if (actor === null || actor.kind !== 'worker') {
      return reply.code(401).send({ code: 'worker_auth_required' })
    }
    const id = (request.params as { id: string }).id
    const session = store.safetySessions.get(id)
    if (session === undefined) return reply.code(404).send({ code: 'session_not_found' })

    const result = panic(session, actor.id, deps.now())
    if (!result.ok) return reply.code(409).send({ code: result.code, message: result.message })
    store.safetySessions.set(result.session.id, result.session)
    return { state: result.session.state, contacts: result.session.escalationContacts }
  })

  app.post('/safety/:id/extend', async (request, reply) => {
    const actor = actorOf(request)
    if (actor === null || actor.kind !== 'worker') {
      return reply.code(401).send({ code: 'worker_auth_required' })
    }
    const id = (request.params as { id: string }).id
    const parsed = z.object({ minutes: z.number().int().positive() }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ code: 'invalid_body' })

    const session = store.safetySessions.get(id)
    if (session === undefined) return reply.code(404).send({ code: 'session_not_found' })

    const result = extend(session, actor.id, parsed.data.minutes, 120)
    if (!result.ok) return reply.code(409).send({ code: result.code, message: result.message })
    store.safetySessions.set(result.session.id, result.session)
    return { expectedCheckOutAt: result.session.expectedCheckOutAt }
  })

  /**
   * The sweep endpoint. In production this is a scheduled job, not an HTTP
   * route -- exposed here so the behaviour is drivable in development and in
   * tests without waiting out real clock time.
   */
  app.post('/internal/safety/sweep', async (request, reply) => {
    const actor = actorOf(request)
    if (actor === null || actor.kind !== 'operator') {
      return reply.code(401).send({ code: 'operator_auth_required' })
    }
    const due = sweep(openSafetySessions(store), deps.now(), 45)
    for (const item of due) {
      store.safetySessions.set(item.session.id, {
        ...item.session,
        state: 'escalated',
        escalatedAt: deps.now(),
        escalationReason: item.reason,
      })
    }
    return {
      escalated: due.map((d) => ({
        sessionId: d.session.id,
        workerId: d.session.workerId,
        reason: d.reason,
        contacts: d.contacts,
      })),
    }
  })

  // -- Operator: oversight --------------------------------------------------

  app.get('/operators/:id/risk', async (request, reply) => {
    const actor = actorOf(request)
    if (actor === null || actor.kind !== 'operator') {
      return reply.code(401).send({ code: 'operator_auth_required' })
    }
    const id = (request.params as { id: string }).id
    const operator = store.operators.get(id)
    if (operator === undefined) return reply.code(404).send({ code: 'operator_not_found' })

    const signals = detectSignals(
      {
        operator,
        workers: workersOf(store, id),
        stats: [...store.stats.values()],
        accesses: store.accesses,
      },
      deps.now(),
    )
    return { signals }
  })

  app.get('/operators/:id/administration', async (request, reply) => {
    const actor = actorOf(request)
    if (actor === null || actor.kind !== 'operator') {
      return reply.code(401).send({ code: 'operator_auth_required' })
    }
    const id = (request.params as { id: string }).id
    const operator = store.operators.get(id)
    if (operator === undefined) return reply.code(404).send({ code: 'operator_not_found' })

    const records = [...store.bookings.values()]
      .filter((b) => b.operatorId === id)
      .map((b) =>
        toAdministrationRecord(
          b,
          operator.vergunningNumber,
          b.workerId === null ? 'unassigned' : pseudonymFor(b.workerId, deps.pseudonymKey),
        ),
      )
    return { vergunningNumber: operator.vergunningNumber, records }
  })

  async function workerTransition(
    request: FastifyRequest,
    reply: FastifyReply,
    fn: (id: string, workerId: Uuid) => ServiceResult<unknown>,
  ) {
    const actor = actorOf(request)
    if (actor === null || actor.kind !== 'worker') {
      return reply.code(401).send({ code: 'worker_auth_required' })
    }
    const id = (request.params as { id: string }).id
    const result = fn(id, actor.id)
    if (!result.ok) return sendError(reply, result)
    return { ok: true }
  }

  return app
}

function sendError(reply: FastifyReply, result: Extract<ServiceResult<unknown>, { ok: false }>) {
  return reply.code(result.status).send({ code: result.code, message: result.message })
}
