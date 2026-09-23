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
import { createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
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

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: 200_000 },
      defaultMaxTokens: 1,
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

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadRouter(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-jev-router-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
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
    resolve: () => Promise.resolve({ value: 'secret', source: 'test' }),
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
    expect(adapter.requests[0]?.model).toBe('deepseek-v4-pro-vip')
    expect(states[0]?.cache).toMatchObject({ evidence: { status: 'unknown' } })

    await ctx.settings.update('jev-router', { switchContextLimitTokens: null })
    first.followup(createUserMessage({ content: [{ type: 'text', text: 'second request' }], source: { kind: 'user' } }))
    await first.whenIdle()
    expect(adapter.requests[1]?.model).toBe('deepseek-v4-flash-vip')
    expect(states[1]?.cache).toMatchObject({
      route: { provider: 'ctapi', model: 'deepseek-v4-pro-vip' },
      evidence: { status: 'known', cacheReadTokens: 7, uncachedInputTokens: 11 },
    })

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
})
