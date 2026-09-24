import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_API_KEY, DEFAULT_CANDIDATES, defaultSettings, validateSettings,
} from '../src/config.ts'
import { boundJevState, classifyWithJev } from '../src/jev.ts'

describe('jev-router configuration', () => {
  it('starts disabled with the two explicit ctapi candidates', () => {
    const settings = defaultSettings({ provider: 'ctapi', model: 'deepseek-v4-pro-vip' })
    expect(settings.enabled).toBe(false)
    expect(settings.apiKey).toBe(DEFAULT_API_KEY)
    expect(settings.candidateModels).toEqual(DEFAULT_CANDIDATES)
    expect(settings.defaultModel).toEqual({ provider: 'ctapi', model: 'deepseek-v4-pro-vip' })
  })

  it('accepts a direct API key while allowing an independent fallback model', () => {
    const settings = defaultSettings({ provider: 'ctapi', model: 'deepseek-v4-pro-vip' })
    expect(() => validateSettings({ ...settings, apiKey: 'jev-secret' })).not.toThrow()
    expect(() => validateSettings({
      ...settings,
      candidateModels: [settings.candidateModels[0]!, settings.candidateModels[0]!],
    })).toThrow(/duplicate/)
    expect(() => validateSettings({
      ...settings,
      defaultModel: { provider: 'other', model: 'missing' },
    })).not.toThrow()
  })

  it('rejects non-integer thresholds and hold counts without accepting a partial update', () => {
    const settings = defaultSettings({ provider: 'ctapi', model: 'deepseek-v4-pro-vip' })
    expect(() => validateSettings({ ...settings, switchContextLimitTokens: 1.5 })).toThrow(/switchContextLimitTokens/)
    expect(() => validateSettings({ ...settings, minHoldUserTurns: -1 })).toThrow(/minHoldUserTurns/)
    expect(() => validateSettings({ ...settings, minHoldUserTurns: 0.5 })).toThrow(/minHoldUserTurns/)
    expect(() => validateSettings({ ...settings, switchContextLimitTokens: null, minHoldUserTurns: 0 })).not.toThrow()
  })
})

describe('Jev transport', () => {
  it('uses the current System One endpoint and maps a typed Choice answer back to one route', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(String(input)).toBe('https://api.typesafe.ai/v1/systemone')
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer secret')
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'jev-latest',
        state: {
          input: 'hello',
          reasoning: {
            enabled: true,
            options: [{ provider: 'ctapi', model: 'deepseek-v4-pro-vip', efforts: ['small', 'large'] }],
          },
        },
        questions: {
          model: {
            type: 'choice',
            instructions: expect.any(String),
            criteria: {
              route_0: {
                provider: 'ctapi', model: 'deepseek-v4-flash-vip', tier: 'economy',
                reasoningEffort: 'adapter-default',
              },
              route_1: {
                provider: 'ctapi', model: 'deepseek-v4-pro-vip', tier: 'capability', reasoningEffort: 'small',
              },
              route_2: {
                provider: 'ctapi', model: 'deepseek-v4-pro-vip', tier: 'capability', reasoningEffort: 'large',
              },
            },
          },
        },
      })
      return new Response(JSON.stringify({
        model: 'jev-test',
        answers: {
          model: {
            type: 'choice', choice: 'route_2', confidence: 0.2,
            probabilities: { route_0: 0.1, route_1: 0.2, route_2: 0.7 },
          },
        },
        usage: { input_tokens: 21, output_tokens: 3 },
      }), { status: 200 })
    })
    const settings = defaultSettings({ provider: 'ctapi', model: 'deepseek-v4-pro-vip' })
    await expect(classifyWithJev({
      input: 'hello',
      candidates: settings.candidateModels,
      reasoning: {
        enabled: true,
        options: [{ provider: 'ctapi', model: 'deepseek-v4-pro-vip', efforts: ['small', 'large'] }],
      },
    }, settings, 'secret', new AbortController().signal, { fetch }))
      .resolves.toMatchObject({
        provider: 'ctapi', model: 'deepseek-v4-pro-vip', reasoningEffort: 'large', confidence: 0.2, jevVersion: 'jev-test',
        classificationUsage: {
          inputTokens: 21, outputTokens: 3, cacheReadTokens: null, cacheWriteTokens: null,
        },
      })
  })

  it('bounds oversized classification material and preserves truncation evidence', () => {
    expect(() => boundJevState({ input: 'a'.repeat(100), candidates: DEFAULT_CANDIDATES }, 50)).toThrow(/too small/)
    const bounded = boundJevState({ input: 'a'.repeat(100), candidates: DEFAULT_CANDIDATES }, 300)
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(300)
    expect(bounded.input.length).toBeLessThan(100)
    expect((bounded as { truncated?: boolean }).truncated).toBe(true)
  })

  it('keeps relevant cache evidence inside the total serialized state budget', () => {
    const bounded = boundJevState({
      input: 'x'.repeat(300),
      context: ['older context'.repeat(20)],
      candidates: DEFAULT_CANDIDATES,
      cache: {
        route: { provider: 'ctapi', model: 'deepseek-v4-pro-vip' },
        evidence: { status: 'known', cacheReadTokens: 0, uncachedInputTokens: 50, observedAt: 123 },
      },
    }, 600)
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(600)
    expect(bounded.cache).toMatchObject({ evidence: { status: 'known', cacheReadTokens: 0 } })
    expect(bounded.truncated).toBe(true)
  })

  it('counts Unicode code points and truncates an oversized individual context item', () => {
    const bounded = boundJevState({
      input: '继续🙂'.repeat(80),
      context: ['工具结果🙂'.repeat(100)],
      candidates: DEFAULT_CANDIDATES,
    }, 420)
    expect(Array.from(JSON.stringify(bounded)).length).toBeLessThanOrEqual(420)
    expect(bounded.context?.[0]).not.toBe('')
    expect(bounded.truncated).toBe(true)
  })

  it('retains a non-empty current input or rejects a budget that cannot contain it', () => {
    const oversizedInput = '继续处理这个请求'.repeat(20)
    const minimum = {
      input: '继',
      candidates: DEFAULT_CANDIDATES,
      truncated: true as const,
    }
    const minimumChars = Array.from(JSON.stringify(minimum)).length
    expect(boundJevState({
      input: oversizedInput,
      context: ['older evidence'],
      candidates: DEFAULT_CANDIDATES,
    }, minimumChars)).toEqual(minimum)
    expect(() => boundJevState({
      input: oversizedInput,
      candidates: DEFAULT_CANDIDATES,
    }, minimumChars - 1)).toThrow(/current input/)
  })

  it('rejects an unknown typed Choice answer without partially accepting a route', async () => {
    const settings = defaultSettings({ provider: 'ctapi', model: 'deepseek-v4-pro-vip' })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      model: 'jev-test',
      answers: { model: { type: 'choice', choice: 'route_missing', confidence: 0.5 } },
    }), { status: 200 }))
    await expect(classifyWithJev({ input: 'hello', candidates: settings.candidateModels }, settings, 'secret', new AbortController().signal, { fetch }))
      .rejects.toThrow(/unknown model choice/)
  })

  it('rejects malformed classification usage rather than recording guessed metrics', async () => {
    const settings = defaultSettings({ provider: 'ctapi', model: 'deepseek-v4-pro-vip' })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      model: 'jev-test',
      answers: { model: { type: 'choice', choice: 'route_0', confidence: 0.5 } },
      usage: { input_tokens: 'unknown', output_tokens: 1 },
    }), { status: 200 }))
    await expect(classifyWithJev({ input: 'hello', candidates: settings.candidateModels }, settings, 'secret', new AbortController().signal, { fetch }))
      .rejects.toThrow(/inputTokens usage/)
  })
})
