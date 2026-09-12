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

/** Addresses that reach only this machine. Anything else is exposed. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

/**
 * HTTP basic credentials guarding a demo instance.
 *
 * Not security in any deep sense -- it is a curtain. Its job is to keep a demo
 * of an escort booking service, run by a business that does not yet hold a
 * vergunning, out of search results and off the screen of the gemeente
 * official assessing that very application.
 */
export interface AccessGate {
  user: string
  password: string
}

export interface Config {
  mode: DeployMode
  port: number
  host: string
  pseudonymKey: string
  /** Set whenever a demo instance is reachable from outside the machine. */
  accessGate: AccessGate | null
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

  const host = env['HOST'] ?? '0.0.0.0'

  /**
   * A demo bound to anything but loopback is reachable by someone else, so by
   * default it needs the curtain. Keying that on the bind address rather than
   * on a flag means a container -- which is exposed by definition -- cannot be
   * started ungated by forgetting to set something.
   *
   * DEMO_PUBLIC=1 serves it openly on purpose. That is a legitimate choice for
   * a demo carrying nothing but synthetic data, but it stays opt-out rather
   * than default: going public should be a decision someone made, never the
   * result of an unset variable.
   */
  let accessGate: AccessGate | null = null
  if (mode === 'demo' && !isLoopback(host)) {
    const user = env['DEMO_ACCESS_USER'] ?? ''
    const password = env['DEMO_ACCESS_PASSWORD'] ?? ''
    const deliberatelyPublic = env['DEMO_PUBLIC'] === '1'

    if (deliberatelyPublic && user.trim() === '' && password === '') {
      accessGate = null
    } else if (user.trim() === '' || password === '') {
      problems.push(
        `This demo binds to ${host}, so it is reachable from outside this machine.\n` +
          '      Either gate it with DEMO_ACCESS_USER and DEMO_ACCESS_PASSWORD, or set\n' +
          '      DEMO_PUBLIC=1 to serve it openly on purpose, or bind HOST=127.0.0.1.',
      )
    } else if (password.length < 16) {
      problems.push(
        'DEMO_ACCESS_PASSWORD must be at least 16 characters. Generate one with:\n' +
          '      node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"',
      )
    } else {
      accessGate = { user, password }
    }
  }

  if (problems.length > 0) throw new ConfigError(problems)

  return {
    mode,
    port,
    host,
    pseudonymKey,
    accessGate,
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
      config.accessGate !== null
        ? '  Gated behind HTTP basic auth, and excluded from search indexing.'
        : isLoopback(config.host)
          ? '  Not gated -- bound to loopback, reachable only from this machine.'
          : '  PUBLIC -- open to anyone with the URL. Excluded from search indexing only.',
    ].join('\n')
  }
  return `  MODE: LIVE -- vergunning ${config.vergunningNumber}`
}
