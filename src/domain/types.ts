/**
 * Core domain types.
 *
 * Vocabulary note: the operator is an "escortbedrijf" under Dutch municipal
 * licensing (APV). The people doing the work are `Worker`s and are, in almost
 * every Dutch arrangement, self-employed (zzp) contractors rather than
 * employees. That distinction is not cosmetic -- it is why the worker, and
 * never the operator, holds the accept/decline on every booking.
 */

export type Uuid = string
export type IsoDateTime = string

/** Dutch municipality ("gemeente"). Licensing rules are municipal, not national. */
export type MunicipalityCode = string

// ---------------------------------------------------------------------------
// Operator
// ---------------------------------------------------------------------------

/**
 * The licensed business. Operating an escortbedrijf without a vergunning is an
 * offence, and it is the operator -- not the worker -- who is prosecuted for it.
 */
export interface Operator {
  id: Uuid
  legalName: string
  kvkNumber: string
  /** Municipal licence ("vergunning") number. Required in every advertisement. */
  vergunningNumber: string
  /** Municipality that issued the vergunning. */
  municipality: MunicipalityCode
  vergunningValidFrom: IsoDateTime
  vergunningValidUntil: IsoDateTime
  /** Set when the gemeente suspends or revokes; blocks all new bookings. */
  suspendedAt: IsoDateTime | null
  /** Named person responsible under the APV ("beheerder"). */
  beheerderName: string
  contactPhone: string
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export type VerificationMethod = 'idin' | 'passport_nfc' | 'in_person_document_check'

/**
 * Identity and age verification. Age is stored as a verified *threshold plus a
 * date of birth*, never as a copy of the identity document: retaining scans of
 * ID documents is both an AVG minimisation problem and a catastrophic breach
 * risk for this population.
 */
export interface IdentityVerification {
  method: VerificationMethod
  verifiedAt: IsoDateTime
  /** Who performed the check (beheerder user id, or the IDP name). */
  verifiedBy: string
  dateOfBirth: string // YYYY-MM-DD
  /** Nationality/residence check: is this person allowed to work in NL? */
  rightToWorkConfirmed: boolean
  /** Document number hash only. The document image is never stored. */
  documentReferenceHash: string
}

/**
 * The intake interview. Under the APV the beheerder must speak with the worker
 * alone, in a language they actually speak, before any work is arranged. Its
 * real function is detecting coercion, so the "alone" and "language" fields are
 * enforced rather than advisory.
 */
export interface IntakeInterview {
  conductedAt: IsoDateTime
  conductedBy: string
  /** BCP-47 tag of the language actually used. */
  language: string
  /** False if anyone accompanied the worker. A false here blocks onboarding. */
  conductedAlone: boolean
  /** Worker was informed of exit programmes ("uitstapprogramma"). */
  exitProgrammeInformationGiven: boolean
  /** Free-text concerns raised by the interviewer. */
  concerns: string | null
}

export type WorkerStatus =
  | 'pending_verification'
  | 'active'
  | 'paused_by_worker'
  | 'suspended_by_operator'
  | 'offboarded'

export interface Worker {
  id: Uuid
  operatorId: Uuid
  /** Working name. The legal name lives only in the verification record. */
  displayName: string
  status: WorkerStatus
  identity: IdentityVerification | null
  intake: IntakeInterview | null
  /** Municipalities this worker has agreed to travel to. */
  servesMunicipalities: MunicipalityCode[]
  /** Contact number that reaches the worker directly, not an intermediary. */
  directPhone: string
  /**
   * Payout account. Deliberately per-worker: a shared IBAN across workers is
   * one of the strongest coercion signals there is, and `risk/indicators`
   * checks for exactly that.
   */
  payoutIban: string
  /** Worker-defined hard limits. Bookings conflicting with these are refused. */
  boundaries: WorkerBoundaries
  createdAt: IsoDateTime
}

export interface WorkerBoundaries {
  /** Services the worker will not offer. Matched against booking requests. */
  refusedServices: string[]
  /** Latest hour (0-23, local) the worker accepts a booking to *start*. */
  latestStartHour: number
  /** Earliest hour (0-23, local) the worker accepts a booking to start. */
  earliestStartHour: number
  maxBookingMinutes: number
  /** Worker will only attend locations of these kinds. */
  allowedLocationTypes: LocationType[]
}

export type LocationType = 'hotel' | 'private_residence' | 'operator_premises'

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type ClientVerificationLevel =
  /** Phone number proven via OTP only. Cannot book a private residence. */
  | 'phone_verified'
  /** Bank-grade identity via iDIN. Required for first-time private bookings. */
  | 'idin_verified'

export interface Client {
  id: Uuid
  verificationLevel: ClientVerificationLevel
  phoneVerifiedAt: IsoDateTime | null
  idinVerifiedAt: IsoDateTime | null
  /** Set by a worker report or operator decision; blocks all booking attempts. */
  blockedAt: IsoDateTime | null
  blockedReason: string | null
  createdAt: IsoDateTime
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * A window the worker has published. Publishing availability is an offer to be
 * *asked*, never an offer to be booked: it never auto-confirms anything.
 */
export interface AvailabilityWindow {
  id: Uuid
  workerId: Uuid
  startsAt: IsoDateTime
  endsAt: IsoDateTime
  municipality: MunicipalityCode
  /** Withdrawn windows stop generating offers immediately. */
  withdrawnAt: IsoDateTime | null
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

export type BookingStatus =
  /** Client submitted a request. Nothing has been shown to any worker yet. */
  | 'requested'
  /** Compliance and screening gates are running. */
  | 'screening'
  /** Screening passed; the request is visible to the worker. */
  | 'offered'
  /** The worker -- personally -- accepted. */
  | 'accepted'
  /** Client confirmed after seeing the worker's terms. Travel may begin. */
  | 'confirmed'
  /** Worker has started travelling; safety session is open. */
  | 'en_route'
  /** Worker has checked in at the location. */
  | 'in_progress'
  | 'completed'
  | 'declined_by_worker'
  | 'cancelled_by_worker'
  | 'cancelled_by_client'
  | 'blocked_by_compliance'
  | 'expired'

export interface BookingLocation {
  type: LocationType
  municipality: MunicipalityCode
  /** Full address is released to the worker only once they have accepted. */
  addressLine: string
  postalCode: string
  /** Hotel bookings carry the venue name; private residences do not. */
  venueName: string | null
}

export interface Booking {
  id: Uuid
  operatorId: Uuid
  clientId: Uuid
  /** Null until a worker accepts. A request is never pre-assigned. */
  workerId: Uuid | null
  status: BookingStatus
  requestedStart: IsoDateTime
  durationMinutes: number
  location: BookingLocation
  /** Services requested, checked against the worker's refused list. */
  requestedServices: string[]
  agreedRateCents: number
  createdAt: IsoDateTime
  /** Append-only audit trail. Required for the municipal administration duty. */
  history: BookingEvent[]
}

export interface BookingEvent {
  at: IsoDateTime
  status: BookingStatus
  /** Who caused this transition. */
  actor: Actor
  reason: string | null
}

export type Actor =
  | { kind: 'worker'; id: Uuid }
  | { kind: 'client'; id: Uuid }
  | { kind: 'operator'; id: Uuid }
  | { kind: 'system' }

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

export type SafetySessionState = 'open' | 'checked_in' | 'closed' | 'escalated'

/**
 * Opened when a worker starts travelling and closed only by the worker. If the
 * expected check-out passes without the worker closing it, it escalates on its
 * own. The worker never has to *do* anything to raise an alarm -- silence is
 * the alarm. That inversion is the single most important design decision here.
 */
export interface SafetySession {
  id: Uuid
  bookingId: Uuid
  workerId: Uuid
  state: SafetySessionState
  openedAt: IsoDateTime
  checkedInAt: IsoDateTime | null
  /** Deadline for a voluntary check-out before escalation fires. */
  expectedCheckOutAt: IsoDateTime
  closedAt: IsoDateTime | null
  escalatedAt: IsoDateTime | null
  escalationReason: EscalationReason | null
  /** Who gets contacted, in order. */
  escalationContacts: EscalationContact[]
}

export type EscalationReason =
  | 'panic_button'
  | 'missed_checkout'
  | 'missed_checkin'
  | 'operator_initiated'

export interface EscalationContact {
  name: string
  phone: string
  /** Contacts are tried in ascending order. */
  order: number
  kind: 'operator_beheerder' | 'trusted_person' | 'emergency_services'
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

export type RiskSeverity = 'info' | 'review' | 'block'

export interface RiskSignal {
  code: string
  severity: RiskSeverity
  /** Human-readable, shown to the reviewing beheerder. */
  message: string
  subject: { kind: 'worker' | 'client' | 'booking'; id: Uuid }
  detectedAt: IsoDateTime
}
