import type { Operator, Worker, IsoDateTime } from '../domain/types.js'
import type { MunicipalityRules } from './municipality.js'

/**
 * Every gate returns *all* the reasons it failed, not just the first. A worker
 * halfway through onboarding should see the whole remaining list at once
 * instead of discovering one blocker per attempt.
 */
export interface GateResult {
  ok: boolean
  blockers: Blocker[]
}

export interface Blocker {
  code: string
  message: string
}

const pass: GateResult = { ok: true, blockers: [] }

function fail(blockers: Blocker[]): GateResult {
  return { ok: blockers.length === 0, blockers }
}

/** Whole years elapsed, calendar-correct (not a 365.25-day approximation). */
export function ageInYearsAt(dateOfBirth: string, at: IsoDateTime): number {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`)
  const now = new Date(at)
  if (Number.isNaN(dob.getTime()) || Number.isNaN(now.getTime())) return Number.NaN

  let age = now.getUTCFullYear() - dob.getUTCFullYear()
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth()
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age -= 1
  }
  return age
}

/**
 * Can this operator take bookings at all right now?
 *
 * Operating without a valid vergunning is the operator's criminal exposure, so
 * this gate runs before anything else and is never overridable from the UI.
 */
export function checkOperator(operator: Operator, now: IsoDateTime): GateResult {
  const blockers: Blocker[] = []
  const t = new Date(now).getTime()

  if (operator.suspendedAt !== null) {
    blockers.push({
      code: 'operator_suspended',
      message: `Vergunning ${operator.vergunningNumber} is suspended as of ${operator.suspendedAt}.`,
    })
  }
  if (t < new Date(operator.vergunningValidFrom).getTime()) {
    blockers.push({
      code: 'vergunning_not_yet_valid',
      message: `Vergunning ${operator.vergunningNumber} is not valid until ${operator.vergunningValidFrom}.`,
    })
  }
  if (t >= new Date(operator.vergunningValidUntil).getTime()) {
    blockers.push({
      code: 'vergunning_expired',
      message: `Vergunning ${operator.vergunningNumber} expired on ${operator.vergunningValidUntil}.`,
    })
  }
  if (operator.vergunningNumber.trim() === '') {
    blockers.push({
      code: 'vergunning_missing',
      message: 'No vergunning number on file. An escortbedrijf may not operate without one.',
    })
  }

  return fail(blockers)
}

/**
 * Can this worker be offered work in this gemeente?
 *
 * Note what is *not* here: nothing about health checks or STI testing. Mandatory
 * testing is not lawful to impose in NL, the data is AVG Article 9 special
 * category, and a platform holding it creates leverage over the worker. If a
 * client asks, the answer is that we do not hold it.
 */
export function checkWorker(
  worker: Worker,
  rules: MunicipalityRules,
  now: IsoDateTime,
): GateResult {
  const blockers: Blocker[] = []

  if (worker.status !== 'active') {
    blockers.push({
      code: 'worker_not_active',
      message: `Worker status is "${worker.status}".`,
    })
  }

  const identity = worker.identity
  if (identity === null) {
    blockers.push({
      code: 'identity_unverified',
      message: 'Identity and age have not been verified.',
    })
  } else {
    const age = ageInYearsAt(identity.dateOfBirth, now)
    if (Number.isNaN(age)) {
      blockers.push({ code: 'identity_dob_invalid', message: 'Recorded date of birth is unreadable.' })
    } else if (age < rules.minimumWorkerAge) {
      blockers.push({
        code: 'below_minimum_age',
        message: `Worker is ${age}; gemeente ${rules.code} requires ${rules.minimumWorkerAge}.`,
      })
    }
    if (!identity.rightToWorkConfirmed) {
      blockers.push({
        code: 'right_to_work_unconfirmed',
        message: 'Right to work in the Netherlands has not been confirmed.',
      })
    }
  }

  if (rules.requireIntakeInterview) {
    const intake = worker.intake
    if (intake === null) {
      blockers.push({
        code: 'intake_missing',
        message: 'Intake interview has not been conducted.',
      })
    } else {
      if (!intake.conductedAlone) {
        // The interview exists to detect a third party speaking for the worker.
        // If someone was present, the interview did not do its job.
        blockers.push({
          code: 'intake_not_alone',
          message: 'Intake interview was not conducted with the worker alone. Repeat it alone.',
        })
      }
      if (!intake.exitProgrammeInformationGiven) {
        blockers.push({
          code: 'exit_programme_not_offered',
          message: 'Worker was not informed about exit programmes (uitstapprogramma).',
        })
      }
    }
  }

  return fail(blockers)
}

/** Convenience: both gates, reasons merged. */
export function checkOperatorAndWorker(
  operator: Operator,
  worker: Worker,
  rules: MunicipalityRules,
  now: IsoDateTime,
): GateResult {
  const a = checkOperator(operator, now)
  const b = checkWorker(worker, rules, now)
  if (a.ok && b.ok) return pass
  return { ok: false, blockers: [...a.blockers, ...b.blockers] }
}
