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
  it('boots with just a pseudonym key', () => {
    const config = load({ DEPLOY_MODE: 'demo', PSEUDONYM_KEY: KEY })
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
    const text = describeMode(load({ DEPLOY_MODE: 'demo', PSEUDONYM_KEY: KEY }))
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
    expect(problemsFrom({ DEPLOY_MODE: 'demo', PSEUDONYM_KEY: KEY, PORT: 'abc' })[0]).toContain(
      'PORT',
    )
  })

  it('does not trust a proxy unless told to', () => {
    expect(load({ DEPLOY_MODE: 'demo', PSEUDONYM_KEY: KEY }).trustProxy).toBe(false)
    expect(load({ DEPLOY_MODE: 'demo', PSEUDONYM_KEY: KEY, TRUST_PROXY: '1' }).trustProxy).toBe(true)
  })
})
