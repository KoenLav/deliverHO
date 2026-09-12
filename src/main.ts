import { buildServer } from './api/server.js'
import { developmentRegistry } from './policy/municipality.js'
import { BookingService } from './services/booking-service.js'
import { createStore } from './store/memory.js'
import { seed } from './seed.js'

const now = () => new Date().toISOString()

const store = createStore()
const registry = developmentRegistry()

const service = new BookingService(store, {
  registry,
  safetyGraceMinutes: 20,
  checkInGraceMinutes: 45,
  now,
})

/**
 * The pseudonym key is required, with no default. A development fallback here
 * would end up in production, and a predictable key makes the administration
 * pseudonyms re-linkable to people -- which is the one thing they exist to
 * prevent.
 */
const pseudonymKey = process.env['PSEUDONYM_KEY']
if (pseudonymKey === undefined || pseudonymKey.length < 32) {
  console.error(
    'PSEUDONYM_KEY must be set to at least 32 characters. Generate one with:\n' +
      "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  )
  process.exit(1)
}

if (process.env['SEED'] === '1') {
  const { operator, workers, client } = seed(store, now())
  console.log('Seeded development data:')
  console.log(`  operator ${operator.id} (vergunning ${operator.vergunningNumber})`)
  for (const w of workers) console.log(`  worker   ${w.id} (${w.displayName})`)
  console.log(`  client   ${client.id}`)
}

const app = buildServer({ store, service, pseudonymKey, now })
const port = Number(process.env['PORT'] ?? 3000)

app
  .listen({ port, host: '127.0.0.1' })
  .then(() => console.log(`deliverHO API listening on http://127.0.0.1:${port}`))
  .catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
