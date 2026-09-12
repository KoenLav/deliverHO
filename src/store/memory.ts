import type {
  AvailabilityWindow,
  Booking,
  Client,
  Operator,
  SafetySession,
  Uuid,
  Worker,
} from '../domain/types.js'
import type { AccountAccessRecord, WorkerBookingStats } from '../risk/indicators.js'

/**
 * In-memory store.
 *
 * Deliberately behind an interface so the domain never learns where data lives.
 * `db/schema.sql` is the Postgres shape this mirrors; swapping in a real
 * implementation should not touch anything under src/domain or src/policy.
 */
export interface Store {
  operators: Map<Uuid, Operator>
  workers: Map<Uuid, Worker>
  clients: Map<Uuid, Client>
  bookings: Map<Uuid, Booking>
  availability: Map<Uuid, AvailabilityWindow>
  safetySessions: Map<Uuid, SafetySession>
  stats: Map<Uuid, WorkerBookingStats>
  accesses: AccountAccessRecord[]
}

export function createStore(): Store {
  return {
    operators: new Map(),
    workers: new Map(),
    clients: new Map(),
    bookings: new Map(),
    availability: new Map(),
    safetySessions: new Map(),
    stats: new Map(),
    accesses: [],
  }
}

export function workersOf(store: Store, operatorId: Uuid): Worker[] {
  return [...store.workers.values()].filter((w) => w.operatorId === operatorId)
}

export function availabilityOf(store: Store, operatorId: Uuid): AvailabilityWindow[] {
  const workerIds = new Set(workersOf(store, operatorId).map((w) => w.id))
  return [...store.availability.values()].filter((a) => workerIds.has(a.workerId))
}

export function openSafetySessions(store: Store): SafetySession[] {
  return [...store.safetySessions.values()].filter(
    (s) => s.state === 'open' || s.state === 'checked_in',
  )
}

/** Bookings a worker may currently see. Offers are visible to nobody else. */
export function offersVisibleTo(store: Store, workerId: Uuid): Booking[] {
  return [...store.bookings.values()].filter(
    (b) =>
      (b.status === 'offered' && b.workerId === null) ||
      b.workerId === workerId,
  )
}
