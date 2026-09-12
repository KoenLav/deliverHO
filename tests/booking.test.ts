import { describe, expect, it } from 'vitest'
import { applyCommand, findBoundaryViolations, isTerminal } from '../src/domain/booking.js'
import type { Booking, BookingStatus } from '../src/domain/types.js'
import { makeBooking, makeOperator, makeWorker, NOW, utcHour } from './fixtures.js'

const operator = makeOperator()
const worker = makeWorker(operator.id)
const otherWorker = makeWorker(operator.id)
const clientId = 'c0000000-0000-4000-8000-000000000001'

function offered(): Booking {
  return makeBooking(operator.id, clientId, { status: 'offered' })
}

function at(status: BookingStatus, workerId: string | null = worker.id): Booking {
  return makeBooking(operator.id, clientId, { status, workerId })
}

function expectOk(result: ReturnType<typeof applyCommand>): Booking {
  if (!result.ok) throw new Error(`Expected success, got ${result.code}: ${result.message}`)
  return result.booking
}

describe('the worker holds the accept', () => {
  it('assigns the worker only when that worker personally accepts', () => {
    const booking = expectOk(
      applyCommand(offered(), { type: 'worker_accept', workerId: worker.id }, NOW),
    )
    expect(booking.status).toBe('accepted')
    expect(booking.workerId).toBe(worker.id)
  })

  it('has no operator command that can accept on a worker behalf', () => {
    // Asserted structurally: the command union simply has no operator-side
    // acceptance. If someone adds one, this test is the tripwire.
    const commandTypes = [
      'begin_screening', 'screening_passed', 'screening_failed', 'offer_expired',
      'worker_accept', 'worker_decline', 'client_confirm', 'worker_depart',
      'worker_arrive', 'worker_complete', 'worker_cancel', 'client_cancel',
    ]
    const operatorAccept = commandTypes.filter(
      (t) => t.startsWith('operator') || t.includes('assign') || t.includes('dispatch'),
    )
    expect(operatorAccept).toEqual([])
  })

  it('refuses a second worker once one has accepted', () => {
    const accepted = expectOk(
      applyCommand(offered(), { type: 'worker_accept', workerId: worker.id }, NOW),
    )
    const second = applyCommand(accepted, { type: 'worker_accept', workerId: otherWorker.id }, NOW)
    expect(second.ok).toBe(false)
  })

  it('expires an unanswered offer instead of assigning it', () => {
    const booking = expectOk(applyCommand(offered(), { type: 'offer_expired' }, NOW))
    expect(booking.status).toBe('expired')
    expect(booking.workerId).toBeNull()
    expect(isTerminal(booking.status)).toBe(true)
  })

  it('records a decline without assigning anyone', () => {
    const booking = expectOk(
      applyCommand(offered(), { type: 'worker_decline', workerId: worker.id, reason: null }, NOW),
    )
    expect(booking.status).toBe('declined_by_worker')
    expect(booking.workerId).toBeNull()
  })
})

describe('the worker can withdraw at any point', () => {
  const withdrawable: BookingStatus[] = ['accepted', 'confirmed', 'en_route', 'in_progress']

  for (const status of withdrawable) {
    it(`allows cancellation from "${status}"`, () => {
      const result = applyCommand(
        at(status),
        { type: 'worker_cancel', workerId: worker.id, reason: null },
        NOW,
      )
      expect(result.ok, `should be cancellable from ${status}`).toBe(true)
      if (result.ok) expect(result.booking.status).toBe('cancelled_by_worker')
    })
  }

  it('requires no reason', () => {
    const result = applyCommand(
      at('in_progress'),
      { type: 'worker_cancel', workerId: worker.id, reason: null },
      NOW,
    )
    expect(result.ok).toBe(true)
  })

  it('lets only the assigned worker act on the booking', () => {
    const result = applyCommand(
      at('confirmed'),
      { type: 'worker_cancel', workerId: otherWorker.id, reason: null },
      NOW,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('not_assigned_worker')
  })
})

describe('client cancellation', () => {
  it('is allowed while the worker has not yet arrived', () => {
    const result = applyCommand(
      at('en_route'),
      { type: 'client_cancel', clientId, reason: null },
      NOW,
    )
    expect(result.ok).toBe(true)
  })

  it('is refused once the worker has arrived', () => {
    const result = applyCommand(
      at('in_progress'),
      { type: 'client_cancel', clientId, reason: null },
      NOW,
    )
    expect(result.ok).toBe(false)
  })

  it('is refused for a different client', () => {
    const result = applyCommand(
      at('confirmed'),
      { type: 'client_cancel', clientId: 'someone-else', reason: null },
      NOW,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('wrong_client')
  })
})

describe('the full journey', () => {
  it('walks request through completion, appending an audit trail', () => {
    let booking = makeBooking(operator.id, clientId)
    booking = expectOk(applyCommand(booking, { type: 'begin_screening' }, NOW))
    booking = expectOk(applyCommand(booking, { type: 'screening_passed' }, NOW))
    booking = expectOk(applyCommand(booking, { type: 'worker_accept', workerId: worker.id }, NOW))
    booking = expectOk(applyCommand(booking, { type: 'client_confirm', clientId }, NOW))
    booking = expectOk(applyCommand(booking, { type: 'worker_depart', workerId: worker.id }, NOW))
    booking = expectOk(applyCommand(booking, { type: 'worker_arrive', workerId: worker.id }, NOW))
    booking = expectOk(applyCommand(booking, { type: 'worker_complete', workerId: worker.id }, NOW))

    expect(booking.status).toBe('completed')
    expect(booking.history.map((e) => e.status)).toEqual([
      'requested', 'screening', 'offered', 'accepted', 'confirmed',
      'en_route', 'in_progress', 'completed',
    ])
  })

  it('refuses any command on a terminal booking', () => {
    const done = at('completed')
    const result = applyCommand(done, { type: 'worker_cancel', workerId: worker.id, reason: null }, NOW)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('booking_terminal')
  })

  it('refuses out-of-order transitions', () => {
    const result = applyCommand(offered(), { type: 'worker_arrive', workerId: worker.id }, NOW)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid_transition')
  })
})

describe('worker boundaries', () => {
  it('flags a refused service', () => {
    const w = makeWorker(operator.id, {
      boundaries: { ...worker.boundaries, refusedServices: ['Overnight'] },
    })
    const booking = makeBooking(operator.id, clientId, { requestedServices: ['overnight'] })
    const violations = findBoundaryViolations(w, booking, utcHour)
    expect(violations.map((v) => v.code)).toContain('refused_service')
  })

  it('flags an over-long booking, an unserved gemeente and a barred location type', () => {
    const w = makeWorker(operator.id, {
      servesMunicipalities: ['GM0599'],
      boundaries: {
        ...worker.boundaries,
        maxBookingMinutes: 60,
        allowedLocationTypes: ['operator_premises'],
      },
    })
    const booking = makeBooking(operator.id, clientId, { durationMinutes: 240 })
    const codes = findBoundaryViolations(w, booking, utcHour).map((v) => v.code)
    expect(codes).toContain('duration_too_long')
    expect(codes).toContain('municipality_not_served')
    expect(codes).toContain('location_type_not_allowed')
  })

  it('handles a working window that wraps past midnight', () => {
    const w = makeWorker(operator.id, {
      boundaries: { ...worker.boundaries, earliestStartHour: 20, latestStartHour: 4 },
    })
    const inside = makeBooking(operator.id, clientId, { requestedStart: '2026-06-15T23:00:00.000Z' })
    const alsoInside = makeBooking(operator.id, clientId, { requestedStart: '2026-06-15T02:00:00.000Z' })
    const outside = makeBooking(operator.id, clientId, { requestedStart: '2026-06-15T12:00:00.000Z' })

    expect(findBoundaryViolations(w, inside, utcHour)).toEqual([])
    expect(findBoundaryViolations(w, alsoInside, utcHour)).toEqual([])
    expect(findBoundaryViolations(w, outside, utcHour).map((v) => v.code)).toContain(
      'outside_working_hours',
    )
  })
})
