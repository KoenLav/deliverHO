import type {
  AvailabilityWindow,
  Booking,
  Client,
  IsoDateTime,
  Operator,
  RiskSignal,
  Uuid,
  Worker,
} from '../domain/types.js'
import { findBoundaryViolations } from '../domain/booking.js'
import { blockingSignalsFor } from '../risk/indicators.js'
import { checkOperator, checkWorker, type Blocker } from './eligibility.js'
import type { MunicipalityRegistry } from './municipality.js'

/**
 * Screening runs between "a client asked" and "a worker is shown the request".
 * Everything that can refuse a booking refuses it here, before any worker has
 * to look at it and before any address is released.
 */

export interface ScreeningInput {
  booking: Booking
  operator: Operator
  client: Client
  /** Every worker on the operator's roster; filtering happens here. */
  candidates: readonly Worker[]
  /** Published, non-withdrawn availability windows. */
  availability: readonly AvailabilityWindow[]
  signals: readonly RiskSignal[]
  registry: MunicipalityRegistry
  now: IsoDateTime
  localHourOf: (at: IsoDateTime) => number
}

export type ScreeningOutcome =
  | { decision: 'offer'; workerIds: Uuid[] }
  | { decision: 'block'; blockers: Blocker[] }

export interface WorkerRejection {
  workerId: Uuid
  reasons: Blocker[]
}

export interface ScreeningReport {
  outcome: ScreeningOutcome
  /** Why each non-matching worker was excluded. For the beheerder, not the client. */
  rejections: WorkerRejection[]
}

export function screen(input: ScreeningInput): ScreeningReport {
  const { booking, operator, client, registry, now } = input
  const blockers: Blocker[] = []

  // 1. Is the business allowed to trade at all?
  blockers.push(...checkOperator(operator, now).blockers)

  // 2. Do we have verified rules for this gemeente? No rules means no trading
  //    there -- an unconfigured municipality fails closed.
  const rules = registry.get(booking.location.municipality)
  if (rules === null) {
    blockers.push({
      code: 'municipality_not_configured',
      message:
        `No licensing rule set is configured for gemeente ${booking.location.municipality}. ` +
        'Bookings there are refused until its APV has been reviewed.',
    })
  }

  // 3. Client-side gates.
  if (client.blockedAt !== null) {
    blockers.push({
      code: 'client_blocked',
      message: `Client is blocked: ${client.blockedReason ?? 'no reason recorded'}.`,
    })
  }
  if (client.phoneVerifiedAt === null) {
    blockers.push({
      code: 'client_unverified',
      message: 'Client has not completed phone verification.',
    })
  }

  if (rules !== null && booking.location.type === 'private_residence') {
    if (!rules.allowPrivateResidenceBookings) {
      blockers.push({
        code: 'private_residence_not_permitted',
        message: `Gemeente ${rules.code} does not permit bookings at private residences.`,
      })
    }
    // A worker going to a stranger's home is the highest-risk configuration in
    // the whole system. Bank-grade identity is the price of it.
    if (client.verificationLevel !== 'idin_verified') {
      blockers.push({
        code: 'idin_required_for_private_residence',
        message:
          'Bookings at a private residence require iDIN-verified client identity. ' +
          'Phone verification alone is not sufficient.',
      })
    }
  }

  if (booking.agreedRateCents <= 0) {
    blockers.push({
      code: 'rate_not_agreed',
      message: 'The rate must be agreed and recorded before a request is offered.',
    })
  }

  if (blockers.length > 0 || rules === null) {
    return { outcome: { decision: 'block', blockers }, rejections: [] }
  }

  // 4. Which workers may be shown this request?
  const offerable: Uuid[] = []
  const rejections: WorkerRejection[] = []

  for (const worker of input.candidates) {
    const reasons: Blocker[] = [...checkWorker(worker, rules, now).blockers]

    for (const signal of blockingSignalsFor(input.signals, worker.id)) {
      reasons.push({ code: `risk:${signal.code}`, message: signal.message })
    }

    for (const violation of findBoundaryViolations(worker, booking, input.localHourOf)) {
      reasons.push({ code: `boundary:${violation.code}`, message: violation.message })
    }

    if (!hasAvailability(input.availability, worker.id, booking, input.now)) {
      reasons.push({
        code: 'no_published_availability',
        message: 'Worker has not published availability covering this slot.',
      })
    }

    if (reasons.length === 0) offerable.push(worker.id)
    else rejections.push({ workerId: worker.id, reasons })
  }

  if (offerable.length === 0) {
    return {
      outcome: {
        decision: 'block',
        blockers: [
          {
            code: 'no_eligible_worker',
            message: 'No available worker matches this request.',
          },
        ],
      },
      rejections,
    }
  }

  return { outcome: { decision: 'offer', workerIds: offerable }, rejections }
}

/**
 * The request must sit entirely inside a published window that has not been
 * withdrawn. Withdrawal takes effect immediately: a worker who changes their
 * mind should not have to wait out a window they already published.
 */
function hasAvailability(
  windows: readonly AvailabilityWindow[],
  workerId: Uuid,
  booking: Pick<Booking, 'requestedStart' | 'durationMinutes'>,
  now: IsoDateTime,
): boolean {
  const start = new Date(booking.requestedStart).getTime()
  const end = start + booking.durationMinutes * 60_000
  const nowT = new Date(now).getTime()

  return windows.some((w) => {
    if (w.workerId !== workerId) return false
    if (w.withdrawnAt !== null && new Date(w.withdrawnAt).getTime() <= nowT) return false
    return new Date(w.startsAt).getTime() <= start && new Date(w.endsAt).getTime() >= end
  })
}
