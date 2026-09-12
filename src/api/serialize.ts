import type { Booking, Uuid } from '../domain/types.js'

/**
 * What each party is allowed to see.
 *
 * The full address is released to a worker only once they have accepted. Before
 * that they see the municipality and the location type -- enough to decide
 * whether to accept, not enough to be sent anywhere. This matters because an
 * offer is broadcast to several workers: if the address went out with the
 * offer, one client request would leak a home address to everyone who saw it.
 */
export function bookingForWorker(booking: Booking, workerId: Uuid): unknown {
  const accepted = booking.workerId === workerId && isAtOrPast(booking.status, 'accepted')

  return {
    id: booking.id,
    status: booking.status,
    requestedStart: booking.requestedStart,
    durationMinutes: booking.durationMinutes,
    requestedServices: booking.requestedServices,
    agreedRateCents: booking.agreedRateCents,
    location: accepted
      ? booking.location
      : {
          type: booking.location.type,
          municipality: booking.location.municipality,
          addressLine: null,
          postalCode: null,
          venueName: null,
        },
    isAssignedToYou: booking.workerId === workerId,
  }
}

/**
 * The client never gets the worker's identity beyond a display name, and never
 * gets their direct number: the operator relays until the worker chooses
 * otherwise. Post-booking contact details are the worker's to give out.
 */
export function bookingForClient(booking: Booking, workerDisplayName: string | null): unknown {
  return {
    id: booking.id,
    status: booking.status,
    requestedStart: booking.requestedStart,
    durationMinutes: booking.durationMinutes,
    agreedRateCents: booking.agreedRateCents,
    location: booking.location,
    worker: workerDisplayName === null ? null : { displayName: workerDisplayName },
  }
}

const ORDER = [
  'requested',
  'screening',
  'offered',
  'accepted',
  'confirmed',
  'en_route',
  'in_progress',
  'completed',
] as const

function isAtOrPast(status: string, target: (typeof ORDER)[number]): boolean {
  const a = ORDER.indexOf(status as (typeof ORDER)[number])
  const b = ORDER.indexOf(target)
  return a >= 0 && b >= 0 && a >= b
}
