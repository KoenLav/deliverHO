import { describe, expect, it } from 'vitest'
import { ageInYearsAt, checkOperator, checkWorker } from '../src/policy/eligibility.js'
import { STRICT_DEFAULTS, type MunicipalityRules } from '../src/policy/municipality.js'
import { makeOperator, makeWorker, NOW } from './fixtures.js'

const rules: MunicipalityRules = {
  code: 'GM0363',
  ...STRICT_DEFAULTS,
  sourceReference: 'test',
}

const operator = makeOperator()

function codes(result: { blockers: { code: string }[] }): string[] {
  return result.blockers.map((b) => b.code)
}

describe('ageInYearsAt', () => {
  it('counts whole years, not fractions', () => {
    expect(ageInYearsAt('2000-06-15', '2026-06-15T00:00:00.000Z')).toBe(26)
    expect(ageInYearsAt('2000-06-16', '2026-06-15T00:00:00.000Z')).toBe(25)
  })

  it('does not round someone up to the age threshold a day early', () => {
    // The day before a 21st birthday must still read as 20. A 365.25-day
    // approximation gets this wrong, and getting it wrong means letting a
    // 20-year-old work in a gemeente that requires 21.
    expect(ageInYearsAt('2005-06-16', '2026-06-15T23:59:59.000Z')).toBe(20)
    expect(ageInYearsAt('2005-06-15', '2026-06-15T00:00:00.000Z')).toBe(21)
  })

  it('handles a leap-day birth date', () => {
    expect(ageInYearsAt('2004-02-29', '2026-02-28T00:00:00.000Z')).toBe(21)
    expect(ageInYearsAt('2004-02-29', '2026-03-01T00:00:00.000Z')).toBe(22)
  })
})

describe('operator gate', () => {
  it('passes a current vergunning', () => {
    expect(checkOperator(operator, NOW).ok).toBe(true)
  })

  it('blocks an expired vergunning', () => {
    const expired = makeOperator({ vergunningValidUntil: '2026-01-01T00:00:00.000Z' })
    expect(codes(checkOperator(expired, NOW))).toContain('vergunning_expired')
  })

  it('blocks a vergunning that has not started', () => {
    const future = makeOperator({ vergunningValidFrom: '2027-01-01T00:00:00.000Z' })
    expect(codes(checkOperator(future, NOW))).toContain('vergunning_not_yet_valid')
  })

  it('blocks a suspended operator', () => {
    const suspended = makeOperator({ suspendedAt: '2026-05-01T00:00:00.000Z' })
    expect(codes(checkOperator(suspended, NOW))).toContain('operator_suspended')
  })

  it('blocks a missing vergunning number', () => {
    expect(codes(checkOperator(makeOperator({ vergunningNumber: '  ' }), NOW))).toContain(
      'vergunning_missing',
    )
  })
})

describe('worker gate', () => {
  it('passes a fully onboarded worker', () => {
    expect(checkWorker(makeWorker(operator.id), rules, NOW).ok).toBe(true)
  })

  it('blocks a worker below the municipal minimum age', () => {
    const young = makeWorker(operator.id, {
      identity: { ...makeWorker(operator.id).identity!, dateOfBirth: '2006-01-01' },
    })
    expect(codes(checkWorker(young, rules, NOW))).toContain('below_minimum_age')
  })

  it('blocks an unverified identity', () => {
    const unverified = makeWorker(operator.id, { identity: null })
    expect(codes(checkWorker(unverified, rules, NOW))).toContain('identity_unverified')
  })

  it('blocks an unconfirmed right to work', () => {
    const w = makeWorker(operator.id, {
      identity: { ...makeWorker(operator.id).identity!, rightToWorkConfirmed: false },
    })
    expect(codes(checkWorker(w, rules, NOW))).toContain('right_to_work_unconfirmed')
  })

  it('blocks an intake interview that was not conducted alone', () => {
    const w = makeWorker(operator.id, {
      intake: { ...makeWorker(operator.id).intake!, conductedAlone: false },
    })
    expect(codes(checkWorker(w, rules, NOW))).toContain('intake_not_alone')
  })

  it('blocks when exit programme information was not given', () => {
    const w = makeWorker(operator.id, {
      intake: { ...makeWorker(operator.id).intake!, exitProgrammeInformationGiven: false },
    })
    expect(codes(checkWorker(w, rules, NOW))).toContain('exit_programme_not_offered')
  })

  it('blocks a paused worker', () => {
    const w = makeWorker(operator.id, { status: 'paused_by_worker' })
    expect(codes(checkWorker(w, rules, NOW))).toContain('worker_not_active')
  })

  it('reports every blocker at once rather than the first', () => {
    const w = makeWorker(operator.id, { status: 'offboarded', identity: null, intake: null })
    const result = checkWorker(w, rules, NOW)
    expect(result.blockers.length).toBeGreaterThanOrEqual(3)
  })
})
