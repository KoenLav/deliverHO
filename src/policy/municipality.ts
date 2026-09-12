import type { MunicipalityCode } from '../domain/types.js'

/**
 * Licensing rules for sex work in the Netherlands are set per gemeente in the
 * APV, on top of a thin national layer. They differ in ways that matter: the
 * minimum working age is 18 nationally but 21 under many municipal APVs, and
 * the pending Wet regulering sekswerk would move more of this to national law.
 *
 * So none of it is hardcoded. Each gemeente you operate in gets a rule set,
 * verified against that gemeente's current APV by someone qualified to read it.
 * The defaults below are deliberately the strictest common denominator: if a
 * rule set is missing, the platform refuses to operate rather than guessing.
 */
export interface MunicipalityRules {
  code: MunicipalityCode
  /** Minimum age to work. 21 in Amsterdam, Utrecht, Rotterdam and others. */
  minimumWorkerAge: number
  /** Every advertisement must display the vergunning number. */
  requireVergunningInAdvertising: boolean
  /** May bookings be taken at a client's private residence? */
  allowPrivateResidenceBookings: boolean
  /**
   * How long the booking administration must be retained for inspection.
   * This is in tension with AVG minimisation; see docs/data-protection.md.
   */
  administrationRetentionDays: number
  /** Intake interview must be conducted with the worker alone. */
  requireIntakeInterview: boolean
  /** Operator must be able to produce the administration on demand. */
  requireBookingAdministration: boolean
  /** Human-readable pointer to the source, for the compliance audit. */
  sourceReference: string
}

/**
 * The conservative fallback. Every field is at least as strict as any gemeente
 * we know of, so an unconfigured municipality fails closed rather than open.
 */
export const STRICT_DEFAULTS: Omit<MunicipalityRules, 'code' | 'sourceReference'> = {
  minimumWorkerAge: 21,
  requireVergunningInAdvertising: true,
  allowPrivateResidenceBookings: false,
  administrationRetentionDays: 365,
  requireIntakeInterview: true,
  requireBookingAdministration: true,
}

export class MunicipalityRegistry {
  readonly #rules = new Map<MunicipalityCode, MunicipalityRules>()

  register(rules: MunicipalityRules): void {
    this.#rules.set(rules.code, rules)
  }

  /**
   * Returns null for an unconfigured gemeente. Callers must treat null as
   * "cannot operate here" -- never as "no restrictions".
   */
  get(code: MunicipalityCode): MunicipalityRules | null {
    return this.#rules.get(code) ?? null
  }

  has(code: MunicipalityCode): boolean {
    return this.#rules.has(code)
  }

  list(): MunicipalityRules[] {
    return [...this.#rules.values()]
  }
}

/**
 * Seed data for local development only.
 *
 * These values are a plausible reading of the current APVs, not legal advice,
 * and APVs are amended regularly. Before going live in any gemeente, have the
 * rule set checked against that gemeente's current APV and replace
 * `sourceReference` with the article you actually relied on.
 */
export function developmentRegistry(): MunicipalityRegistry {
  const registry = new MunicipalityRegistry()

  registry.register({
    code: 'GM0363', // Amsterdam
    ...STRICT_DEFAULTS,
    minimumWorkerAge: 21,
    allowPrivateResidenceBookings: true,
    sourceReference: 'UNVERIFIED: APV Amsterdam, hoofdstuk 3 -- confirm before production use',
  })

  registry.register({
    code: 'GM0599', // Rotterdam
    ...STRICT_DEFAULTS,
    minimumWorkerAge: 21,
    allowPrivateResidenceBookings: true,
    sourceReference: 'UNVERIFIED: APV Rotterdam, hoofdstuk 3 -- confirm before production use',
  })

  registry.register({
    code: 'GM0344', // Utrecht
    ...STRICT_DEFAULTS,
    minimumWorkerAge: 21,
    sourceReference: 'UNVERIFIED: APV Utrecht, hoofdstuk 3 -- confirm before production use',
  })

  return registry
}
