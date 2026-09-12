import { buildServer } from './api/server.js'
import { ConfigError, describeMode, loadConfig } from './config.js'
import { developmentRegistry } from './policy/municipality.js'
import { BookingService } from './services/booking-service.js'
import { createStore } from './store/memory.js'
import { seed } from './seed.js'

const now = () => new Date().toISOString()

let config
try {
  config = loadConfig()
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`\n${error.message}\n`)
    process.exit(1)
  }
  throw error
}

const store = createStore()
const registry = developmentRegistry()

const service = new BookingService(store, {
  registry,
  safetyGraceMinutes: 20,
  checkInGraceMinutes: 45,
  now,
})

console.log(`\ndeliverHO\n${describeMode(config)}\n`)

/**
 * Demo instances always seed. An empty demo is useless for the thing a demo is
 * for -- showing a reviewer what the safeguards actually do -- and the data is
 * synthetic, so there is nothing to protect by withholding it.
 */
if (config.mode === 'demo') {
  const { operator, workers, client } = seed(store, now())
  console.log('Synthetic data loaded:')
  console.log(`  operator ${operator.id} (vergunning ${operator.vergunningNumber})`)
  for (const w of workers) console.log(`  worker   ${w.id} (${w.displayName})`)
  console.log(`  client   ${client.id}\n`)
}

const app = buildServer({
  store,
  service,
  pseudonymKey: config.pseudonymKey,
  now,
  mode: config.mode,
  logLevel: config.logLevel,
  trustProxy: config.trustProxy,
})

/**
 * Graceful shutdown. An in-flight booking transition is cheap to lose, but an
 * open safety session is not: draining rather than dropping means a worker's
 * check-out is not rejected by a container that has stopped listening.
 */
let shuttingDown = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n${signal} received, draining...`)
    app
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(error)
        process.exit(1)
      })
  })
}

app
  .listen({ port: config.port, host: config.host })
  .then((address) => console.log(`Listening on ${address}`))
  .catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
