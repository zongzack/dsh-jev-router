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

  it('rejects duplicate candidates while allowing an independent fallback model', () => {
    const settings = defaultSettings({ provider: 'ctapi', model: 'deepseek-v4-pro-vip' })
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
  it('sends a bearer credential and validates the structured choice', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer secret')
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'jev-latest',
        reasoning: { enabled: true, options: [{ provider: 'ctapi', model: 'deepseek-v4-pro-vip', efforts: ['small', 'large'] }] },
      })
      return new Response(JSON.stringify({
        result: {
          provider: 'ctapi', model: 'deepseek-v4-pro-vip', reasoningEffort: 'large', confidence: 0.2, jevVersion: 'jev-test',
        },
        usage: { inputTokens: 21, outputTokens: 3 },
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

  it('rejects malformed reasoning and confidence without partially accepting the route', async () => {
    const settings = defaultSettings({ provider: 'ctapi', model: 'deepseek-v4-pro-vip' })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ result: {
      provider: 'ctapi', model: 'deepseek-v4-pro-vip', reasoningEffort: 3,
    } }), { status: 200 }))
    await expect(classifyWithJev({ input: 'hello', candidates: settings.candidateModels }, settings, 'secret', new AbortController().signal, { fetch }))
      .rejects.toThrow(/invalid reasoning effort/)
  })

  it('rejects malformed classification usage rather than recording guessed metrics', async () => {
    const settings = defaultSettings({ provider: 'ctapi', model: 'deepseek-v4-pro-vip' })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      result: { provider: 'ctapi', model: 'deepseek-v4-pro-vip' },
      usage: { inputTokens: 'unknown', outputTokens: 1 },
    }), { status: 200 }))
    await expect(classifyWithJev({ input: 'hello', candidates: settings.candidateModels }, settings, 'secret', new AbortController().signal, { fetch }))
      .rejects.toThrow(/inputTokens usage/)
  })
})
