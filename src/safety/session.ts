import type {
  EscalationContact,
  EscalationReason,
  IsoDateTime,
  SafetySession,
  Uuid,
} from '../domain/types.js'

/**
 * Safety sessions.
 *
 * The design rule: a worker in trouble may not be able to reach their phone,
 * may be watched, or may not be able to speak freely. So the alarm does not
 * require them to raise it. A session opens when they leave, and if they do not
 * close it themselves before the deadline, it escalates on its own. Doing
 * nothing triggers help; doing something (checking out) stands it down.
 *
 * A panic button exists too, but it is the secondary path, not the primary one.
 */

export interface OpenSessionInput {
  id: Uuid
  bookingId: Uuid
  workerId: Uuid
  /** Expected duration of the booking itself, excluding travel. */
  durationMinutes: number
  /** Slack added to the booking duration before escalation fires. */
  graceMinutes: number
  contacts: EscalationContact[]
  now: IsoDateTime
}

export type SafetyResult =
  | { ok: true; session: SafetySession }
  | { ok: false; code: string; message: string }

function reject(code: string, message: string): SafetyResult {
  return { ok: false, code, message }
}

function addMinutes(at: IsoDateTime, minutes: number): IsoDateTime {
  return new Date(new Date(at).getTime() + minutes * 60_000).toISOString()
}

export function openSession(input: OpenSessionInput): SafetyResult {
  if (input.contacts.length === 0) {
    // An escalation with nobody to escalate to is decoration. Refuse to open
    // the session rather than give the worker a false sense of cover.
    return reject(
      'no_escalation_contacts',
      'A safety session requires at least one escalation contact.',
    )
  }

  const sorted = [...input.contacts].sort((a, b) => a.order - b.order)

  return {
    ok: true,
    session: {
      id: input.id,
      bookingId: input.bookingId,
      workerId: input.workerId,
      state: 'open',
      openedAt: input.now,
      checkedInAt: null,
      expectedCheckOutAt: addMinutes(input.now, input.durationMinutes + input.graceMinutes),
      closedAt: null,
      escalatedAt: null,
      escalationReason: null,
      escalationContacts: sorted,
    },
  }
}

/** The worker confirms they have arrived and are safe. */
export function checkIn(session: SafetySession, workerId: Uuid, now: IsoDateTime): SafetyResult {
  const guard = requireOwner(session, workerId)
  if (guard) return guard
  if (session.state !== 'open') {
    return reject('invalid_state', `Cannot check in from state "${session.state}".`)
  }
  return { ok: true, session: { ...session, state: 'checked_in', checkedInAt: now } }
}

/**
 * The worker confirms they are out and safe. This is the only route to a clean
 * close -- the operator cannot close a session on the worker's behalf, because
 * a coercive operator would then simply close it for them.
 */
export function checkOut(session: SafetySession, workerId: Uuid, now: IsoDateTime): SafetyResult {
  const guard = requireOwner(session, workerId)
  if (guard) return guard
  if (session.state === 'closed') {
    return reject('already_closed', 'Session is already closed.')
  }
  if (session.state === 'escalated') {
    // Allowed on purpose: a worker standing down a false alarm must always be
    // able to, and the escalation stays in the record either way.
    return { ok: true, session: { ...session, state: 'closed', closedAt: now } }
  }
  return { ok: true, session: { ...session, state: 'closed', closedAt: now } }
}

/**
 * The worker pushes their own deadline out, e.g. the booking ran long. Bounded,
 * so an indefinite extension cannot be used to keep a session permanently
 * un-escalated.
 */
export function extend(
  session: SafetySession,
  workerId: Uuid,
  minutes: number,
  maxExtensionMinutes: number,
): SafetyResult {
  const guard = requireOwner(session, workerId)
  if (guard) return guard
  if (session.state === 'closed') {
    return reject('already_closed', 'Cannot extend a closed session.')
  }
  if (minutes <= 0 || minutes > maxExtensionMinutes) {
    return reject(
      'invalid_extension',
      `Extension must be between 1 and ${maxExtensionMinutes} minutes.`,
    )
  }
  return {
    ok: true,
    session: { ...session, expectedCheckOutAt: addMinutes(session.expectedCheckOutAt, minutes) },
  }
}

export function panic(session: SafetySession, workerId: Uuid, now: IsoDateTime): SafetyResult {
  const guard = requireOwner(session, workerId)
  if (guard) return guard
  if (session.state === 'closed') {
    return reject('already_closed', 'Session is already closed.')
  }
  return escalate(session, 'panic_button', now)
}

/** The operator can raise an alarm, but never lower one. */
export function operatorEscalate(session: SafetySession, now: IsoDateTime): SafetyResult {
  if (session.state === 'closed') {
    return reject('already_closed', 'Session is already closed.')
  }
  return escalate(session, 'operator_initiated', now)
}

function escalate(
  session: SafetySession,
  reason: EscalationReason,
  now: IsoDateTime,
): SafetyResult {
  if (session.state === 'escalated') {
    return { ok: true, session } // Idempotent; do not restart the contact ladder.
  }
  return {
    ok: true,
    session: { ...session, state: 'escalated', escalatedAt: now, escalationReason: reason },
  }
}

function requireOwner(session: SafetySession, workerId: Uuid): SafetyResult | null {
  if (session.workerId !== workerId) {
    return reject('not_session_owner', 'Only the worker this session belongs to may act on it.')
  }
  return null
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export interface DueEscalation {
  session: SafetySession
  reason: EscalationReason
  /** Contacts to call, already in order. */
  contacts: EscalationContact[]
}

/**
 * Run on a timer. Returns the sessions that have gone quiet past their
 * deadline, with the contact ladder to work through.
 *
 * `checkInGraceMinutes` covers the other failure mode: a worker who departs and
 * never checks in at all, which usually means something went wrong on the way
 * rather than at the booking.
 */
export function sweep(
  sessions: readonly SafetySession[],
  now: IsoDateTime,
  checkInGraceMinutes: number,
): DueEscalation[] {
  const t = new Date(now).getTime()
  const due: DueEscalation[] = []

  for (const session of sessions) {
    if (session.state === 'closed' || session.state === 'escalated') continue

    if (t >= new Date(session.expectedCheckOutAt).getTime()) {
      due.push({
        session,
        reason: 'missed_checkout',
        contacts: session.escalationContacts,
      })
      continue
    }

    if (
      session.state === 'open' &&
      t >= new Date(addMinutes(session.openedAt, checkInGraceMinutes)).getTime()
    ) {
      due.push({
        session,
        reason: 'missed_checkin',
        contacts: session.escalationContacts,
      })
    }
  }

  return due
}

/** Applies a swept escalation, producing the updated session to persist. */
export function applyEscalation(due: DueEscalation, now: IsoDateTime): SafetySession {
  const result = escalate(due.session, due.reason, now)
  return result.ok ? result.session : due.session
}
