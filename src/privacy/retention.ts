import type { Booking, IsoDateTime, Uuid } from '../domain/types.js'
import type { MunicipalityRules } from '../policy/municipality.js'

/**
 * Retention and redaction.
 *
 * There is a real conflict to resolve here, and pretending otherwise is how
 * platforms in this space end up holding a catastrophic database. The gemeente
 * requires the operator to keep a booking administration available for
 * inspection. The AVG requires data minimisation -- and the fact that a named
 * person did sex work is Article 9 special-category data (it concerns their sex
 * life), which carries the strictest regime there is.
 *
 * A leak of this database does not cost money. It outs people to families,
 * employers, immigration authorities and abusive ex-partners, and it is not
 * recoverable. Encryption at rest does not help when the application itself is
 * the thing that gets breached.
 *
 * The resolution is two tiers with different clocks:
 *
 *   Tier 1 -- the administration record. Only what the gemeente actually needs
 *     to verify that licensed work happened: date, duration, municipality,
 *     vergunning number, and a per-worker pseudonym. Kept for the municipal
 *     retention period. It identifies nobody on its own.
 *
 *   Tier 2 -- operational detail. Addresses, client identity, phone numbers,
 *     requested services. Needed to run the booking and to investigate an
 *     incident; needed by nobody afterwards. Redacted on a short clock.
 *
 * The worker's real name never appears in either tier. It lives only in the
 * verification record, which is the one place that genuinely needs it.
 */

export interface AdministrationRecord {
  bookingId: Uuid
  vergunningNumber: string
  municipality: string
  /** Stable pseudonym, resolvable to a worker only via the identity store. */
  workerPseudonym: string
  date: string // YYYY-MM-DD
  durationMinutes: number
  status: string
  completedAt: IsoDateTime | null
}

/** How long tier-2 operational detail survives after a booking ends. */
export const OPERATIONAL_DETAIL_RETENTION_DAYS = 30

export function toAdministrationRecord(
  booking: Booking,
  vergunningNumber: string,
  workerPseudonym: string,
): AdministrationRecord {
  const completed = booking.history.find((e) => e.status === 'completed')
  return {
    bookingId: booking.id,
    vergunningNumber,
    municipality: booking.location.municipality,
    workerPseudonym,
    date: booking.requestedStart.slice(0, 10),
    durationMinutes: booking.durationMinutes,
    status: booking.status,
    completedAt: completed?.at ?? null,
  }
}

const DAY_MS = 86_400_000

function daysBetween(from: IsoDateTime, to: IsoDateTime): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / DAY_MS
}

/** Has tier-2 detail outlived its purpose? */
export function isDueForRedaction(booking: Booking, now: IsoDateTime): boolean {
  const ended = lastEventAt(booking)
  if (ended === null) return false
  return daysBetween(ended, now) >= OPERATIONAL_DETAIL_RETENTION_DAYS
}

/** Has even the administration record outlived the municipal duty? */
export function isDueForDeletion(
  record: AdministrationRecord,
  rules: MunicipalityRules,
  now: IsoDateTime,
): boolean {
  return daysBetween(`${record.date}T00:00:00Z`, now) >= rules.administrationRetentionDays
}

/**
 * Strips tier-2 detail in place of the original, keeping the record countable
 * but no longer personal. Idempotent.
 */
export function redactOperationalDetail(booking: Booking): Booking {
  return {
    ...booking,
    location: {
      ...booking.location,
      addressLine: '[redacted]',
      // The first two digits of a Dutch postcode identify a region, not a
      // street, which is enough for the administration and not enough to
      // find anyone.
      postalCode: `${booking.location.postalCode.slice(0, 2)}[redacted]`,
      venueName: null,
    },
    requestedServices: [],
    history: booking.history.map((event) => ({ ...event, reason: null })),
  }
}

function lastEventAt(booking: Booking): IsoDateTime | null {
  const last = booking.history.at(-1)
  return last?.at ?? null
}

/**
 * A worker leaving must be able to take their history with them and leave
 * nothing exploitable behind. Exercising this is never a penalty and never
 * needs the operator's approval: a worker who cannot leave cleanly is a worker
 * with a reason to stay.
 */
export interface OffboardingPlan {
  workerId: Uuid
  /** Redacted immediately on offboarding. */
  redactImmediately: string[]
  /** Retained, with the reason it must be, and for how long. */
  retained: { item: string; reason: string; untilDays: number }[]
}

export function planOffboarding(workerId: Uuid, rules: MunicipalityRules): OffboardingPlan {
  return {
    workerId,
    redactImmediately: [
      'directPhone',
      'payoutIban',
      'boundaries',
      'availability windows',
      'device fingerprints',
      'escalation contacts',
    ],
    retained: [
      {
        item: 'identity verification record (date of birth, right-to-work flag, document hash)',
        reason:
          'Proves to the gemeente that the operator verified age and right to work. Without it ' +
          'the operator cannot answer the one question an inspection always asks.',
        untilDays: rules.administrationRetentionDays,
      },
      {
        item: 'pseudonymised administration records',
        reason: 'Municipal booking administration duty.',
        untilDays: rules.administrationRetentionDays,
      },
    ],
  }
}
