import { randomUUID } from 'node:crypto'
import { applyCommand, type BookingCommand } from '../domain/booking.js'
import type {
  Booking,
  BookingLocation,
  EscalationContact,
  IsoDateTime,
  Uuid,
} from '../domain/types.js'
import { screen, type ScreeningReport } from '../policy/screening.js'
import type { MunicipalityRegistry } from '../policy/municipality.js'
import { detectSignals, DEFAULT_THRESHOLDS } from '../risk/indicators.js'
import { checkIn, checkOut, openSession } from '../safety/session.js'
import {
  availabilityOf,
  workersOf,
  type Store,
} from '../store/memory.js'
import { localHourNL } from '../util/time.js'

export interface ServiceConfig {
  registry: MunicipalityRegistry
  /** Minutes past the expected end before a silent session escalates. */
  safetyGraceMinutes: number
  /** Travel allowance before a departed-but-never-arrived worker escalates. */
  checkInGraceMinutes: number
  now: () => IsoDateTime
}

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string; detail?: unknown }

function err<T>(status: number, code: string, message: string, detail?: unknown): ServiceResult<T> {
  return detail === undefined
    ? { ok: false, status, code, message }
    : { ok: false, status, code, message, detail }
}

export interface CreateBookingInput {
  operatorId: Uuid
  clientId: Uuid
  requestedStart: IsoDateTime
  durationMinutes: number
  location: BookingLocation
  requestedServices: string[]
  agreedRateCents: number
}

export class BookingService {
  constructor(
    private readonly store: Store,
    private readonly config: ServiceConfig,
  ) {}

  /**
   * Create a request and run it through screening immediately. The client never
   * sees a pending state where a worker might be pressured into it later --
   * either the request is offerable now or it is refused now.
   */
  createBooking(input: CreateBookingInput): ServiceResult<{ booking: Booking; report: ScreeningReport }> {
    const now = this.config.now()
    const operator = this.store.operators.get(input.operatorId)
    if (operator === undefined) return err(404, 'operator_not_found', 'Unknown operator.')

    const client = this.store.clients.get(input.clientId)
    if (client === undefined) return err(404, 'client_not_found', 'Unknown client.')

    let booking: Booking = {
      id: randomUUID(),
      operatorId: input.operatorId,
      clientId: input.clientId,
      workerId: null,
      status: 'requested',
      requestedStart: input.requestedStart,
      durationMinutes: input.durationMinutes,
      location: input.location,
      requestedServices: input.requestedServices,
      agreedRateCents: input.agreedRateCents,
      createdAt: now,
      history: [{ at: now, status: 'requested', actor: { kind: 'client', id: input.clientId }, reason: null }],
    }

    booking = this.mustApply(booking, { type: 'begin_screening' }, now)

    const workers = workersOf(this.store, input.operatorId)
    const report = screen({
      booking,
      operator,
      client,
      candidates: workers,
      availability: availabilityOf(this.store, input.operatorId),
      signals: detectSignals(
        {
          operator,
          workers,
          stats: [...this.store.stats.values()],
          accesses: this.store.accesses,
        },
        now,
        DEFAULT_THRESHOLDS,
      ),
      registry: this.config.registry,
      now,
      localHourOf: localHourNL,
    })

    if (report.outcome.decision === 'block') {
      const reason = report.outcome.blockers.map((b) => b.code).join(', ')
      booking = this.mustApply(booking, { type: 'screening_failed', reason }, now)
      this.store.bookings.set(booking.id, booking)
      return { ok: true, value: { booking, report } }
    }

    booking = this.mustApply(booking, { type: 'screening_passed' }, now)
    this.store.bookings.set(booking.id, booking)
    return { ok: true, value: { booking, report } }
  }

  /** Every worker-facing and client-facing transition funnels through here. */
  command(bookingId: Uuid, command: BookingCommand): ServiceResult<Booking> {
    const now = this.config.now()
    const booking = this.store.bookings.get(bookingId)
    if (booking === undefined) return err(404, 'booking_not_found', 'Unknown booking.')

    const result = applyCommand(booking, command, now)
    if (!result.ok) return err(409, result.code, result.message)

    this.store.bookings.set(result.booking.id, result.booking)
    this.recordOfferOutcome(command)
    return { ok: true, value: result.booking }
  }

  /**
   * Worker departs: the booking advances *and* a safety session opens in the
   * same call. These are deliberately not separable -- there is no code path
   * that lets a worker travel to a booking without cover, because the one time
   * it matters will be the time someone skipped the optional step.
   */
  depart(
    bookingId: Uuid,
    workerId: Uuid,
    contacts: EscalationContact[],
  ): ServiceResult<{ booking: Booking; safetySessionId: Uuid }> {
    const now = this.config.now()
    const advanced = this.command(bookingId, { type: 'worker_depart', workerId })
    if (!advanced.ok) return advanced

    const session = openSession({
      id: randomUUID(),
      bookingId,
      workerId,
      durationMinutes: advanced.value.durationMinutes,
      graceMinutes: this.config.safetyGraceMinutes,
      contacts,
      now,
    })

    if (!session.ok) {
      // Roll the booking back rather than leave it en route with no cover.
      this.store.bookings.set(bookingId, this.store.bookings.get(bookingId)!)
      const reverted = { ...advanced.value, status: 'confirmed' as const }
      this.store.bookings.set(bookingId, reverted)
      return err(400, session.code, session.message)
    }

    this.store.safetySessions.set(session.session.id, session.session)
    return { ok: true, value: { booking: advanced.value, safetySessionId: session.session.id } }
  }

  /** Worker arrives: booking goes in_progress and the safety session checks in. */
  arrive(bookingId: Uuid, workerId: Uuid): ServiceResult<Booking> {
    const now = this.config.now()
    const advanced = this.command(bookingId, { type: 'worker_arrive', workerId })
    if (!advanced.ok) return advanced

    const session = this.sessionForBooking(bookingId)
    if (session !== undefined) {
      const result = checkIn(session, workerId, now)
      if (result.ok) this.store.safetySessions.set(result.session.id, result.session)
    }
    return advanced
  }

  /** Worker completes: booking completes and the safety session closes. */
  complete(bookingId: Uuid, workerId: Uuid): ServiceResult<Booking> {
    const now = this.config.now()
    const advanced = this.command(bookingId, { type: 'worker_complete', workerId })
    if (!advanced.ok) return advanced
    this.closeSession(bookingId, workerId, now)
    return advanced
  }

  /** Worker withdraws. Always permitted, never penalised, session closed. */
  workerCancel(bookingId: Uuid, workerId: Uuid, reason: string | null): ServiceResult<Booking> {
    const now = this.config.now()
    const advanced = this.command(bookingId, { type: 'worker_cancel', workerId, reason })
    if (!advanced.ok) return advanced
    this.closeSession(bookingId, workerId, now)
    return advanced
  }

  sessionForBooking(bookingId: Uuid) {
    return [...this.store.safetySessions.values()].find((s) => s.bookingId === bookingId)
  }

  private closeSession(bookingId: Uuid, workerId: Uuid, now: IsoDateTime): void {
    const session = this.sessionForBooking(bookingId)
    if (session === undefined) return
    const result = checkOut(session, workerId, now)
    if (result.ok) this.store.safetySessions.set(result.session.id, result.session)
  }

  /**
   * Offer counters feed the "never declines" indicator. Declines are counted
   * but never surfaced to the client or held against the worker.
   */
  private recordOfferOutcome(command: BookingCommand): void {
    if (command.type !== 'worker_accept' && command.type !== 'worker_decline') return
    const existing = this.store.stats.get(command.workerId) ?? {
      workerId: command.workerId,
      offersReceived: 0,
      offersAccepted: 0,
      offersDeclined: 0,
      longestConsecutiveHours: 0,
      overnightBookings: 0,
    }
    this.store.stats.set(command.workerId, {
      ...existing,
      offersReceived: existing.offersReceived + 1,
      offersAccepted: existing.offersAccepted + (command.type === 'worker_accept' ? 1 : 0),
      offersDeclined: existing.offersDeclined + (command.type === 'worker_decline' ? 1 : 0),
    })
  }

  private mustApply(booking: Booking, command: BookingCommand, now: IsoDateTime): Booking {
    const result = applyCommand(booking, command, now)
    if (!result.ok) {
      throw new Error(`Internal state machine error: ${result.code} -- ${result.message}`)
    }
    return result.booking
  }
}
