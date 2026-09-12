import { createHmac } from 'node:crypto'
import type { Uuid } from '../domain/types.js'

/**
 * Worker pseudonyms for the municipal administration.
 *
 * Keyed HMAC rather than a plain hash: worker ids are UUIDs, but the set of
 * workers at one operator is small, so an unkeyed digest of every id is
 * trivially reversible by anyone who obtains the id list. The key lives outside
 * the database, so a database-only breach does not re-link the administration
 * to people.
 */
export function pseudonymFor(workerId: Uuid, key: string): string {
  if (key.length < 32) {
    throw new Error('Pseudonym key must be at least 32 characters.')
  }
  return createHmac('sha256', key).update(workerId).digest('base64url').slice(0, 16)
}
