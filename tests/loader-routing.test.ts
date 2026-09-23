import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage, LlmAdapter, ReasoningEffortId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Commands from '@deepseek-ai/dsh-commands'
import * as JevRouter from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private storedDocument: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.storedDocument))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storedDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly reasoning = true) { super() }

  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: 200_000 },
      defaultMaxTokens: 1,
      ...(this.reasoning ? {
        reasoning: {
          efforts: [
            { id: ReasoningEffortId('off'), name: 'Off' },
            { id: ReasoningEffortId('low'), name: 'Low' },
            { id: ReasoningEffortId('high'), name: 'High' },
            { id: ReasoningEffortId('max'), name: 'Max' },
          ],
          defaultEffort: ReasoningEffortId('high'),
        },
      } : {}),
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 1, cacheReadTokens: 7 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class BlockingFallbackAdapter extends RecordingAdapter {
  private matches = 0

  constructor(
    private readonly fallbackModel: string,
    private readonly started: (signal: AbortSignal) => void,
    private readonly blockOnMatch = 1,
  ) { super() }

  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (model !== this.fallbackModel) return super.resolveModel(provider, model, signal)
    this.matches++
    if (this.matches !== this.blockOnMatch) return super.resolveModel(provider, model, signal)
    const activeSignal = signal ?? new AbortController().signal
    this.started(activeSignal)
    return new Promise((_resolve, reject) => {
      activeSignal.addEventListener('abort', () => reject(activeSignal.reason), { once: true })
    })
  }
}

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadRouter(options: {
  resolveCredential?: () => Promise<{ value: string; source: string } | undefined>
} = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-jev-router-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-token-meter'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@zong/dsh-jev-router'",
    '  config:',
    "    endpoint: 'https://jev.invalid/test'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(MemorySettings)
  context.provide('credentials', {
    resolve: options.resolveCredential ?? (() => Promise.resolve({ value: 'secret', source: 'test' })),
  } as never)
  context.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'ctapi', model: 'deepseek-v4-pro-vip' }),
  } as never)
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-commands', Commands],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@zong/dsh-jev-router', JevRouter],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('real Loader routing composition', () => {
  it('does not opt sessions created while disabled into Auto until the user asks', async () => {
    let classifications = 0
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => {
      classifications++
      return new Response(JSON.stringify({ result: {
        provider: 'ctapi', model: 'deepseek-v4-flash-vip', reasoningEffort: 'high',
      } }), { status: 200 })
    }))
    const ctx = await loadRouter()
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['ctapi'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('created-disabled'), {
      provider: 'ctapi', model: 'deepseek-v4-pro-vip',
    })

    await ctx.settings.update('jev-router', {
      enabled: true, switchContextLimitTokens: null, minHoldUserTurns: 0,
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'remain fixed' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(classifications).toBe(0)
    expect(adapter.requests[0]?.model).toBe('deepseek-v4-pro-vip')

    await ctx.commands.execute(agent, '/jev-auto', [], new AbortController().signal)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'now use Auto' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(classifications).toBe(1)
    expect(adapter.requests[1]?.model).toBe('deepseek-v4-flash-vip')
  })

  it('saves guard settings, routes the final request, and isolates cache evidence per session', async () => {
    const suggestions = [
      'deepseek-v4-flash-vip',
      'deepseek-v4-flash-vip',
      'deepseek-v4-flash-vip',
      'deepseek-v4-pro-vip',
    ]
    const states: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { state: Record<string, unknown> }
      states.push(body.state)
      return new Response(JSON.stringify({ result: {
        provider: 'ctapi',
        model: suggestions.shift(),
      } }), { status: 200 })
    }))

    const ctx = await loadRouter()
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['ctapi'], adapter)
    await ctx.settings.update('jev-router', {
      enabled: true,
      switchContextLimitTokens: 1,
      overLimitPolicy: 'upgrade_only',
      minHoldUserTurns: 0,
      showDecision: false,
    })

    const first = await ctx.agentLoop.create(SessionId('first'), {
      provider: 'ctapi', model: 'deepseek-v4-pro-vip',
    })
    first.followup(createUserMessage({ content: [{ type: 'text', text: 'first request' }], source: { kind: 'user' } }))
    await first.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(states[0]?.cache).toMatchObject({ evidence: { status: 'unknown' } })

    await ctx.settings.update('jev-router', { switchContextLimitTokens: null })
    first.followup(createUserMessage({ content: [{ type: 'text', text: 'second request' }], source: { kind: 'user' } }))
    await first.whenIdle()
    expect(adapter.requests[1]?.model).toBe('deepseek-v4-flash-vip')
    expect(states[1]?.cache).toMatchObject({
      route: { provider: 'ctapi', model: 'deepseek-v4-pro-vip' },
      evidence: { status: 'known', cacheReadTokens: 7, uncachedInputTokens: 11 },
    })
    expect(states[1]?.context).toEqual(expect.arrayContaining([
      expect.stringContaining('first request'),
      expect.stringContaining('ok'),
    ]))

    await ctx.settings.update('jev-router', { switchContextLimitTokens: 1, cacheAware: false })
    const second = await ctx.agentLoop.create(SessionId('second'), {
      provider: 'ctapi', model: 'deepseek-v4-pro-vip',
    })
    second.followup(createUserMessage({ content: [{ type: 'text', text: 'isolated request' }], source: { kind: 'user' } }))
    await second.whenIdle()
    expect(adapter.requests[2]?.model).toBe('deepseek-v4-pro-vip')
    expect(states[2]?.cache).toBeUndefined()

    await ctx.settings.update('jev-router', { switchContextLimitTokens: null, cacheAware: true })
    const third = await ctx.agentLoop.create(SessionId('third'), {
      provider: 'ctapi', model: 'deepseek-v4-pro-vip',
    })
    third.followup(createUserMessage({ content: [{ type: 'text', text: 'fresh cache request' }], source: { kind: 'user' } }))
    await third.whenIdle()
    expect(adapter.requests[3]?.model).toBe('deepseek-v4-pro-vip')
    expect(states[3]?.cache).toMatchObject({ evidence: { status: 'unknown' } })
  })

  it('uses only adapter-advertised reasoning, preserves defaults when disabled, and rejects unsupported output', async () => {
    const decisions = [
      { provider: 'ctapi', model: 'deepseek-v4-pro-vip', reasoningEffort: 'max' },
      { provider: 'ctapi', model: 'deepseek-v4-flash-vip', reasoningEffort: 'invented' },
      { provider: 'ctapi', model: 'deepseek-v4-flash-vip', reasoningEffort: 'max' },
    ]
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ result: decisions.shift() }), { status: 200 })
    }))
    const ctx = await loadRouter()
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['ctapi'], adapter)
    await ctx.settings.update('jev-router', {
      enabled: true, switchContextLimitTokens: null, minHoldUserTurns: 0, showDecision: true,
    })
    const agent = await ctx.agentLoop.create(SessionId('reasoning'), {
      provider: 'ctapi', model: 'deepseek-v4-pro-vip', reasoningEffort: ReasoningEffortId('low'),
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'analyze this' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests[0]).toMatchObject({ model: 'deepseek-v4-pro-vip', reasoningEffort: 'max' })
    expect(bodies[0]).toMatchObject({
      reasoning: { enabled: true },
      state: { reasoning: { options: expect.arrayContaining([
        { provider: 'ctapi', model: 'deepseek-v4-pro-vip', efforts: ['off', 'low', 'high', 'max'] },
      ]) } },
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests[1]).toMatchObject({ model: 'deepseek-v4-pro-vip' })
    expect(adapter.requests[1]?.reasoningEffort).toBe('max')
    expect(ctx.sessionProjections.stateOf(agent.session, 'jevRouterHistory')?.latestDecision)
      .toMatchObject({ reason: 'fallback', fallback: expect.stringContaining('unsupported reasoning effort') })

    await ctx.settings.update('jev-router', { routeReasoning: false })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one more' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests[2]?.model).toBe('deepseek-v4-flash-vip')
    expect(adapter.requests[2]?.reasoningEffort).toBe('high')
    expect(bodies[2]).toMatchObject({ reasoning: { enabled: false } })
  })

  it('validates confidence without inventing a confidence routing rule and supports models without reasoning', async () => {
    const decisions = [
      { provider: 'ctapi', model: 'deepseek-v4-flash-vip', confidence: 0.2, jevVersion: 'jev-test' },
      { provider: 'ctapi', model: 'deepseek-v4-flash-vip', confidence: 0.9, jevVersion: 'jev-test' },
    ]
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      result: decisions.shift(),
    }), { status: 200 })))
    const ctx = await loadRouter()
    const adapter = new RecordingAdapter(false)
    ctx.llm.registerAdapter(['ctapi'], adapter)
    await ctx.settings.update('jev-router', {
      enabled: true, switchContextLimitTokens: null, minHoldUserTurns: 0, showDecision: true,
    })
    const agent = await ctx.agentLoop.create(SessionId('confidence'), {
      provider: 'ctapi', model: 'deepseek-v4-pro-vip',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests[0]?.model).toBe('deepseek-v4-flash-vip')
    expect(ctx.sessionProjections.stateOf(agent.session, 'jevRouterHistory')?.latestDecision)
      .toMatchObject({ reason: 'suggestion_applied', reasoningSupported: false, jevVersion: 'jev-test' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests[1]?.model).toBe('deepseek-v4-flash-vip')
    expect(ctx.sessionProjections.stateOf(agent.session, 'jevRouterHistory')?.latestDecision)
      .toMatchObject({ reason: 'suggestion_applied', reasoningSupported: false })
  })

  it('cancels an in-flight classification for manual fixed mode and resumes only after durable Auto mode', async () => {
    const first = Promise.withResolvers<Response>()
    const started = Promise.withResolvers<AbortSignal>()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      calls++
      const signal = init?.signal as AbortSignal
      if (calls > 1) return new Response(JSON.stringify({ result: {
        provider: 'ctapi', model: 'deepseek-v4-flash-vip', reasoningEffort: 'high',
      } }), { status: 200 })
      started.resolve(signal)
      signal.addEventListener('abort', () => first.reject(signal.reason), { once: true })
      return first.promise
    }))
    const ctx = await loadRouter()
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['ctapi'], adapter)
    await ctx.settings.update('jev-router', { enabled: true, switchContextLimitTokens: null, minHoldUserTurns: 0 })
    const agent = await ctx.agentLoop.create(SessionId('manual'), {
      provider: 'ctapi', model: 'deepseek-v4-pro-vip',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'route me' }], source: { kind: 'user' } }))
    const signal = await started.promise
    agent.session.append('model/selection', { provider: 'ctapi', model: 'deepseek-v4-pro-vip' })
    expect(signal.aborted).toBe(true)
    first.resolve(new Response(JSON.stringify({ result: {
      provider: 'ctapi', model: 'deepseek-v4-flash-vip', reasoningEffort: 'high',
    } }), { status: 200 }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.model).toBe('deepseek-v4-pro-vip')

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'still fixed' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(calls).toBe(1)
    expect(adapter.requests[1]?.model).toBe('deepseek-v4-pro-vip')

    const auto = await ctx.commands.execute(agent, '/jev-auto', [], new AbortController().signal)
    expect(auto?.result).toMatchObject({ kind: 'success' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Auto again' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(calls).toBe(2)
    expect(adapter.requests[2]?.model).toBe('deepseek-v4-flash-vip')
    expect(ctx.sessionProjections.stateOf(agent.session, 'jevRouterHistory')?.mode).toBe('auto')

    const fixed = await ctx.commands.execute(agent, '/jev-fixed', [], new AbortController().signal)
    expect(fixed?.result).toMatchObject({ kind: 'success' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'fix the automatic route' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(calls).toBe(2)
    expect(adapter.requests[3]?.model).toBe('deepseek-v4-flash-vip')
    expect(ctx.sessionProjections.stateOf(agent.session, 'jevRouterHistory')?.mode).toBe('fixed')

    const commandFixedSeed = agent.session.snapshotEvents() as readonly SessionEvent[]
    const restoredFixed = await ctx.agents.create({
      sessionId: SessionId('command-fixed-restored'),
      seed: commandFixedSeed,
      agentOptions: {
        provider: 'ctapi', model: 'deepseek-v4-pro-vip', reasoningEffort: ReasoningEffortId('max'),
      },
    })
    restoredFixed.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'remain on the command-fixed automatic route' }],
      source: { kind: 'user' },
    }))
    await restoredFixed.agent.whenIdle()
    expect(calls).toBe(2)
    expect(adapter.requests[4]).toMatchObject({ model: 'deepseek-v4-flash-vip', reasoningEffort: 'high' })
    expect(ctx.sessionProjections.stateOf(restoredFixed.agent.session, 'jevRouterHistory'))
      .toMatchObject({ mode: 'fixed', commandFixed: true })
  })

  it('treats user cancellation as cancellation, then classifies the next turn independently', async () => {
    const started = Promise.withResolvers<AbortSignal>()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      calls++
      const signal = init?.signal as AbortSignal
      if (calls > 1) return new Response(JSON.stringify({ result: {
        provider: 'ctapi', model: 'deepseek-v4-flash-vip', reasoningEffort: 'high',
      } }), { status: 200 })
      started.resolve(signal)
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }))
    const ctx = await loadRouter()
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['ctapi'], adapter)
    await ctx.settings.update('jev-router', { enabled: true, switchContextLimitTokens: null, minHoldUserTurns: 0 })
    const agent = await ctx.agentLoop.create(SessionId('cancel'), { provider: 'ctapi', model: 'deepseek-v4-pro-vip' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'cancel this' }], source: { kind: 'user' } }))
    const signal = await started.promise
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(signal.aborted).toBe(true)
    expect(adapter.requests).toHaveLength(0)
    expect(ctx.sessionProjections.stateOf(agent.session, 'jevRouterHistory')?.latestDecision).toBeUndefined()

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'new turn' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(calls).toBe(2)
    expect(adapter.requests[0]?.model).toBe('deepseek-v4-flash-vip')
  })

  it('rejects a late classification when settings disable the plugin', async () => {
    const pending = Promise.withResolvers<Response>()
    const started = Promise.withResolvers<AbortSignal>()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      calls++
      const signal = init?.signal as AbortSignal
      started.resolve(signal)
      signal.addEventListener('abort', () => pending.reject(signal.reason), { once: true })
      return pending.promise
    }))
    const ctx = await loadRouter()
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['ctapi'], adapter)
    await ctx.settings.update('jev-router', {
      enabled: true, switchContextLimitTokens: null, minHoldUserTurns: 0, showDecision: true,
    })
    const agent = await ctx.agentLoop.create(SessionId('disable-in-flight'), {
      provider: 'ctapi', model: 'deepseek-v4-pro-vip',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'disable during classification' }], source: { kind: 'user' } }))
    const signal = await started.promise
    await ctx.settings.update('jev-router', { enabled: false })
    expect(signal.aborted).toBe(true)
    pending.resolve(new Response(JSON.stringify({ result: {
      provider: 'ctapi', model: 'deepseek-v4-flash-vip', reasoningEffort: 'high',
    } }), { status: 200 }))
    await agent.whenIdle()
    expect(adapter.requests[0]?.model).toBe('deepseek-v4-pro-vip')
    expect(ctx.sessionProjections.stateOf(agent.session, 'jevRouterHistory')?.latestDecision).toBeUndefined()

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'still disabled' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(calls).toBe(1)
    expect(adapter.requests[1]?.model).toBe('deepseek-v4-pro-vip')
  })

  it('uses an independent fallback signal after a total classification timeout', async () => {
    const started = Promise.withResolvers<AbortSignal>()
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const signal = init?.signal as AbortSignal
      started.resolve(signal)
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }))
    const ctx = await loadRouter()
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['ctapi'], adapter)
    await ctx.settings.update('jev-router', {
      enabled: true, switchContextLimitTokens: null, minHoldUserTurns: 0, jevTimeoutMs: 10, showDecision: true,
    })
    const agent = await ctx.agentLoop.create(SessionId('timeout'), { provider: 'ctapi', model: 'deepseek-v4-pro-vip' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'timeout this' }], source: { kind: 'user' } }))
    const signal = await started.promise
    await agent.whenIdle()
    expect(signal.aborted).toBe(true)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.model).toBe('deepseek-v4-pro-vip')
    expect(ctx.sessionProjections.stateOf(agent.session, 'jevRouterHistory')?.latestDecision)
      .toMatchObject({ reason: 'fallback', fallback: expect.stringContaining('timed out') })
  })

  it('applies the total timeout while credential resolution is still pending', async () => {
    const credential = Promise.withResolvers<{ value: string; source: string }>()
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', fetch)
    const ctx = await loadRouter({ resolveCredential: () => credential.promise })
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['ctapi'], adapter)
    await ctx.settings.update('jev-router', {
      enabled: true, switchContextLimitTokens: null, minHoldUserTurns: 0, jevTimeoutMs: 10, showDecision: true,
    })
    const agent = await ctx.agentLoop.create(SessionId('credential-timeout'), {
      provider: 'ctapi', model: 'deepseek-v4-pro-vip',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'credential stalls' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(fetch).not.toHaveBeenCalled()
    expect(adapter.requests[0]?.model).toBe('deepseek-v4-pro-vip')
    expect(ctx.sessionProjections.stateOf(agent.session, 'jevRouterHistory')?.latestDecision)
      .toMatchObject({ reason: 'fallback', fallback: expect.stringContaining('timed out') })
  })

  it('keeps the active first-turn route when it differs from the configured fallback', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', fetch)
    const ctx = await loadRouter({ resolveCredential: () => Promise.resolve(undefined) })
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['ctapi'], adapter)
    await ctx.settings.update('jev-router', {
      enabled: true,
      defaultModel: { provider: 'ctapi', model: 'deepseek-v4-flash-vip' },
      switchContextLimitTokens: null,
      minHoldUserTurns: 0,
      showDecision: true,
    })
    const agent = await ctx.agentLoop.create(SessionId('active-first-fallback'), {
      provider: 'ctapi', model: 'deepseek-v4-pro-vip', reasoningEffort: ReasoningEffortId('max'),
    })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'use my current route if classification is unavailable' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(fetch).not.toHaveBeenCalled()
    expect(adapter.requests[0]).toMatchObject({
      model: 'deepseek-v4-pro-vip', reasoningEffort: 'max',
    })
    expect(ctx.sessionProjections.stateOf(agent.session, 'jevRouterHistory')?.latestDecision)
      .toMatchObject({
        actual: { provider: 'ctapi', model: 'deepseek-v4-pro-vip' },
        reason: 'fallback',
        fallback: expect.stringContaining('not configured'),
      })
  })

  it('isolates concurrent session classification results and cancellation signals', async () => {
    const alphaStarted = Promise.withResolvers<AbortSignal>()
    const betaStarted = Promise.withResolvers<AbortSignal>()
    const betaResponse = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { state: { input: string } }
      const signal = init?.signal as AbortSignal
      if (body.state.input.includes('alpha')) {
        alphaStarted.resolve(signal)
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      betaStarted.resolve(signal)
      return betaResponse.promise
    }))
    const ctx = await loadRouter()
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['ctapi'], adapter)
    await ctx.settings.update('jev-router', {
      enabled: true, switchContextLimitTokens: null, minHoldUserTurns: 0, showDecision: true,
    })
    const alpha = await ctx.agentLoop.create(SessionId('concurrent-alpha'), {
      provider: 'ctapi', model: 'deepseek-v4-pro-vip',
    })
    const beta = await ctx.agentLoop.create(SessionId('concurrent-beta'), {
      provider: 'ctapi', model: 'deepseek-v4-pro-vip',
    })

    alpha.followup(createUserMessage({ content: [{ type: 'text', text: 'alpha task' }], source: { kind: 'user' } }))
    beta.followup(createUserMessage({ content: [{ type: 'text', text: 'beta task' }], source: { kind: 'user' } }))
    const [alphaSignal, betaSignal] = await Promise.all([alphaStarted.promise, betaStarted.promise])
    alpha.cancel({ kind: 'user' })
    betaResponse.resolve(new Response(JSON.stringify({ result: {
      provider: 'ctapi', model: 'deepseek-v4-flash-vip', reasoningEffort: 'high',
    } }), { status: 200 }))
    await Promise.all([alpha.whenIdle(), beta.whenIdle()])

    expect(alphaSignal.aborted).toBe(true)
    expect(betaSignal.aborted).toBe(false)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ model: 'deepseek-v4-flash-vip', reasoningEffort: 'high' })
    expect(ctx.sessionProjections.stateOf(alpha.session, 'jevRouterHistory')?.latestDecision).toBeUndefined()
    expect(ctx.sessionProjections.stateOf(beta.session, 'jevRouterHistory')?.latestDecision)
      .toMatchObject({ actual: { provider: 'ctapi', model: 'deepseek-v4-flash-vip' } })
  })

  it('restores durable Fixed mode without reinstalling an older automatic request route', async () => {
    let classifications = 0
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => {
      classifications++
      return new Response(JSON.stringify({ result: {
        provider: 'ctapi', model: 'deepseek-v4-flash-vip', reasoningEffort: 'high',
      } }), { status: 200 })
    }))
    const ctx = await loadRouter()
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['ctapi'], adapter)
    await ctx.settings.update('jev-router', {
      enabled: true, switchContextLimitTokens: null, minHoldUserTurns: 0,
    })
    const original = await ctx.agentLoop.create(SessionId('restore-source'), {
      provider: 'ctapi', model: 'deepseek-v4-pro-vip',
    })
    original.followup(createUserMessage({ content: [{ type: 'text', text: 'choose automatically' }], source: { kind: 'user' } }))
    await original.whenIdle()
    expect(adapter.requests.at(-1)?.model).toBe('deepseek-v4-flash-vip')
    const autoSeed = original.session.snapshotEvents() as readonly SessionEvent[]

    original.session.append('model/selection', {
      provider: 'ctapi', model: 'deepseek-v4-pro-vip', reasoningEffort: ReasoningEffortId('max'),
    })
    await new Promise<void>(resolve => queueMicrotask(() => resolve()))
    const seed = original.session.snapshotEvents() as readonly SessionEvent[]
    expect(ctx.sessionProjections.stateOf(original.session, 'jevRouterHistory')?.mode).toBe('fixed')

    const restoredAuto = await ctx.agents.create({
      sessionId: SessionId('restore-auto'),
      seed: autoSeed,
      agentOptions: { provider: 'ctapi', model: 'deepseek-v4-pro-vip' },
    })
    restoredAuto.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue in Auto' }], source: { kind: 'user' } }))
    await restoredAuto.agent.whenIdle()
    expect(classifications).toBe(2)
    expect(adapter.requests.at(-1)?.model).toBe('deepseek-v4-flash-vip')
    expect(ctx.sessionProjections.stateOf(restoredAuto.agent.session, 'jevRouterHistory')?.mode).toBe('auto')

    const restored = await ctx.agents.create({
      sessionId: SessionId('restore-target'),
      seed,
      agentOptions: {
        provider: 'ctapi', model: 'deepseek-v4-pro-vip', reasoningEffort: ReasoningEffortId('max'),
      },
    })
    restored.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'stay fixed after recovery' }], source: { kind: 'user' } }))
    await restored.agent.whenIdle()
    expect(classifications).toBe(2)
    expect(adapter.requests.at(-1)).toMatchObject({
      model: 'deepseek-v4-pro-vip', reasoningEffort: 'max',
    })
    expect(ctx.sessionProjections.stateOf(restored.agent.session, 'jevRouterHistory')?.mode).toBe('fixed')
  })

  it('replays an Auto session without a credential and falls back to its recorded route', async () => {
    let credentialAvailable = true
    let classifications = 0
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => {
      classifications++
      return new Response(JSON.stringify({ result: {
        provider: 'ctapi', model: 'deepseek-v4-flash-vip', reasoningEffort: 'high',
      } }), { status: 200 })
    }))
    const ctx = await loadRouter({
      resolveCredential: () => Promise.resolve(credentialAvailable
        ? { value: 'secret', source: 'test' }
        : undefined),
    })
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['ctapi'], adapter)
    await ctx.settings.update('jev-router', {
      enabled: true, switchContextLimitTokens: null, minHoldUserTurns: 0, showDecision: true,
    })
    const source = await ctx.agentLoop.create(SessionId('missing-key-source'), {
      provider: 'ctapi', model: 'deepseek-v4-pro-vip',
    })
    source.followup(createUserMessage({ content: [{ type: 'text', text: 'establish route' }], source: { kind: 'user' } }))
    await source.whenIdle()
    const seed = source.session.snapshotEvents() as readonly SessionEvent[]
    credentialAvailable = false

    const restored = await ctx.agents.create({
      sessionId: SessionId('missing-key-restored'),
      seed,
      agentOptions: { provider: 'ctapi', model: 'deepseek-v4-pro-vip' },
    })
    restored.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue without key' }], source: { kind: 'user' } }))
    await restored.agent.whenIdle()
    expect(classifications).toBe(1)
    expect(adapter.requests.at(-1)?.model).toBe('deepseek-v4-flash-vip')
    expect(ctx.sessionProjections.stateOf(restored.agent.session, 'jevRouterHistory')?.latestDecision)
      .toMatchObject({ reason: 'fallback', fallback: expect.stringContaining('not configured') })
  })

  it('aborts fallback model resolution and reaches quiescence on hot unload', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const signal = init?.signal as AbortSignal
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }))
    const fallbackStarted = Promise.withResolvers<AbortSignal>()
    const ctx = await loadRouter()
    const adapter = new BlockingFallbackAdapter(
      'deepseek-fallback',
      signal => fallbackStarted.resolve(signal),
      1,
    )
    ctx.llm.registerAdapter(['ctapi'], adapter)
    await ctx.settings.update('jev-router', {
      enabled: true,
      defaultModel: { provider: 'ctapi', model: 'deepseek-fallback' },
      switchContextLimitTokens: null,
      minHoldUserTurns: 0,
      jevTimeoutMs: 10,
    })
    const agent = await ctx.agentLoop.create(SessionId('fallback-unload'), {
      provider: 'ctapi', model: 'deepseek-fallback',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'enter fallback' }], source: { kind: 'user' } }))
    const fallbackSignal = await fallbackStarted.promise
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@zong/dsh-jev-router')
    expect(entry).toBeDefined()

    await entry?._dispose()
    expect(fallbackSignal.aborted).toBe(true)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.model).toBe('deepseek-fallback')
  })

  it('aborts pending work on hot unload and reloads without duplicate classification', async () => {
    const started = Promise.withResolvers<AbortSignal>()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      calls++
      const signal = init?.signal as AbortSignal
      if (calls > 1) return new Response(JSON.stringify({ result: {
        provider: 'ctapi', model: 'deepseek-v4-flash-vip', reasoningEffort: 'high',
      } }), { status: 200 })
      started.resolve(signal)
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }))
    const ctx = await loadRouter()
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['ctapi'], adapter)
    await ctx.settings.update('jev-router', { enabled: true, switchContextLimitTokens: null, minHoldUserTurns: 0 })
    const agent = await ctx.agentLoop.create(SessionId('hmr'), { provider: 'ctapi', model: 'deepseek-v4-pro-vip' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'pending' }], source: { kind: 'user' } }))
    const signal = await started.promise
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@zong/dsh-jev-router')
    expect(entry).toBeDefined()
    await entry?._dispose()
    expect(signal.aborted).toBe(true)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.model).toBe('deepseek-v4-pro-vip')

    await entry?.update(entry.options, true, true)
    await ctx.loader.await()
    await ctx.settings.update('jev-router', { enabled: true, switchContextLimitTokens: null, minHoldUserTurns: 0 })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'after reload' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(calls).toBe(2)
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]?.model).toBe('deepseek-v4-flash-vip')
  })

  it('rebuilds a completed decision from the standard session log after Host reload', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ result: {
      provider: 'ctapi', model: 'deepseek-v4-flash-vip', reasoningEffort: 'high', jevVersion: 'jev-replay',
    } }), { status: 200 })))
    const ctx = await loadRouter()
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['ctapi'], adapter)
    await ctx.settings.update('jev-router', {
      enabled: true, switchContextLimitTokens: null, minHoldUserTurns: 0, showDecision: true,
    })
    const agent = await ctx.agentLoop.create(SessionId('decision-replay'), {
      provider: 'ctapi', model: 'deepseek-v4-pro-vip',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'persist this decision' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(ctx.sessionProjections.stateOf(agent.session, 'jevRouterHistory')?.latestDecision)
      .toMatchObject({ jevVersion: 'jev-replay', actual: { model: 'deepseek-v4-flash-vip' } })

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@zong/dsh-jev-router')
    expect(entry).toBeDefined()
    await entry?._dispose()
    expect(ctx.sessionProjections.stateOf(agent.session, 'jevRouterHistory')).toBeUndefined()
    await entry?.update(entry.options, true, true)
    await ctx.loader.await()
    expect(ctx.sessionProjections.stateOf(agent.session, 'jevRouterHistory')?.latestDecision)
      .toMatchObject({ jevVersion: 'jev-replay', actual: { model: 'deepseek-v4-flash-vip' } })
  })
})
