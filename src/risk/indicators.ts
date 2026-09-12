import type { IsoDateTime, Operator, RiskSignal, Uuid, Worker } from '../domain/types.js'

/**
 * Coercion and trafficking indicators.
 *
 * This module is the reason the platform is defensible. A licensed operator's
 * actual legal and moral exposure is not "did a booking happen" -- it is
 * "was one of these people working for someone else's benefit under someone
 * else's control". The classic signals are structural and visible in ordinary
 * platform data: money converging on one account, one phone answering for
 * several workers, a worker who never says no.
 *
 * Two deliberate choices:
 *
 *  - Nothing here auto-punishes a worker. Signals route to a human beheerder,
 *    and `block` severity stops *bookings*, not the worker's account. Suspending
 *    someone's income on an algorithm's say-so is how you push a person who is
 *    already being controlled further out of reach.
 *
 *  - The detectors look at the operator and the platform as much as the worker.
 *    A worker whose registered phone is the beheerder's phone is not a
 *    suspicious worker; it is a suspicious operator.
 */

export interface WorkerBookingStats {
  workerId: Uuid
  offersReceived: number
  offersAccepted: number
  offersDeclined: number
  /** Longest run of consecutive working hours in the trailing window. */
  longestConsecutiveHours: number
  /** Bookings starting between 02:00 and 06:00 local, trailing window. */
  overnightBookings: number
}

/** One observed sign-in to a worker account. */
export interface AccountAccessRecord {
  workerId: Uuid
  /** Stable per-device value. Never a raw IP -- see docs/data-protection.md. */
  deviceFingerprint: string
  at: IsoDateTime
}

export interface CohortSnapshot {
  operator: Operator
  workers: readonly Worker[]
  stats: readonly WorkerBookingStats[]
  accesses: readonly AccountAccessRecord[]
  /** Residential address hashes, keyed by worker. Optional; often unknown. */
  registeredAddressHashes?: ReadonlyMap<Uuid, string>
}

export interface Thresholds {
  /** Offers seen before an acceptance rate becomes meaningful. */
  minOffersForRateSignal: number
  /** Acceptance rate at or above which "never declines" fires. */
  neverDeclinesRate: number
  /** Consecutive hours worked that trigger a welfare review. */
  excessiveConsecutiveHours: number
  /** Distinct worker accounts one device may touch before it looks like control. */
  maxWorkersPerDevice: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minOffersForRateSignal: 10,
  neverDeclinesRate: 1.0,
  excessiveConsecutiveHours: 12,
  maxWorkersPerDevice: 1,
}

export function detectSignals(
  snapshot: CohortSnapshot,
  now: IsoDateTime,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): RiskSignal[] {
  return [
    ...sharedPayoutAccounts(snapshot, now),
    ...sharedContactNumbers(snapshot, now),
    ...operatorPhoneAsWorkerPhone(snapshot, now),
    ...sharedDevices(snapshot, now, thresholds),
    ...neverDeclines(snapshot, now, thresholds),
    ...excessiveHours(snapshot, now, thresholds),
    ...intakeConcerns(snapshot, now),
    ...sharedRegisteredAddress(snapshot, now),
  ].sort(bySeverityDescending)
}

const SEVERITY_ORDER = { block: 0, review: 1, info: 2 } as const

function bySeverityDescending(a: RiskSignal, b: RiskSignal): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
}

/**
 * Several workers paid into one bank account. This is the single strongest
 * indicator of exploitation in the whole set: if the money does not reach the
 * person doing the work, very little else about the arrangement is voluntary.
 */
function sharedPayoutAccounts(snapshot: CohortSnapshot, now: IsoDateTime): RiskSignal[] {
  const byIban = groupBy(snapshot.workers, (w) => normalise(w.payoutIban))
  const signals: RiskSignal[] = []

  for (const [iban, workers] of byIban) {
    if (iban === '' || workers.length < 2) continue
    for (const worker of workers) {
      signals.push({
        code: 'shared_payout_iban',
        severity: 'block',
        message:
          `Payout account is shared with ${workers.length - 1} other worker(s): ` +
          `${workers.filter((w) => w.id !== worker.id).map((w) => w.displayName).join(', ')}. ` +
          'Earnings must be paid to the worker who performed the work.',
        subject: { kind: 'worker', id: worker.id },
        detectedAt: now,
      })
    }
  }
  return signals
}

/** One phone answering for several workers means one person speaking for them. */
function sharedContactNumbers(snapshot: CohortSnapshot, now: IsoDateTime): RiskSignal[] {
  const byPhone = groupBy(snapshot.workers, (w) => normalisePhone(w.directPhone))
  const signals: RiskSignal[] = []

  for (const [phone, workers] of byPhone) {
    if (phone === '' || workers.length < 2) continue
    for (const worker of workers) {
      signals.push({
        code: 'shared_contact_number',
        severity: 'block',
        message:
          `Direct contact number is shared with ${workers.length - 1} other worker(s). ` +
          'Each worker must be reachable on a number only they control.',
        subject: { kind: 'worker', id: worker.id },
        detectedAt: now,
      })
    }
  }
  return signals
}

/**
 * The worker's "direct" number is the operator's. Whatever the explanation, the
 * worker cannot be contacted without the operator hearing it.
 */
function operatorPhoneAsWorkerPhone(snapshot: CohortSnapshot, now: IsoDateTime): RiskSignal[] {
  const operatorPhone = normalisePhone(snapshot.operator.contactPhone)
  if (operatorPhone === '') return []

  return snapshot.workers
    .filter((w) => normalisePhone(w.directPhone) === operatorPhone)
    .map((w) => ({
      code: 'worker_phone_is_operator_phone',
      severity: 'block' as const,
      message:
        'Worker\'s direct number is the operator\'s own contact number. The worker cannot be ' +
        'reached independently of the operator.',
      subject: { kind: 'worker' as const, id: w.id },
      detectedAt: now,
    }))
}

/** One device signing into several worker accounts: someone is running them. */
function sharedDevices(
  snapshot: CohortSnapshot,
  now: IsoDateTime,
  thresholds: Thresholds,
): RiskSignal[] {
  const workersByDevice = new Map<string, Set<Uuid>>()
  for (const access of snapshot.accesses) {
    const set = workersByDevice.get(access.deviceFingerprint) ?? new Set<Uuid>()
    set.add(access.workerId)
    workersByDevice.set(access.deviceFingerprint, set)
  }

  const signals: RiskSignal[] = []
  for (const [device, workerIds] of workersByDevice) {
    if (workerIds.size <= thresholds.maxWorkersPerDevice) continue
    for (const workerId of workerIds) {
      signals.push({
        code: 'shared_device',
        severity: 'review',
        message:
          `Device ${device.slice(0, 8)}… has signed into ${workerIds.size} worker accounts. ` +
          'Confirm each worker controls their own account.',
        subject: { kind: 'worker', id: workerId },
        detectedAt: now,
      })
    }
  }
  return signals
}

/**
 * A worker who has never once declined. Free agents refuse work: it is too far,
 * too late, the client seems off. A perfect acceptance record over a meaningful
 * sample usually means the decision is not theirs.
 */
function neverDeclines(
  snapshot: CohortSnapshot,
  now: IsoDateTime,
  thresholds: Thresholds,
): RiskSignal[] {
  return snapshot.stats
    .filter((s) => s.offersReceived >= thresholds.minOffersForRateSignal)
    .filter((s) => s.offersReceived > 0 && s.offersAccepted / s.offersReceived >= thresholds.neverDeclinesRate)
    .map((s) => ({
      code: 'never_declines',
      severity: 'review' as const,
      message:
        `Accepted ${s.offersAccepted} of ${s.offersReceived} offers with no declines. ` +
        'Check privately that the worker knows they can refuse and that refusing costs them nothing.',
      subject: { kind: 'worker' as const, id: s.workerId },
      detectedAt: now,
    }))
}

function excessiveHours(
  snapshot: CohortSnapshot,
  now: IsoDateTime,
  thresholds: Thresholds,
): RiskSignal[] {
  return snapshot.stats
    .filter((s) => s.longestConsecutiveHours >= thresholds.excessiveConsecutiveHours)
    .map((s) => ({
      code: 'excessive_consecutive_hours',
      severity: 'review' as const,
      message:
        `Worked ${s.longestConsecutiveHours} consecutive hours. ` +
        'Debt-driven overwork is a control indicator as well as a welfare problem.',
      subject: { kind: 'worker' as const, id: s.workerId },
      detectedAt: now,
    }))
}

/** Whatever the interviewer wrote down stays visible until a human clears it. */
function intakeConcerns(snapshot: CohortSnapshot, now: IsoDateTime): RiskSignal[] {
  const signals: RiskSignal[] = []
  for (const worker of snapshot.workers) {
    const intake = worker.intake
    if (intake === null) continue

    if (!intake.conductedAlone) {
      signals.push({
        code: 'intake_not_alone',
        severity: 'block',
        message: 'Intake interview was conducted with someone else present.',
        subject: { kind: 'worker', id: worker.id },
        detectedAt: now,
      })
    }
    if (intake.concerns !== null && intake.concerns.trim() !== '') {
      signals.push({
        code: 'intake_concerns_recorded',
        severity: 'review',
        message: `Interviewer recorded a concern: "${intake.concerns}"`,
        subject: { kind: 'worker', id: worker.id },
        detectedAt: now,
      })
    }
  }
  return signals
}

function sharedRegisteredAddress(snapshot: CohortSnapshot, now: IsoDateTime): RiskSignal[] {
  const map = snapshot.registeredAddressHashes
  if (map === undefined) return []

  const byAddress = new Map<string, Uuid[]>()
  for (const [workerId, hash] of map) {
    if (hash === '') continue
    byAddress.set(hash, [...(byAddress.get(hash) ?? []), workerId])
  }

  const signals: RiskSignal[] = []
  for (const [, workerIds] of byAddress) {
    if (workerIds.length < 3) continue // Two people sharing a flat is ordinary.
    for (const workerId of workerIds) {
      signals.push({
        code: 'shared_registered_address',
        severity: 'review',
        message:
          `${workerIds.length} workers are registered at the same address. ` +
          'Common in exploitative housing arrangements; verify independently.',
        subject: { kind: 'worker', id: workerId },
        detectedAt: now,
      })
    }
  }
  return signals
}

// ---------------------------------------------------------------------------

/** Does anything here stop bookings from being offered for this worker? */
export function blockingSignalsFor(signals: readonly RiskSignal[], workerId: Uuid): RiskSignal[] {
  return signals.filter(
    (s) => s.severity === 'block' && s.subject.kind === 'worker' && s.subject.id === workerId,
  )
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    map.set(k, [...(map.get(k) ?? []), item])
  }
  return map
}

function normalise(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase()
}

/** Strips formatting so +31 6 1234 5678 and 0031612345678 compare equal. */
function normalisePhone(value: string): string {
  const digits = value.replace(/[^\d+]/g, '')
  if (digits.startsWith('+31')) return `+31${digits.slice(3).replace(/^0/, '')}`
  if (digits.startsWith('0031')) return `+31${digits.slice(4).replace(/^0/, '')}`
  if (digits.startsWith('0')) return `+31${digits.slice(1)}`
  return digits
}
