import { describe, expect, it } from 'vitest'
import {
  blockingSignalsFor, detectSignals, type CohortSnapshot, type WorkerBookingStats,
} from '../src/risk/indicators.js'
import { makeOperator, makeWorker, NOW } from './fixtures.js'

const operator = makeOperator({ contactPhone: '+31600000000' })

function stats(workerId: string, overrides: Partial<WorkerBookingStats> = {}): WorkerBookingStats {
  return {
    workerId,
    offersReceived: 0,
    offersAccepted: 0,
    offersDeclined: 0,
    longestConsecutiveHours: 0,
    overnightBookings: 0,
    ...overrides,
  }
}

function snapshot(overrides: Partial<CohortSnapshot> = {}): CohortSnapshot {
  return { operator, workers: [], stats: [], accesses: [], ...overrides }
}

function codes(snap: CohortSnapshot): string[] {
  return detectSignals(snap, NOW).map((s) => s.code)
}

describe('money and contact convergence', () => {
  it('blocks when two workers share a payout account', () => {
    const a = makeWorker(operator.id, { payoutIban: 'NL00BANK0000000001', directPhone: '+31611111111' })
    const b = makeWorker(operator.id, { payoutIban: 'NL00 BANK 0000 000001', directPhone: '+31622222222' })
    const signals = detectSignals(snapshot({ workers: [a, b] }), NOW)

    const shared = signals.filter((s) => s.code === 'shared_payout_iban')
    expect(shared).toHaveLength(2) // Flagged on both accounts, not just one.
    expect(shared.every((s) => s.severity === 'block')).toBe(true)
  })

  it('normalises IBAN spacing and case before comparing', () => {
    const a = makeWorker(operator.id, { payoutIban: 'nl00bank0000000001', directPhone: '+31611111111' })
    const b = makeWorker(operator.id, { payoutIban: 'NL00 BANK 0000 0000 01', directPhone: '+31622222222' })
    // Same account written three ways is still the same account.
    expect(codes(snapshot({ workers: [a, b] }))).toContain('shared_payout_iban')
  })

  it('blocks when two workers share a contact number written differently', () => {
    const a = makeWorker(operator.id, { directPhone: '+31 6 1111 1111', payoutIban: 'NL01' })
    const b = makeWorker(operator.id, { directPhone: '0611111111', payoutIban: 'NL02' })
    expect(codes(snapshot({ workers: [a, b] }))).toContain('shared_contact_number')
  })

  it('blocks when a worker direct number is the operator own number', () => {
    const w = makeWorker(operator.id, { directPhone: '0600000000', payoutIban: 'NL03' })
    expect(codes(snapshot({ workers: [w] }))).toContain('worker_phone_is_operator_phone')
  })

  it('leaves a normal roster clean', () => {
    const a = makeWorker(operator.id, { directPhone: '+31611111111', payoutIban: 'NL01' })
    const b = makeWorker(operator.id, { directPhone: '+31622222222', payoutIban: 'NL02' })
    expect(detectSignals(snapshot({ workers: [a, b] }), NOW)).toEqual([])
  })
})

describe('control indicators', () => {
  it('flags a device signed into several worker accounts', () => {
    const a = makeWorker(operator.id, { directPhone: '+31611111111', payoutIban: 'NL01' })
    const b = makeWorker(operator.id, { directPhone: '+31622222222', payoutIban: 'NL02' })
    const snap = snapshot({
      workers: [a, b],
      accesses: [
        { workerId: a.id, deviceFingerprint: 'device-aaaaaaa', at: NOW },
        { workerId: b.id, deviceFingerprint: 'device-aaaaaaa', at: NOW },
      ],
    })
    expect(codes(snap)).toContain('shared_device')
  })

  it('flags a worker who has never once declined', () => {
    const w = makeWorker(operator.id, { directPhone: '+31611111111', payoutIban: 'NL01' })
    const snap = snapshot({
      workers: [w],
      stats: [stats(w.id, { offersReceived: 24, offersAccepted: 24 })],
    })
    expect(codes(snap)).toContain('never_declines')
  })

  it('does not flag a small sample as never declining', () => {
    const w = makeWorker(operator.id, { directPhone: '+31611111111', payoutIban: 'NL01' })
    const snap = snapshot({ workers: [w], stats: [stats(w.id, { offersReceived: 3, offersAccepted: 3 })] })
    expect(codes(snap)).not.toContain('never_declines')
  })

  it('does not flag a worker who declines sometimes', () => {
    const w = makeWorker(operator.id, { directPhone: '+31611111111', payoutIban: 'NL01' })
    const snap = snapshot({
      workers: [w],
      stats: [stats(w.id, { offersReceived: 40, offersAccepted: 36, offersDeclined: 4 })],
    })
    expect(codes(snap)).not.toContain('never_declines')
  })

  it('flags excessive consecutive hours', () => {
    const w = makeWorker(operator.id, { directPhone: '+31611111111', payoutIban: 'NL01' })
    const snap = snapshot({ workers: [w], stats: [stats(w.id, { longestConsecutiveHours: 16 })] })
    expect(codes(snap)).toContain('excessive_consecutive_hours')
  })

  it('surfaces a concern recorded at intake', () => {
    const w = makeWorker(operator.id, {
      directPhone: '+31611111111',
      payoutIban: 'NL01',
      intake: { ...makeWorker(operator.id).intake!, concerns: 'Seemed rehearsed.' },
    })
    expect(codes(snapshot({ workers: [w] }))).toContain('intake_concerns_recorded')
  })

  it('treats three workers at one address as worth a look, but not two', () => {
    const w = [1, 2, 3].map((n) =>
      makeWorker(operator.id, { directPhone: `+3161111111${n}`, payoutIban: `NL0${n}` }),
    )
    const three = new Map(w.map((x) => [x.id, 'addr-hash']))
    expect(codes(snapshot({ workers: w, registeredAddressHashes: three }))).toContain(
      'shared_registered_address',
    )

    const two = new Map(w.slice(0, 2).map((x) => [x.id, 'addr-hash']))
    expect(
      codes(snapshot({ workers: w.slice(0, 2), registeredAddressHashes: two })),
    ).not.toContain('shared_registered_address')
  })
})

describe('signal handling', () => {
  it('sorts blocking signals ahead of review signals', () => {
    const a = makeWorker(operator.id, { payoutIban: 'SHARED', directPhone: '+31611111111' })
    const b = makeWorker(operator.id, { payoutIban: 'SHARED', directPhone: '+31622222222' })
    const snap = snapshot({
      workers: [a, b],
      stats: [stats(a.id, { offersReceived: 20, offersAccepted: 20 })],
    })
    const signals = detectSignals(snap, NOW)
    expect(signals[0]?.severity).toBe('block')
  })

  it('reports blocking signals per worker', () => {
    const a = makeWorker(operator.id, { payoutIban: 'SHARED', directPhone: '+31611111111' })
    const b = makeWorker(operator.id, { payoutIban: 'SHARED', directPhone: '+31622222222' })
    const signals = detectSignals(snapshot({ workers: [a, b] }), NOW)
    expect(blockingSignalsFor(signals, a.id)).toHaveLength(1)
  })

  it('never emits a signal that suspends a worker account', () => {
    // Signals gate bookings and route to a human. Nothing here changes worker
    // status, and nothing should ever start to.
    const a = makeWorker(operator.id, { payoutIban: 'SHARED', directPhone: '+31611111111' })
    const b = makeWorker(operator.id, { payoutIban: 'SHARED', directPhone: '+31622222222' })
    const before = { ...a }
    detectSignals(snapshot({ workers: [a, b] }), NOW)
    expect(a).toEqual(before)
  })
})
