import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CANDIDATES, defaultSettings, validateSettings,
} from '../src/config.ts'
import { boundJevState, classifyWithJev } from '../src/jev.ts'

describe('jev-router configuration', () => {
  it('starts disabled with the two explicit ctapi candidates', () => {
    const settings = defaultSettings({ provider: 'ctapi', model: 'deepseek-v4-pro-vip' })
    expect(settings.enabled).toBe(false)
    expect(settings.candidateModels).toEqual(DEFAULT_CANDIDATES)
    expect(settings.defaultModel).toEqual({ provider: 'ctapi', model: 'deepseek-v4-pro-vip' })
  })

  it('rejects duplicate candidates and a default outside the allow-list', () => {
    const settings = defaultSettings({ provider: 'ctapi', model: 'deepseek-v4-pro-vip' })
    expect(() => validateSettings({
      ...settings,
      candidateModels: [settings.candidateModels[0]!, settings.candidateModels[0]!],
    })).toThrow(/duplicate/)
    expect(() => validateSettings({
      ...settings,
      defaultModel: { provider: 'other', model: 'missing' },
    })).toThrow(/one of candidateModels/)
  })
})

describe('Jev transport', () => {
  it('sends a bearer credential and validates the structured choice', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer secret')
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'jev-latest' })
      return new Response(JSON.stringify({ result: {
        provider: 'ctapi', model: 'deepseek-v4-pro-vip', jevVersion: 'jev-test',
      } }), { status: 200 })
    })
    const settings = defaultSettings({ provider: 'ctapi', model: 'deepseek-v4-pro-vip' })
    await expect(classifyWithJev({ input: 'hello', candidates: settings.candidateModels }, settings, 'secret', new AbortController().signal, { fetch }))
      .resolves.toMatchObject({ provider: 'ctapi', model: 'deepseek-v4-pro-vip', jevVersion: 'jev-test' })
  })

  it('bounds oversized classification material and preserves truncation evidence', () => {
    const bounded = boundJevState({ input: 'a'.repeat(100), candidates: DEFAULT_CANDIDATES }, 50)
    expect(JSON.stringify(bounded).length).toBeGreaterThan(0)
    expect(bounded.input.length).toBeLessThan(100)
    expect((bounded as { truncated?: boolean }).truncated).toBe(true)
  })
})
