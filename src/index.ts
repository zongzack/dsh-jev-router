import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-settings'
import {
  defaultSettings, JevRouterSettingsSchema, validateSettings,
  type CandidateModel, type JevRouterSettings,
} from './config.ts'
import { boundJevState, classifyWithJev, type JevDecision } from './jev.ts'

export type { CandidateModel, JevRouterSettings } from './config.ts'
export { DEFAULT_CANDIDATES, DEFAULT_API_KEY_ENV, JevRouterSettingsSchema, defaultSettings, validateSettings } from './config.ts'
export { boundJevState, classifyWithJev } from './jev.ts'
export type { JevClientOptions, JevDecision, JevState } from './jev.ts'

/** Cordis package name shared by Host and Client faces. */
export const name = 'jev-router'
/** Host services required by the router. */
export const inject = ['agents', 'credentials', 'llm', 'settings']

/** Optional deployment override for the TypeSafe endpoint, useful for a gateway or test server. */
export interface Config extends Partial<JevRouterSettings> {
  endpoint?: string
}

export const Config: z<Config> = z.object({
  endpoint: z.string().min(1).default('https://api.typesafe.ai/v1/system-one'),
  enabled: z.boolean(),
  candidateModels: z.array(z.object({
    provider: z.string().min(1), model: z.string().min(1), description: z.string().min(1),
    tier: z.union([z.const('economy'), z.const('capability')]),
  })),
  defaultModel: z.object({ provider: z.string().min(1), model: z.string().min(1) }),
  routeReasoning: z.boolean(),
  switchContextLimitTokens: z.union([z.number().step(1).min(1), z.const(null)]),
  overLimitPolicy: z.union([z.const('keep'), z.const('upgrade_only')]),
  minHoldUserTurns: z.number().step(1).min(0),
  cacheAware: z.boolean(), jevTimeoutMs: z.number().step(1).min(1),
  jevMaxStateChars: z.number().step(1).min(1), showDecision: z.boolean(),
  recordMetrics: z.boolean(), apiKeyEnv: z.string().min(1),
})

interface RouteState {
  route?: ModelSelection | undefined
  classifiedTurn?: number | undefined
  claimed: UserMessage[]
  decision?: JevDecision | undefined
  abort?: AbortController | undefined
  fixed: boolean
  disposed: boolean
}

function isRootAgent(agent: Agent): boolean {
  return agent.session.header.origin !== 'subagent'
}

function textOf(message: UserMessage): string {
  return message.content.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text).join('\n')
}

function lastUserText(agent: Agent): string {
  const event = agent.session.snapshotEvents().findLast(candidate => candidate.type === 'user/message')
  return event?.type === 'user/message' ? textOf(event.data) : ''
}

function hasNewerManualSelection(agent: Agent, afterSeq: number): boolean {
  return agent.session.snapshotEvents().some(event => {
    const candidate = event as unknown as { type: string; seq: number }
    return candidate.type === 'model/selection' && candidate.seq > afterSeq
  })
}

function latestRequestHeaderSeq(agent: Agent): number {
  let latest = -1
  for (const event of agent.session.snapshotEvents()) {
    const candidate = event as unknown as { type: string; seq: number }
    if (candidate.type === 'request/header') latest = candidate.seq
  }
  return latest
}

function routeAllowed(candidate: CandidateModel, decision: JevDecision): boolean {
  return candidate.provider === decision.provider && candidate.model === decision.model
}

function choiceFromDecision(decision: JevDecision, candidates: readonly CandidateModel[], info: LlmResolvedModelInfo): ModelSelection | undefined {
  if (!candidates.some(candidate => routeAllowed(candidate, decision))) return undefined
  if (decision.reasoningEffort === undefined) return { provider: decision.provider, model: decision.model }
  if (info.reasoning?.efforts.some(effort => effort.id === decision.reasoningEffort) !== true) return { provider: decision.provider, model: decision.model }
  return { provider: decision.provider, model: decision.model, reasoningEffort: decision.reasoningEffort as never }
}

/** Install one per-agent route controller on a live main Agent. */
function installAgent(ctx: Context, agent: Agent, endpoint: string, scope: { get(): JevRouterSettings }): () => void {
  if (!isRootAgent(agent)) return () => {}
  const state: RouteState = { claimed: [], fixed: false, disposed: false }
  const selection = { current: undefined as ModelSelection | undefined, assembled: undefined as ModelSelection | undefined }
  const disposeSelection = installModelSelection(agent.ctx, selection)
  const disposeClaimed = agent.ctx.on('agent/inbox/claimed', ({ message, turn }) => {
    if (state.classifiedTurn !== turn) state.claimed.push(message)
  })
  const disposeAssembly = agent.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const settings = scope.get()
    if (!settings.enabled) {
      selection.current = undefined
      state.route = undefined
      state.classifiedTurn = undefined
      state.claimed = []
      return next()
    }
    if (state.disposed || state.fixed) return next()
    const turn = agent.session.snapshotEvents().findLast(event => event.type === 'turn/start')
    const turnNumber = turn?.type === 'turn/start' ? turn.data.turn : undefined
    if (turnNumber === undefined || state.classifiedTurn === turnNumber || state.claimed.length === 0) return next()
    state.classifiedTurn = turnNumber
    const requestHeaderSeq = latestRequestHeaderSeq(agent)
    if (hasNewerManualSelection(agent, requestHeaderSeq)) {
      state.fixed = true
      selection.current = undefined
      state.route = undefined
      state.claimed = []
      return next()
    }
    const controller = new AbortController()
    state.abort = controller
    const linkedAbort = (): void => controller.abort()
    _context.signal?.addEventListener('abort', linkedAbort, { once: true })
    try {
      const apiKey = await ctx.credentials.resolve(credentialRef(settings.apiKeyEnv))
      if (apiKey === undefined) throw new Error(`credential ${settings.apiKeyEnv} is not configured`)
      const candidates = settings.candidateModels
      const stateInput = {
        input: state.claimed.map(textOf).join('\n'),
        ...(lastUserText(agent) ? { context: [lastUserText(agent)] } : {}),
        candidates,
      }
      const decision = await classifyWithJev(boundJevState(stateInput, settings.jevMaxStateChars), settings, apiKey.value, controller.signal, { endpoint })
      const info = await ctx.llm.resolveModelInfo(decision.provider, decision.model, controller.signal)
      const route = choiceFromDecision(decision, candidates, info)
      if (route === undefined) throw new Error('Jev selected a route outside the configured candidate allow-list')
      if (hasNewerManualSelection(agent, requestHeaderSeq)) {
        state.fixed = true
        selection.current = undefined
        state.route = undefined
        return next()
      }
      selection.current = route
      state.route = route
      state.decision = decision
    } catch (error) {
      if (!controller.signal.aborted) {
        const fallback = agent.session.requestHeader()?.config ?? settings.defaultModel
        selection.current = { provider: fallback.provider, model: fallback.model }
        state.route = selection.current
        state.decision = { provider: fallback.provider, model: fallback.model, reason: `fallback: ${String(error)}` }
      }
    } finally {
      _context.signal?.removeEventListener('abort', linkedAbort)
      state.abort = undefined
      state.claimed = []
    }
    const transformed = await next()
    if (state.route === undefined) return transformed
    return { ...transformed, variables: { ...transformed.variables, provider: state.route.provider, model: state.route.model } }
  }, { prepend: true })
  const disposeRequest = agent.ctx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    if (!scope.get().enabled || !state.route || state.fixed) return resolved
    const { reasoningEffort: _ignored, ...withoutEffort } = resolved
    return {
      ...withoutEffort,
      provider: state.route.provider,
      model: state.route.model,
      ...(state.route.reasoningEffort === undefined ? {} : { reasoningEffort: state.route.reasoningEffort }),
    }
  })
  const disposeNotice = agent.ctx.on('agent/pre-step', async ({ agent: current }, next) => {
    const decision = await next()
    const route = state.route
    const previous = current.session.requestHeader()?.config
    if (!route || !previous || (route.provider === previous.provider && route.model === previous.model) || decision.kind === 'reject') return decision
    return { ...decision, messages: decision.messages }
  }, { prepend: true })
  return () => {
    state.disposed = true
    state.abort?.abort(new Error('jev-router unloaded'))
    disposeClaimed(); disposeAssembly(); disposeRequest(); disposeNotice(); disposeSelection()
  }
}

/** Host plugin entry. */
export function apply(ctx: Context, config: Config = {}): void {
  const initial = defaultSettings(config.defaultModel ?? ctx.agentDefaultModel.currentSelection())
  const base = { ...initial, ...config, candidateModels: config.candidateModels ?? initial.candidateModels, defaultModel: config.defaultModel ?? initial.defaultModel }
  validateSettings(base)
  const settings = ctx.settings.register('jev-router', JevRouterSettingsSchema, { base, validate: validateSettings })
  const installed = new Map<Agent, () => void>()
  const install = (agent: Agent): void => {
    if (installed.has(agent)) return
    installed.set(agent, installAgent(ctx, agent, config.endpoint ?? 'https://api.typesafe.ai/v1/system-one', settings))
  }
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => { installed.get(agent)?.(); installed.delete(agent) })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'jev-router: agent routes')
}
