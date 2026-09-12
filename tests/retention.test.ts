import { describe, expect, it } from 'vitest'
import {
  isDueForDeletion, isDueForRedaction, planOffboarding, redactOperationalDetail,
  toAdministrationRecord, OPERATIONAL_DETAIL_RETENTION_DAYS,
} from '../src/privacy/retention.js'
import { STRICT_DEFAULTS, type MunicipalityRules } from '../src/policy/municipality.js'
import { pseudonymFor } from '../src/store/pseudonym.js'
import { makeBooking, makeOperator, NOW } from './fixtures.js'

const rules: MunicipalityRules = { code: 'GM0363', ...STRICT_DEFAULTS, sourceReference: 'test' }
const operator = makeOperator()
const clientId = 'client-1'

describe('the administration record', () => {
  it('carries what the gemeente needs and nothing that identifies anyone', () => {
    const booking = makeBooking(operator.id, clientId, { workerId: 'worker-1', status: 'completed' })
    const record = toAdministrationRecord(booking, operator.vergunningNumber, 'PSEUDO123')
    const serialised = JSON.stringify(record)

    expect(record.vergunningNumber).toBe('ESC-2026-0001')
    expect(record.date).toBe('2026-06-15')
    expect(serialised).not.toContain('Teststraat')
    expect(serialised).not.toContain('worker-1')
    expect(serialised).not.toContain(clientId)
  })
})

describe('redaction', () => {
  it('strips address, services and free text but keeps the record countable', () => {
    const booking = makeBooking(operator.id, clientId, {
      requestedServices: ['dinner date'],
      history: [{ at: NOW, status: 'completed', actor: { kind: 'system' }, reason: 'a free-text note' }],
    })
    const redacted = redactOperationalDetail(booking)

    expect(redacted.location.addressLine).toBe('[redacted]')
    expect(redacted.location.venueName).toBeNull()
    expect(redacted.requestedServices).toEqual([])
    expect(redacted.history[0]?.reason).toBeNull()
    // Still countable for the administration.
    expect(redacted.durationMinutes).toBe(60)
    expect(redacted.requestedStart).toBe('2026-06-15T20:00:00.000Z')
  })

  it('keeps only the region digits of the postcode', () => {
    const redacted = redactOperationalDetail(makeBooking(operator.id, clientId))
    expect(redacted.location.postalCode).toBe('10[redacted]')
  })

  it('is idempotent', () => {
    const once = redactOperationalDetail(makeBooking(operator.id, clientId))
    expect(redactOperationalDetail(once).requestedServices).toEqual([])
  })

  it('comes due only after the operational retention window', () => {
    const booking = makeBooking(operator.id, clientId, {
      history: [{ at: '2026-06-15T22:00:00.000Z', status: 'completed', actor: { kind: 'system' }, reason: null }],
    })
    const justBefore = daysAfter('2026-06-15T22:00:00.000Z', OPERATIONAL_DETAIL_RETENTION_DAYS - 1)
    const justAfter = daysAfter('2026-06-15T22:00:00.000Z', OPERATIONAL_DETAIL_RETENTION_DAYS + 1)

    expect(isDueForRedaction(booking, justBefore)).toBe(false)
    expect(isDueForRedaction(booking, justAfter)).toBe(true)
  })
})

describe('deletion of the administration record', () => {
  it('waits out the municipal retention period', () => {
    const booking = makeBooking(operator.id, clientId, { workerId: 'w' })
    const record = toAdministrationRecord(booking, operator.vergunningNumber, 'P')

    expect(isDueForDeletion(record, rules, daysAfter('2026-06-15T00:00:00.000Z', 100))).toBe(false)
    expect(isDueForDeletion(record, rules, daysAfter('2026-06-15T00:00:00.000Z', 400))).toBe(true)
  })
})

describe('pseudonyms', () => {
  it('is stable for the same worker and key', () => {
    const key = 'k'.repeat(32)
    expect(pseudonymFor('worker-1', key)).toBe(pseudonymFor('worker-1', key))
  })

  it('differs across workers and across keys', () => {
    const a = 'a'.repeat(32)
    const b = 'b'.repeat(32)
    expect(pseudonymFor('worker-1', a)).not.toBe(pseudonymFor('worker-2', a))
    // A key rotation must not leave the old pseudonyms re-linkable.
    expect(pseudonymFor('worker-1', a)).not.toBe(pseudonymFor('worker-1', b))
  })

  it('refuses a weak key', () => {
    expect(() => pseudonymFor('worker-1', 'short')).toThrow()
  })

  it('does not contain the worker id', () => {
    expect(pseudonymFor('worker-1', 'k'.repeat(32))).not.toContain('worker-1')
  })
})

describe('offboarding', () => {
  it('redacts contact and payment details immediately', () => {
    const plan = planOffboarding('worker-1', rules)
    expect(plan.redactImmediately).toContain('directPhone')
    expect(plan.redactImmediately).toContain('payoutIban')
  })

  it('states a reason and an end date for everything it keeps', () => {
    const plan = planOffboarding('worker-1', rules)
    expect(plan.retained.length).toBeGreaterThan(0)
    for (const item of plan.retained) {
      expect(item.reason.length).toBeGreaterThan(0)
      expect(item.untilDays).toBe(rules.administrationRetentionDays)
    }
  })
})

function daysAfter(from: string, days: number): string {
  return new Date(new Date(from).getTime() + days * 86_400_000).toISOString()
}
