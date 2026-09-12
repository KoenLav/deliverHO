import { describe, expect, it } from 'vitest'
import { ConfigError, describeMode, loadConfig } from '../src/config.js'

const KEY = 'k'.repeat(32)

function load(env: Record<string, string | undefined>) {
  return loadConfig(env as NodeJS.ProcessEnv)
}

function problemsFrom(env: Record<string, string | undefined>): string[] {
  try {
    load(env)
    return []
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
}

describe('mode is never guessed', () => {
  it('refuses to boot with no DEPLOY_MODE', () => {
    expect(() => load({ PSEUDONYM_KEY: KEY })).toThrow(ConfigError)
  })

  it('refuses an unrecognised mode', () => {
    expect(() => load({ DEPLOY_MODE: 'staging', PSEUDONYM_KEY: KEY })).toThrow(ConfigError)
  })

  it('says so in a way someone can act on', () => {
    const problems = problemsFrom({ PSEUDONYM_KEY: KEY })
    expect(problems[0]).toContain('DEPLOY_MODE')
    expect(problems[0]).toContain('demo')
    expect(problems[0]).toContain('live')
  })
})

describe('demo mode', () => {
  it('boots with just a pseudonym key when bound to loopback', () => {
    const config = load({ DEPLOY_MODE: 'demo', PSEUDONYM_KEY: KEY, HOST: '127.0.0.1' })
    expect(config.mode).toBe('demo')
    expect(config.vergunningNumber).toBeNull()
  })

  it('still refuses a weak pseudonym key', () => {
    expect(problemsFrom({ DEPLOY_MODE: 'demo', PSEUDONYM_KEY: 'short' })[0]).toContain(
      'PSEUDONYM_KEY',
    )
  })

  it('refuses production configuration', () => {
    // A demo handed a real database is how a demo quietly becomes production.
    const problems = problemsFrom({
      DEPLOY_MODE: 'demo',
      PSEUDONYM_KEY: KEY,
      DATABASE_URL: 'postgres://real/db',
    })
    expect(problems.join(' ')).toContain('DATABASE_URL')
  })

  it('refuses a real vergunning number', () => {
    const problems = problemsFrom({
      DEPLOY_MODE: 'demo',
      PSEUDONYM_KEY: KEY,
      OPERATOR_VERGUNNING: 'ESC-2026-0001',
    })
    expect(problems.join(' ')).toContain('OPERATOR_VERGUNNING')
  })

  it('warns unmistakably in its own description', () => {
    const text = describeMode(load({ DEPLOY_MODE: 'demo', PSEUDONYM_KEY: KEY, HOST: '127.0.0.1' }))
    expect(text).toContain('DEMO')
    expect(text).toContain('Do not enter real')
  })
})

describe('live mode cannot boot yet', () => {
  it('refuses with nothing configured', () => {
    expect(() => load({ DEPLOY_MODE: 'live', PSEUDONYM_KEY: KEY })).toThrow(ConfigError)
  })

  it('names every missing requirement at once', () => {
    const problems = problemsFrom({ DEPLOY_MODE: 'live', PSEUDONYM_KEY: KEY }).join('\n')
    expect(problems).toContain('AUTH_PROVIDER_URL')
    expect(problems).toContain('DATABASE_URL')
    expect(problems).toContain('OPERATOR_VERGUNNING')
  })

  it('explains why each one matters rather than just naming it', () => {
    const problems = problemsFrom({ DEPLOY_MODE: 'live', PSEUDONYM_KEY: KEY }).join('\n')
    expect(problems).toContain('x-actor-id')
    expect(problems).toContain('vergunning')
  })

  it('still refuses when only some requirements are met', () => {
    const problems = problemsFrom({
      DEPLOY_MODE: 'live',
      PSEUDONYM_KEY: KEY,
      DATABASE_URL: 'postgres://x/y',
      OPERATOR_VERGUNNING: 'ESC-2026-0001',
    })
    expect(problems.join(' ')).toContain('AUTH_PROVIDER_URL')
  })

  it('accepts a fully configured live environment', () => {
    // Guards the shape, not the readiness: satisfying these variables is
    // necessary and nowhere near sufficient. See docs/deployment.md.
    const config = load({
      DEPLOY_MODE: 'live',
      PSEUDONYM_KEY: KEY,
      AUTH_PROVIDER_URL: 'https://idp.example',
      DATABASE_URL: 'postgres://x/y',
      OPERATOR_VERGUNNING: 'ESC-2026-0001',
    })
    expect(config.mode).toBe('live')
    expect(config.vergunningNumber).toBe('ESC-2026-0001')
  })
})

describe('other settings', () => {
  it('rejects a nonsense port', () => {
    const problems = problemsFrom({
      DEPLOY_MODE: 'demo', PSEUDONYM_KEY: KEY, HOST: '127.0.0.1', PORT: 'abc',
    })
    expect(problems.join(' ')).toContain('PORT')
  })

  it('does not trust a proxy unless told to', () => {
    const base = { DEPLOY_MODE: 'demo', PSEUDONYM_KEY: KEY, HOST: '127.0.0.1' }
    expect(load(base).trustProxy).toBe(false)
    expect(load({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(true)
  })
})

describe('the demo access gate', () => {
  const base = { DEPLOY_MODE: 'demo', PSEUDONYM_KEY: KEY }
  const PASSWORD = 'a'.repeat(20)

  it('is not required when bound to loopback', () => {
    expect(load({ ...base, HOST: '127.0.0.1' }).accessGate).toBeNull()
    expect(load({ ...base, HOST: 'localhost' }).accessGate).toBeNull()
  })

  it('is required the moment the demo binds to anything else', () => {
    // 0.0.0.0 is the container default, so a container cannot start ungated
    // by accident -- going public has to be stated.
    const problems = problemsFrom({ ...base, HOST: '0.0.0.0' }).join(' ')
    expect(problems).toContain('DEMO_ACCESS_USER')
    expect(problems).toContain('DEMO_ACCESS_PASSWORD')
  })

  it('names every way out, not just the gate', () => {
    const problems = problemsFrom({ ...base, HOST: '0.0.0.0' }).join(' ')
    expect(problems).toContain('DEMO_PUBLIC=1')
    expect(problems).toContain('HOST=127.0.0.1')
  })

  it('defaults to a bindable host, so the default is gated', () => {
    expect(problemsFrom(base).join(' ')).toContain('DEMO_ACCESS_USER')
  })

  it('rejects a short password', () => {
    const problems = problemsFrom({
      ...base,
      HOST: '0.0.0.0',
      DEMO_ACCESS_USER: 'reviewer',
      DEMO_ACCESS_PASSWORD: 'short',
    }).join(' ')
    expect(problems).toContain('16 characters')
  })

  it('accepts a properly configured gate', () => {
    const config = load({
      ...base,
      HOST: '0.0.0.0',
      DEMO_ACCESS_USER: 'reviewer',
      DEMO_ACCESS_PASSWORD: PASSWORD,
    })
    expect(config.accessGate).toEqual({ user: 'reviewer', password: PASSWORD })
  })

  it('serves openly when DEMO_PUBLIC is set', () => {
    const config = load({ ...base, HOST: '0.0.0.0', DEMO_PUBLIC: '1' })
    expect(config.accessGate).toBeNull()
  })

  it('keeps the gate when credentials are set, even with DEMO_PUBLIC', () => {
    // Explicit credentials are the stronger statement of intent: someone who
    // set a password wants the curtain, whatever else is in the environment.
    const config = load({
      ...base, HOST: '0.0.0.0', DEMO_PUBLIC: '1',
      DEMO_ACCESS_USER: 'reviewer', DEMO_ACCESS_PASSWORD: PASSWORD,
    })
    expect(config.accessGate).toEqual({ user: 'reviewer', password: PASSWORD })
  })

  it('does not treat any other DEMO_PUBLIC value as public', () => {
    for (const value of ['true', 'yes', '0', '', 'TRUE']) {
      expect(problemsFrom({ ...base, HOST: '0.0.0.0', DEMO_PUBLIC: value }).length).toBeGreaterThan(0)
    }
  })

  it('does not gate live mode, which has real authentication', () => {
    const config = load({
      DEPLOY_MODE: 'live',
      PSEUDONYM_KEY: KEY,
      HOST: '0.0.0.0',
      AUTH_PROVIDER_URL: 'https://idp.example',
      DATABASE_URL: 'postgres://x/y',
      OPERATOR_VERGUNNING: 'ESC-2026-0001',
    })
    expect(config.accessGate).toBeNull()
  })
})
