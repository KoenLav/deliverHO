/**
 * Deployment configuration, validated at boot.
 *
 * The platform runs in one of two modes, and the difference is not cosmetic:
 *
 *   demo -- synthetic data, header-based actor identification, nothing
 *     persisted. Safe to expose for review by a lawyer, a gemeente, or a
 *     prospective worker. Cannot hold real people's data because it cannot
 *     hold anything: the store is in-memory and dies with the process.
 *
 *   live -- real people, real bookings. Requires things that do not exist yet
 *     (see LIVE_REQUIREMENTS below), so booting in this mode currently fails
 *     with a list of what is missing. That is the honest state of the world,
 *     and a flag that pretended otherwise would be worse than no flag.
 *
 * Everything here fails closed. An unset mode is an error rather than a
 * default, because the safe default and the useful default are different modes
 * and guessing either one is wrong.
 */

export type DeployMode = 'demo' | 'live'

export interface Config {
  mode: DeployMode
  port: number
  host: string
  pseudonymKey: string
  /** Municipal licence number. Required in live mode; absent in demo. */
  vergunningNumber: string | null
  /** Trust an upstream proxy's X-Forwarded-For. Only where one really exists. */
  trustProxy: boolean
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug'
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Configuration is not valid:\n  - ${problems.join('\n  - ')}`)
    this.name = 'ConfigError'
  }
}

/**
 * What live mode needs before it can carry a real booking. Each entry names the
 * gap and where it is discussed. None of these are checkboxes -- they are the
 * reasons this platform is not ready for a real worker.
 */
const LIVE_REQUIREMENTS: { env: string; what: string; why: string }[] = [
  {
    env: 'AUTH_PROVIDER_URL',
    what: 'a real authentication provider',
    why:
      'The API identifies actors from an x-actor-id header. In live mode that ' +
      'would let anyone accept bookings as any worker. See docs/threat-model.md T6.',
  },
  {
    env: 'DATABASE_URL',
    what: 'a Postgres database',
    why:
      'The store is in-memory. Live bookings and the municipal administration ' +
      'must survive a restart. See db/schema.sql.',
  },
  {
    env: 'OPERATOR_VERGUNNING',
    what: 'the municipal licence number',
    why:
      'Operating an escortbedrijf without a vergunning is an offence, and the ' +
      'number must appear in every advertisement. See docs/functional-design.md section 1.',
  },
]

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = []

  const rawMode = env['DEPLOY_MODE']
  if (rawMode !== 'demo' && rawMode !== 'live') {
    throw new ConfigError([
      'DEPLOY_MODE must be set to "demo" or "live". There is no default: the ' +
        'safe default and the useful default are different modes.',
    ])
  }
  const mode: DeployMode = rawMode

  const pseudonymKey = env['PSEUDONYM_KEY'] ?? ''
  if (pseudonymKey.length < 32) {
    problems.push(
      'PSEUDONYM_KEY must be at least 32 characters. Generate one with:\n' +
        '      node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    )
  }

  const port = Number(env['PORT'] ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT must be a valid port number (got "${env['PORT']}").`)
  }

  let vergunningNumber: string | null = null

  if (mode === 'live') {
    for (const requirement of LIVE_REQUIREMENTS) {
      const value = env[requirement.env]
      if (value === undefined || value.trim() === '') {
        problems.push(
          `${requirement.env} is not set -- live mode needs ${requirement.what}.\n` +
            `      ${requirement.why}`,
        )
      }
    }
    vergunningNumber = env['OPERATOR_VERGUNNING'] ?? null
  } else {
    // Guard against a demo instance being handed real credentials and quietly
    // becoming a half-configured production system.
    const liveOnly = LIVE_REQUIREMENTS.map((r) => r.env).filter(
      (name) => (env[name] ?? '').trim() !== '',
    )
    if (liveOnly.length > 0) {
      problems.push(
        `Demo mode must not be given production configuration, but ${liveOnly.join(', ')} ` +
          'is set. Either unset it, or set DEPLOY_MODE=live and configure the rest.',
      )
    }
  }

  if (problems.length > 0) throw new ConfigError(problems)

  return {
    mode,
    port,
    host: env['HOST'] ?? '0.0.0.0',
    pseudonymKey,
    vergunningNumber,
    trustProxy: env['TRUST_PROXY'] === '1',
    logLevel: (env['LOG_LEVEL'] as Config['logLevel']) ?? 'info',
  }
}

/** Shown at boot so nobody has to guess which mode an instance is running in. */
export function describeMode(config: Config): string {
  if (config.mode === 'demo') {
    return [
      '  MODE: DEMO -- synthetic data only.',
      '  Nothing is persisted; the store dies with the process.',
      '  Actor identification is header-based and trivially forgeable.',
      '  Do not enter real worker, client or booking data into this instance.',
    ].join('\n')
  }
  return `  MODE: LIVE -- vergunning ${config.vergunningNumber}`
}
