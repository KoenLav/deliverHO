import { describe, expect, it } from 'vitest'
import { screen, type ScreeningInput } from '../src/policy/screening.js'
import { MunicipalityRegistry, STRICT_DEFAULTS } from '../src/policy/municipality.js'
import {
  makeAvailability, makeBooking, makeClient, makeOperator, makeWorker, NOW, utcHour,
} from './fixtures.js'

function registryWith(overrides: Partial<typeof STRICT_DEFAULTS> = {}) {
  const registry = new MunicipalityRegistry()
  registry.register({
    code: 'GM0363',
    ...STRICT_DEFAULTS,
    allowPrivateResidenceBookings: true,
    ...overrides,
    sourceReference: 'test',
  })
  return registry
}

function setup(overrides: Partial<ScreeningInput> = {}): ScreeningInput {
  const operator = makeOperator()
  const worker = makeWorker(operator.id)
  const client = makeClient()
  return {
    operator,
    client,
    booking: makeBooking(operator.id, client.id),
    candidates: [worker],
    availability: [makeAvailability(worker.id)],
    signals: [],
    registry: registryWith(),
    now: NOW,
    localHourOf: utcHour,
    ...overrides,
  }
}

function blockCodes(report: ReturnType<typeof screen>): string[] {
  return report.outcome.decision === 'block' ? report.outcome.blockers.map((b) => b.code) : []
}

describe('screening', () => {
  it('offers a clean request to the eligible worker', () => {
    const input = setup()
    const report = screen(input)
    expect(report.outcome.decision).toBe('offer')
    if (report.outcome.decision === 'offer') {
      expect(report.outcome.workerIds).toEqual([input.candidates[0]!.id])
    }
  })

  it('fails closed for a gemeente with no configured rules', () => {
    const input = setup()
    const booking = { ...input.booking, location: { ...input.booking.location, municipality: 'GM9999' } }
    expect(blockCodes(screen({ ...input, booking }))).toContain('municipality_not_configured')
  })

  it('blocks when the operator vergunning has expired', () => {
    const operator = makeOperator({ vergunningValidUntil: '2026-01-01T00:00:00.000Z' })
    expect(blockCodes(screen(setup({ operator })))).toContain('vergunning_expired')
  })

  it('blocks a blocked client', () => {
    const client = makeClient({ blockedAt: NOW, blockedReason: 'Reported by a worker' })
    const input = setup({ client })
    const report = screen({ ...input, booking: makeBooking(input.operator.id, client.id) })
    expect(blockCodes(report)).toContain('client_blocked')
  })

  it('blocks an unverified client', () => {
    const client = makeClient({ phoneVerifiedAt: null })
    const input = setup({ client })
    expect(
      blockCodes(screen({ ...input, booking: makeBooking(input.operator.id, client.id) })),
    ).toContain('client_unverified')
  })
})

describe('private residence bookings', () => {
  it('requires iDIN, not merely a verified phone', () => {
    const client = makeClient({ verificationLevel: 'phone_verified', idinVerifiedAt: null })
    const input = setup({ client })
    const booking = makeBooking(input.operator.id, client.id, {
      location: { ...input.booking.location, type: 'private_residence', venueName: null },
    })
    expect(blockCodes(screen({ ...input, booking }))).toContain(
      'idin_required_for_private_residence',
    )
  })

  it('is refused entirely where the gemeente does not permit it', () => {
    const input = setup({ registry: registryWith({ allowPrivateResidenceBookings: false }) })
    const booking = {
      ...input.booking,
      location: { ...input.booking.location, type: 'private_residence' as const, venueName: null },
    }
    expect(blockCodes(screen({ ...input, booking }))).toContain('private_residence_not_permitted')
  })
})

describe('worker matching', () => {
  it('excludes a worker with no published availability', () => {
    const input = setup({ availability: [] })
    const report = screen(input)
    expect(blockCodes(report)).toContain('no_eligible_worker')
    expect(report.rejections[0]?.reasons.map((r) => r.code)).toContain('no_published_availability')
  })

  it('treats a withdrawn window as immediately gone', () => {
    const input = setup()
    const withdrawn = [
      makeAvailability(input.candidates[0]!.id, { withdrawnAt: '2026-06-15T17:00:00.000Z' }),
    ]
    expect(blockCodes(screen({ ...input, availability: withdrawn }))).toContain('no_eligible_worker')
  })

  it('excludes a worker carrying a blocking risk signal', () => {
    const input = setup()
    const workerId = input.candidates[0]!.id
    const report = screen({
      ...input,
      signals: [
        {
          code: 'shared_payout_iban',
          severity: 'block',
          message: 'Shared payout account.',
          subject: { kind: 'worker', id: workerId },
          detectedAt: NOW,
        },
      ],
    })
    expect(report.outcome.decision).toBe('block')
    expect(report.rejections[0]?.reasons.map((r) => r.code)).toContain('risk:shared_payout_iban')
  })

  it('does not let an info-severity signal exclude anyone', () => {
    const input = setup()
    const report = screen({
      ...input,
      signals: [
        {
          code: 'shared_device',
          severity: 'info',
          message: 'Noted.',
          subject: { kind: 'worker', id: input.candidates[0]!.id },
          detectedAt: NOW,
        },
      ],
    })
    expect(report.outcome.decision).toBe('offer')
  })

  it('records why each rejected worker was excluded, for the beheerder', () => {
    const operator = makeOperator()
    const eligible = makeWorker(operator.id)
    const tooYoung = makeWorker(operator.id, {
      identity: { ...makeWorker(operator.id).identity!, dateOfBirth: '2008-01-01' },
    })
    const client = makeClient()
    const report = screen({
      ...setup({ operator, client, candidates: [eligible, tooYoung] }),
      booking: makeBooking(operator.id, client.id),
      availability: [makeAvailability(eligible.id), makeAvailability(tooYoung.id)],
    })
    expect(report.outcome.decision).toBe('offer')
    expect(report.rejections).toHaveLength(1)
    expect(report.rejections[0]?.reasons.map((r) => r.code)).toContain('below_minimum_age')
  })

  it('blocks a request with no agreed rate', () => {
    const input = setup()
    const booking = { ...input.booking, agreedRateCents: 0 }
    expect(blockCodes(screen({ ...input, booking }))).toContain('rate_not_agreed')
  })
})
