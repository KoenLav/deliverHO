import { randomUUID } from 'node:crypto'
import type { Store } from './store/memory.js'
import type { Operator, Worker, Client, AvailabilityWindow } from './domain/types.js'

/**
 * Development seed. Synthetic data only -- no real person, number or IBAN.
 * Never import this from production code paths.
 */
export interface SeedResult {
  operator: Operator
  workers: Worker[]
  client: Client
}

export function seed(store: Store, now: string): SeedResult {
  const operatorId = randomUUID()

  const operator: Operator = {
    id: operatorId,
    legalName: 'Voorbeeld Escort B.V.',
    kvkNumber: '00000000',
    vergunningNumber: 'ESC-2026-0001',
    municipality: 'GM0363',
    vergunningValidFrom: '2026-01-01T00:00:00.000Z',
    vergunningValidUntil: '2027-01-01T00:00:00.000Z',
    suspendedAt: null,
    beheerderName: 'A. Beheerder',
    contactPhone: '+31600000000',
  }
  store.operators.set(operator.id, operator)

  const workers: Worker[] = [
    makeWorker(operatorId, 'Robin', '+31611111111', 'NL00BANK0000000001', '1996-04-12', now),
    makeWorker(operatorId, 'Sam', '+31622222222', 'NL00BANK0000000002', '1994-09-30', now),
  ]
  for (const w of workers) store.workers.set(w.id, w)

  // Availability covering the next 14 days, 18:00-02:00 in each worker's set.
  for (const worker of workers) {
    for (let day = 0; day < 14; day++) {
      const base = new Date(now)
      base.setUTCDate(base.getUTCDate() + day)
      const window: AvailabilityWindow = {
        id: randomUUID(),
        workerId: worker.id,
        startsAt: atUtcHour(base, 16),
        endsAt: atUtcHour(base, 24 + 1),
        municipality: 'GM0363',
        withdrawnAt: null,
      }
      store.availability.set(window.id, window)
    }
  }

  const client: Client = {
    id: randomUUID(),
    verificationLevel: 'idin_verified',
    phoneVerifiedAt: now,
    idinVerifiedAt: now,
    blockedAt: null,
    blockedReason: null,
    createdAt: now,
  }
  store.clients.set(client.id, client)

  return { operator, workers, client }
}

function makeWorker(
  operatorId: string,
  displayName: string,
  phone: string,
  iban: string,
  dateOfBirth: string,
  now: string,
): Worker {
  return {
    id: randomUUID(),
    operatorId,
    displayName,
    status: 'active',
    identity: {
      method: 'in_person_document_check',
      verifiedAt: now,
      verifiedBy: 'A. Beheerder',
      dateOfBirth,
      rightToWorkConfirmed: true,
      documentReferenceHash: 'seed-hash-not-a-real-document',
    },
    intake: {
      conductedAt: now,
      conductedBy: 'A. Beheerder',
      language: 'nl',
      conductedAlone: true,
      exitProgrammeInformationGiven: true,
      concerns: null,
    },
    servesMunicipalities: ['GM0363'],
    directPhone: phone,
    payoutIban: iban,
    boundaries: {
      refusedServices: [],
      earliestStartHour: 18,
      latestStartHour: 2,
      maxBookingMinutes: 180,
      allowedLocationTypes: ['hotel', 'private_residence'],
    },
    createdAt: now,
  }
}

function atUtcHour(base: Date, hour: number): string {
  const d = new Date(base)
  d.setUTCHours(hour % 24, 0, 0, 0)
  if (hour >= 24) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString()
}
