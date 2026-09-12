import { randomUUID } from 'node:crypto'
import type {
  Booking,
  Client,
  Operator,
  Uuid,
  Worker,
  AvailabilityWindow,
} from '../src/domain/types.js'

export const NOW = '2026-06-15T18:00:00.000Z'

export function makeOperator(overrides: Partial<Operator> = {}): Operator {
  return {
    id: randomUUID(),
    legalName: 'Test Escort B.V.',
    kvkNumber: '12345678',
    vergunningNumber: 'ESC-2026-0001',
    municipality: 'GM0363',
    vergunningValidFrom: '2026-01-01T00:00:00.000Z',
    vergunningValidUntil: '2027-01-01T00:00:00.000Z',
    suspendedAt: null,
    beheerderName: 'A. Beheerder',
    contactPhone: '+31600000000',
    ...overrides,
  }
}

export function makeWorker(operatorId: Uuid, overrides: Partial<Worker> = {}): Worker {
  return {
    id: randomUUID(),
    operatorId,
    displayName: 'Test Worker',
    status: 'active',
    identity: {
      method: 'in_person_document_check',
      verifiedAt: '2026-01-02T00:00:00.000Z',
      verifiedBy: 'A. Beheerder',
      dateOfBirth: '1996-04-12',
      rightToWorkConfirmed: true,
      documentReferenceHash: 'hash',
    },
    intake: {
      conductedAt: '2026-01-02T00:00:00.000Z',
      conductedBy: 'A. Beheerder',
      language: 'nl',
      conductedAlone: true,
      exitProgrammeInformationGiven: true,
      concerns: null,
    },
    servesMunicipalities: ['GM0363'],
    directPhone: '+31611111111',
    payoutIban: 'NL00BANK0000000001',
    boundaries: {
      refusedServices: [],
      earliestStartHour: 10,
      latestStartHour: 23,
      maxBookingMinutes: 180,
      allowedLocationTypes: ['hotel', 'private_residence'],
    },
    createdAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  }
}

export function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: randomUUID(),
    verificationLevel: 'idin_verified',
    phoneVerifiedAt: NOW,
    idinVerifiedAt: NOW,
    blockedAt: null,
    blockedReason: null,
    createdAt: NOW,
    ...overrides,
  }
}

export function makeBooking(
  operatorId: Uuid,
  clientId: Uuid,
  overrides: Partial<Booking> = {},
): Booking {
  return {
    id: randomUUID(),
    operatorId,
    clientId,
    workerId: null,
    status: 'requested',
    requestedStart: '2026-06-15T20:00:00.000Z',
    durationMinutes: 60,
    location: {
      type: 'hotel',
      municipality: 'GM0363',
      addressLine: 'Teststraat 1',
      postalCode: '1011AB',
      venueName: 'Test Hotel',
    },
    requestedServices: [],
    agreedRateCents: 20000,
    createdAt: NOW,
    history: [{ at: NOW, status: 'requested', actor: { kind: 'client', id: clientId }, reason: null }],
    ...overrides,
  }
}

export function makeAvailability(
  workerId: Uuid,
  overrides: Partial<AvailabilityWindow> = {},
): AvailabilityWindow {
  return {
    id: randomUUID(),
    workerId,
    startsAt: '2026-06-15T10:00:00.000Z',
    endsAt: '2026-06-16T02:00:00.000Z',
    municipality: 'GM0363',
    withdrawnAt: null,
    ...overrides,
  }
}

/** Fixed offset so boundary tests do not depend on the host timezone. */
export const utcHour = (at: string) => new Date(at).getUTCHours()
