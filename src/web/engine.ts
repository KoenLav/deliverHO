/**
 * Browser entry point.
 *
 * Re-exports the real domain, policy, safety and risk modules so a page can
 * drive the actual engine rather than a re-implementation of it. Everything
 * below is the same code the test suite covers -- no mock, no parallel
 * implementation that can drift.
 *
 * Only `pseudonymFor` differs: the server version uses node:crypto, so the
 * browser gets a Web Crypto equivalent with the same construction (HMAC-SHA256,
 * truncated base64url).
 */
export {
  applyCommand,
  findBoundaryViolations,
  isTerminal,
  type BookingCommand,
  type TransitionResult,
} from '../domain/booking.js'

export { screen, type ScreeningReport } from '../policy/screening.js'
export { checkOperator, checkWorker, ageInYearsAt } from '../policy/eligibility.js'
export {
  MunicipalityRegistry,
  STRICT_DEFAULTS,
  type MunicipalityRules,
} from '../policy/municipality.js'

export {
  openSession,
  checkIn,
  checkOut,
  extend,
  panic,
  operatorEscalate,
  sweep,
  applyEscalation,
} from '../safety/session.js'

export {
  detectSignals,
  blockingSignalsFor,
  DEFAULT_THRESHOLDS,
  type CohortSnapshot,
  type WorkerBookingStats,
} from '../risk/indicators.js'

export {
  toAdministrationRecord,
  redactOperationalDetail,
  isDueForRedaction,
} from '../privacy/retention.js'

export type * from '../domain/types.js'

/** HMAC-SHA256 pseudonym, matching src/store/pseudonym.ts. */
export async function pseudonymFor(workerId: string, key: string): Promise<string> {
  if (key.length < 32) throw new Error('Pseudonym key must be at least 32 characters.')
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(workerId))
  let binary = ''
  const bytes = new Uint8Array(sig)
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 16)
}
