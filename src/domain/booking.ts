import type {
  Actor,
  Booking,
  BookingStatus,
  IsoDateTime,
  Uuid,
  Worker,
} from './types.js'

/**
 * The booking lifecycle.
 *
 * Two invariants carry the whole design, and both are enforced here rather than
 * in the UI, because a rule that lives in the UI is a rule that an internal tool
 * or a future endpoint will quietly bypass:
 *
 *  1. Only the worker can accept. There is no operator override, no
 *     auto-assign, no "nearest available" dispatch. A request becomes work
 *     when a specific person says yes to it, and not a moment earlier.
 *
 *  2. The worker can withdraw at any point up to and including `in_progress`.
 *     Consent to a booking is not consent to the rest of it. There is
 *     deliberately no cancellation-penalty field anywhere in this module --
 *     a financial penalty for stopping is a coercion mechanism, and a platform
 *     that charges for it is the thing we are trying not to build.
 */

export type BookingCommand =
  | { type: 'begin_screening' }
  | { type: 'screening_passed' }
  | { type: 'screening_failed'; reason: string }
  | { type: 'offer_expired' }
  | { type: 'worker_accept'; workerId: Uuid }
  | { type: 'worker_decline'; workerId: Uuid; reason: string | null }
  | { type: 'client_confirm'; clientId: Uuid }
  | { type: 'worker_depart'; workerId: Uuid }
  | { type: 'worker_arrive'; workerId: Uuid }
  | { type: 'worker_complete'; workerId: Uuid }
  | { type: 'worker_cancel'; workerId: Uuid; reason: string | null }
  | { type: 'client_cancel'; clientId: Uuid; reason: string | null }

export type TransitionResult =
  | { ok: true; booking: Booking }
  | { ok: false; code: string; message: string }

const TERMINAL: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  'completed',
  'declined_by_worker',
  'cancelled_by_worker',
  'cancelled_by_client',
  'blocked_by_compliance',
  'expired',
])

export function isTerminal(status: BookingStatus): boolean {
  return TERMINAL.has(status)
}

/**
 * States from which the assigned worker may walk away. This is every
 * non-terminal state they can reach -- including `in_progress`, which is the
 * one that actually matters.
 */
const WORKER_MAY_CANCEL_FROM: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  'accepted',
  'confirmed',
  'en_route',
  'in_progress',
])

/**
 * States from which the client may cancel. Note `in_progress` is absent: once
 * the worker has arrived, the client cancelling is not a cancellation, it is a
 * payment dispute, and it is handled as one.
 */
const CLIENT_MAY_CANCEL_FROM: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  'requested',
  'screening',
  'offered',
  'accepted',
  'confirmed',
  'en_route',
])

function reject(code: string, message: string): TransitionResult {
  return { ok: false, code, message }
}

function advance(
  booking: Booking,
  status: BookingStatus,
  actor: Actor,
  at: IsoDateTime,
  reason: string | null,
  patch: Partial<Booking> = {},
): TransitionResult {
  return {
    ok: true,
    booking: {
      ...booking,
      ...patch,
      status,
      history: [...booking.history, { at, status, actor, reason }],
    },
  }
}

function wrongState(command: BookingCommand, booking: Booking): TransitionResult {
  return reject(
    'invalid_transition',
    `Cannot apply "${command.type}" to a booking in state "${booking.status}".`,
  )
}

export function applyCommand(
  booking: Booking,
  command: BookingCommand,
  at: IsoDateTime,
): TransitionResult {
  if (isTerminal(booking.status)) {
    return reject(
      'booking_terminal',
      `Booking is already in terminal state "${booking.status}".`,
    )
  }

  switch (command.type) {
    case 'begin_screening': {
      if (booking.status !== 'requested') return wrongState(command, booking)
      return advance(booking, 'screening', { kind: 'system' }, at, null)
    }

    case 'screening_passed': {
      if (booking.status !== 'screening') return wrongState(command, booking)
      return advance(booking, 'offered', { kind: 'system' }, at, null)
    }

    case 'screening_failed': {
      if (booking.status !== 'screening') return wrongState(command, booking)
      return advance(booking, 'blocked_by_compliance', { kind: 'system' }, at, command.reason)
    }

    case 'offer_expired': {
      // Silence from a worker is a "no". An unanswered offer must never decay
      // into an assignment.
      if (booking.status !== 'offered') return wrongState(command, booking)
      return advance(booking, 'expired', { kind: 'system' }, at, 'Offer expired unanswered.')
    }

    case 'worker_accept': {
      if (booking.status !== 'offered') return wrongState(command, booking)
      if (booking.workerId !== null && booking.workerId !== command.workerId) {
        return reject(
          'already_assigned',
          'This booking has already been accepted by another worker.',
        )
      }
      return advance(
        booking,
        'accepted',
        { kind: 'worker', id: command.workerId },
        at,
        null,
        { workerId: command.workerId },
      )
    }

    case 'worker_decline': {
      if (booking.status !== 'offered') return wrongState(command, booking)
      // A decline is never recorded against the worker anywhere. It ends this
      // booking and nothing else.
      return advance(
        booking,
        'declined_by_worker',
        { kind: 'worker', id: command.workerId },
        at,
        command.reason,
      )
    }

    case 'client_confirm': {
      if (booking.status !== 'accepted') return wrongState(command, booking)
      if (booking.clientId !== command.clientId) {
        return reject('wrong_client', 'This booking belongs to a different client.')
      }
      return advance(booking, 'confirmed', { kind: 'client', id: command.clientId }, at, null)
    }

    case 'worker_depart': {
      if (booking.status !== 'confirmed') return wrongState(command, booking)
      const guard = requireAssignedWorker(booking, command.workerId)
      if (guard) return guard
      return advance(booking, 'en_route', { kind: 'worker', id: command.workerId }, at, null)
    }

    case 'worker_arrive': {
      if (booking.status !== 'en_route') return wrongState(command, booking)
      const guard = requireAssignedWorker(booking, command.workerId)
      if (guard) return guard
      return advance(booking, 'in_progress', { kind: 'worker', id: command.workerId }, at, null)
    }

    case 'worker_complete': {
      if (booking.status !== 'in_progress') return wrongState(command, booking)
      const guard = requireAssignedWorker(booking, command.workerId)
      if (guard) return guard
      return advance(booking, 'completed', { kind: 'worker', id: command.workerId }, at, null)
    }

    case 'worker_cancel': {
      if (!WORKER_MAY_CANCEL_FROM.has(booking.status)) return wrongState(command, booking)
      const guard = requireAssignedWorker(booking, command.workerId)
      if (guard) return guard
      // No penalty, no reason required, no appeal by the operator.
      return advance(
        booking,
        'cancelled_by_worker',
        { kind: 'worker', id: command.workerId },
        at,
        command.reason,
      )
    }

    case 'client_cancel': {
      if (!CLIENT_MAY_CANCEL_FROM.has(booking.status)) return wrongState(command, booking)
      if (booking.clientId !== command.clientId) {
        return reject('wrong_client', 'This booking belongs to a different client.')
      }
      return advance(
        booking,
        'cancelled_by_client',
        { kind: 'client', id: command.clientId },
        at,
        command.reason,
      )
    }
  }
}

function requireAssignedWorker(booking: Booking, workerId: Uuid): TransitionResult | null {
  if (booking.workerId === null) {
    return reject('no_worker_assigned', 'No worker has accepted this booking yet.')
  }
  if (booking.workerId !== workerId) {
    return reject('not_assigned_worker', 'Only the worker assigned to this booking may act on it.')
  }
  return null
}

// ---------------------------------------------------------------------------
// Boundary matching
// ---------------------------------------------------------------------------

export interface BoundaryViolation {
  code: string
  message: string
}

/**
 * Checked *before* a request is ever shown to a worker. The point is that a
 * worker should not have to repeatedly decline requests that cross limits they
 * already stated -- being asked over and over is itself a pressure tactic, and
 * filtering it out is the platform's job.
 *
 * `localHourOf` is injected so the caller decides the timezone rather than
 * this module assuming Europe/Amsterdam.
 */
export function findBoundaryViolations(
  worker: Worker,
  booking: Pick<Booking, 'requestedServices' | 'durationMinutes' | 'location' | 'requestedStart'>,
  localHourOf: (at: IsoDateTime) => number,
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = []
  const b = worker.boundaries

  const refused = new Set(b.refusedServices.map((s) => s.toLowerCase()))
  for (const service of booking.requestedServices) {
    if (refused.has(service.toLowerCase())) {
      violations.push({
        code: 'refused_service',
        message: `Worker does not offer "${service}".`,
      })
    }
  }

  if (booking.durationMinutes > b.maxBookingMinutes) {
    violations.push({
      code: 'duration_too_long',
      message: `Requested ${booking.durationMinutes} minutes; worker's maximum is ${b.maxBookingMinutes}.`,
    })
  }

  if (!b.allowedLocationTypes.includes(booking.location.type)) {
    violations.push({
      code: 'location_type_not_allowed',
      message: `Worker does not attend locations of type "${booking.location.type}".`,
    })
  }

  if (!worker.servesMunicipalities.includes(booking.location.municipality)) {
    violations.push({
      code: 'municipality_not_served',
      message: `Worker does not travel to ${booking.location.municipality}.`,
    })
  }

  const hour = localHourOf(booking.requestedStart)
  if (!isWithinHourWindow(hour, b.earliestStartHour, b.latestStartHour)) {
    violations.push({
      code: 'outside_working_hours',
      message: `Start hour ${hour}:00 is outside the worker's window ${b.earliestStartHour}:00-${b.latestStartHour}:00.`,
    })
  }

  return violations
}

/** Handles windows that wrap past midnight, e.g. 20:00-04:00. */
function isWithinHourWindow(hour: number, earliest: number, latest: number): boolean {
  if (earliest <= latest) return hour >= earliest && hour <= latest
  return hour >= earliest || hour <= latest
}
