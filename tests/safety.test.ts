import { describe, expect, it } from 'vitest'
import {
  applyEscalation, checkIn, checkOut, extend, openSession, operatorEscalate, panic, sweep,
} from '../src/safety/session.js'
import type { EscalationContact, SafetySession } from '../src/domain/types.js'

const WORKER = 'w-1'
const OTHER = 'w-2'
const START = '2026-06-15T20:00:00.000Z'

const contacts: EscalationContact[] = [
  { name: 'Trusted friend', phone: '+31611111111', order: 1, kind: 'trusted_person' },
  { name: 'Beheerder', phone: '+31600000000', order: 0, kind: 'operator_beheerder' },
]

function open(overrides: { durationMinutes?: number; graceMinutes?: number } = {}): SafetySession {
  const result = openSession({
    id: 's-1',
    bookingId: 'b-1',
    workerId: WORKER,
    durationMinutes: overrides.durationMinutes ?? 60,
    graceMinutes: overrides.graceMinutes ?? 20,
    contacts,
    now: START,
  })
  if (!result.ok) throw new Error(result.message)
  return result.session
}

function minutesAfter(minutes: number): string {
  return new Date(new Date(START).getTime() + minutes * 60_000).toISOString()
}

describe('opening a session', () => {
  it('refuses to open without an escalation contact', () => {
    const result = openSession({
      id: 's', bookingId: 'b', workerId: WORKER,
      durationMinutes: 60, graceMinutes: 20, contacts: [], now: START,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('no_escalation_contacts')
  })

  it('sets the deadline to duration plus grace and orders the contact ladder', () => {
    const session = open({ durationMinutes: 90, graceMinutes: 15 })
    expect(session.expectedCheckOutAt).toBe(minutesAfter(105))
    expect(session.escalationContacts.map((c) => c.order)).toEqual([0, 1])
  })
})

describe('silence is the alarm', () => {
  it('escalates a session the worker never closed', () => {
    const session = open({ durationMinutes: 60, graceMinutes: 20 })
    const checkedIn = checkIn(session, WORKER, minutesAfter(10))
    expect(checkedIn.ok).toBe(true)
    if (!checkedIn.ok) return

    expect(sweep([checkedIn.session], minutesAfter(79), 45)).toHaveLength(0)

    const due = sweep([checkedIn.session], minutesAfter(81), 45)
    expect(due).toHaveLength(1)
    expect(due[0]?.reason).toBe('missed_checkout')
    // The ladder comes back ready to work through, beheerder first.
    expect(due[0]?.contacts[0]?.kind).toBe('operator_beheerder')
  })

  it('escalates a worker who departed and never checked in', () => {
    const session = open()
    const due = sweep([session], minutesAfter(46), 45)
    expect(due).toHaveLength(1)
    expect(due[0]?.reason).toBe('missed_checkin')
  })

  it('does not escalate a session the worker closed properly', () => {
    const session = open()
    const closed = checkOut(session, WORKER, minutesAfter(50))
    expect(closed.ok).toBe(true)
    if (!closed.ok) return
    expect(sweep([closed.session], minutesAfter(500), 45)).toHaveLength(0)
  })

  it('does not re-escalate an already escalated session', () => {
    const session = open()
    const escalated = applyEscalation(
      { session, reason: 'missed_checkin', contacts },
      minutesAfter(46),
    )
    expect(sweep([escalated], minutesAfter(200), 45)).toHaveLength(0)
  })
})

describe('worker control of the session', () => {
  it('lets only the owning worker check in, check out, extend or panic', () => {
    const session = open()
    expect(checkIn(session, OTHER, minutesAfter(5)).ok).toBe(false)
    expect(checkOut(session, OTHER, minutesAfter(5)).ok).toBe(false)
    expect(extend(session, OTHER, 30, 120).ok).toBe(false)
    expect(panic(session, OTHER, minutesAfter(5)).ok).toBe(false)
  })

  it('escalates immediately on panic', () => {
    const result = panic(open(), WORKER, minutesAfter(5))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.session.state).toBe('escalated')
    expect(result.session.escalationReason).toBe('panic_button')
  })

  it('extends the deadline within bounds and refuses beyond them', () => {
    const session = open({ durationMinutes: 60, graceMinutes: 20 })
    const extended = extend(session, WORKER, 30, 120)
    expect(extended.ok).toBe(true)
    if (extended.ok) expect(extended.session.expectedCheckOutAt).toBe(minutesAfter(110))

    expect(extend(session, WORKER, 999, 120).ok).toBe(false)
    expect(extend(session, WORKER, 0, 120).ok).toBe(false)
  })

  it('lets the worker stand down their own false alarm', () => {
    const escalated = panic(open(), WORKER, minutesAfter(5))
    expect(escalated.ok).toBe(true)
    if (!escalated.ok) return
    const closed = checkOut(escalated.session, WORKER, minutesAfter(6))
    expect(closed.ok).toBe(true)
    if (closed.ok) {
      expect(closed.session.state).toBe('closed')
      // The escalation stays on the record either way.
      expect(closed.session.escalatedAt).not.toBeNull()
    }
  })
})

describe('the operator can raise an alarm but not lower one', () => {
  it('lets the operator escalate', () => {
    const result = operatorEscalate(open(), minutesAfter(30))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.session.escalationReason).toBe('operator_initiated')
  })

  it('offers no operator route to close a session', () => {
    // checkOut is the only close, and it requires the worker's own id.
    const session = open()
    expect(checkOut(session, 'beheerder-id', minutesAfter(30)).ok).toBe(false)
  })
})
