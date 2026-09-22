import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_API_KEY_ENV, DEFAULT_CANDIDATES, defaultSettings, JevRouterSettingsSchema, validateSettings,
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
export const inject = ['agentDefaultModel', 'agents', 'credentials', 'llm', 'settings']

/** Optional deployment override for the TypeSafe endpoint, useful for a gateway or test server. */
/** Configuration accepted by the Host entry. */
export interface Config extends Partial<JevRouterSettings> {
  endpoint?: string
}

export const Config: z<Config> = z.object({
  endpoint: z.string().min(1).default('https://api.typesafe.ai/v1/system-one'),
  enabled: z.boolean().default(false),
  candidateModels: z.array(z.object({
    provider: z.string().min(1), model: z.string().min(1), description: z.string().min(1),
    tier: z.union([z.const('economy'), z.const('capability')]),
  })).default(DEFAULT_CANDIDATES.map(candidate => ({ ...candidate }))),
  defaultModel: z.object({ provider: z.string().min(1), model: z.string().min(1) }).default({ provider: 'ctapi', model: 'deepseek-v4-pro-vip' }),
  routeReasoning: z.boolean().default(true),
  switchContextLimitTokens: z.union([z.number().step(1).min(1), z.const(null)]).default(32_768),
  overLimitPolicy: z.union([z.const('keep'), z.const('upgrade_only')]).default('upgrade_only'),
  minHoldUserTurns: z.number().step(1).min(0).default(2),
  cacheAware: z.boolean().default(true), jevTimeoutMs: z.number().step(1).min(1).default(2_000),
  jevMaxStateChars: z.number().step(1).min(1).default(6_000), showDecision: z.boolean().default(true),
  recordMetrics: z.boolean().default(true), apiKeyEnv: z.string().min(1).default(DEFAULT_API_KEY_ENV),
})

interface RouteState {
  route?: ModelSelection | undefined
  classifiedTurn?: number | undefined
  claimed: UserMessage[]
  decision?: JevDecision | undefined
  abort?: AbortController | undefined
  fixed: boolean
  disposed: boolean
  generation: number
  currentTurn?: number
  selection?: { current: ModelSelection | undefined; assembled: ModelSelection | undefined }
}

function isRootAgent(agent: Agent): boolean {
  return agent.session.header.origin !== 'subagent'
}

function textOf(message: UserMessage): string {
  return message.content.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text).join('\n')
}

function routeAllowed(candidate: CandidateModel, decision: JevDecision): boolean {
  return candidate.provider === decision.provider && candidate.model === decision.model
}

function choiceFromDecision(decision: JevDecision, candidates: readonly CandidateModel[], info: LlmResolvedModelInfo): ModelSelection | undefined {
  if (!candidates.some(candidate => routeAllowed(candidate, decision))) return undefined
  if (decision.reasoningEffort === undefined) return { provider: decision.provider, model: decision.model }
  if (info.reasoning?.efforts.some(effort => effort.id === decision.reasoningEffort) !== true) return { provider: decision.provider, model: decision.model }
  return { provider: decision.provider, model: decision.model, reasoningEffort: ReasoningEffortId(decision.reasoningEffort) }
}

/** Install one per-agent route controller on a live main Agent. */
function installAgent(ctx: Context, agent: Agent, endpoint: string, scope: { get(): JevRouterSettings }, registry?: Set<RouteState>): () => void {
  if (!isRootAgent(agent)) return () => {}
  const state: RouteState = { claimed: [], fixed: agent.session.requestHeader() !== undefined, disposed: false, generation: 0 }
  registry?.add(state)
  const selection = { current: undefined as ModelSelection | undefined, assembled: undefined as ModelSelection | undefined }
  state.selection = selection
  const disposeSelection = installModelSelection(agent.ctx, selection)
  const disposeClaimed = agent.ctx.on('agent/inbox/claimed', ({ message, turn }) => {
    state.currentTurn = turn
    if (state.classifiedTurn !== turn) state.claimed.push(message)
  })
  const disposeSession = ctx.on('session/event', (session, event) => {
    if (session !== agent.session || String(event.type) !== 'model/selection') return
    state.fixed = true
    state.generation++
    state.abort?.abort(new Error('manual model selection'))
    selection.current = undefined
    state.route = undefined
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
    const turnNumber = state.currentTurn
    if (turnNumber === undefined || state.classifiedTurn === turnNumber || state.claimed.length === 0) return next()
    state.classifiedTurn = turnNumber
    const generation = ++state.generation
    const controller = new AbortController()
    state.abort = controller
    const linkedAbort = (): void => controller.abort()
    _context.signal?.addEventListener('abort', linkedAbort, { once: true })
    try {
      const apiKey = await ctx.credentials.resolve(credentialRef(settings.apiKeyEnv))
      if (apiKey === undefined) throw new Error(`credential ${settings.apiKeyEnv} is not configured`)
      const candidates: CandidateModel[] = []
      const hasNonTextInput = state.claimed.some(message => message.content.some(block => block.type !== 'text'))
      for (const candidate of settings.candidateModels) {
        try {
          const info = await ctx.llm.resolveModelInfo(candidate.provider, candidate.model, controller.signal)
          if (hasNonTextInput && info.inputModalities?.includes('image') !== true) continue
          candidates.push(candidate)
        } catch (error: unknown) {
          void error
          // Unavailable candidates are omitted from the Jev choice.
        }
      }
      if (candidates.length === 0) throw new Error('none of the configured candidate models is available')
      const stateInput = {
        input: state.claimed.map(textOf).join('\n'),
        ...(state.claimed.length > 1 ? { context: [textOf(state.claimed.at(-2)!) ] } : {}),
        candidates,
      }
      const decision = await classifyWithJev(boundJevState(stateInput, settings.jevMaxStateChars), settings, apiKey.value, controller.signal, { endpoint })
      const info = await ctx.llm.resolveModelInfo(decision.provider, decision.model, controller.signal)
      const route = choiceFromDecision(decision, candidates, info)
      if (route === undefined) throw new Error('Jev selected a route outside the configured candidate allow-list')
      if (state.disposed || controller.signal.aborted || generation !== state.generation || !scope.get().enabled) return next()
      selection.current = route
      state.route = route
      state.decision = decision
    } catch (error) {
      if (!controller.signal.aborted) {
        const fallback = agent.session.requestHeader()?.config ?? settings.defaultModel
        try {
          await ctx.llm.resolveModelInfo(fallback.provider, fallback.model, controller.signal)
        } catch (fallbackError: unknown) {
          throw new Error(`no usable fallback model (${fallback.provider}/${fallback.model}): ${String(fallbackError)}`, { cause: fallbackError })
        }
        selection.current = { provider: fallback.provider, model: fallback.model }
        state.route = selection.current
        state.decision = { provider: fallback.provider, model: fallback.model, reason: `fallback: ${String(error)}` }
      }
    } finally {
      _context.signal?.removeEventListener('abort', linkedAbort)
      state.abort = undefined
      state.claimed = []
    }
    return next()
  }, { prepend: true })
  return () => {
    state.disposed = true
    state.abort?.abort(new Error('jev-router unloaded'))
    registry?.delete(state)
    disposeClaimed(); disposeSession(); disposeAssembly(); disposeSelection()
  }
}

/**
 * Host plugin entry.
 * @param ctx - host Cordis context with Agent, model, credentials, and settings services.
 * @param config - deployment endpoint and optional composition defaults.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const initial = defaultSettings(config.defaultModel ?? ctx.agentDefaultModel.currentSelection())
  const base = { ...initial, ...config, candidateModels: config.candidateModels ?? initial.candidateModels, defaultModel: config.defaultModel ?? initial.defaultModel }
  validateSettings(base)
  const settings = ctx.settings.register('jev-router', JevRouterSettingsSchema, { base, validate: validateSettings })
  const installed = new Map<Agent, () => void>()
  const states = new Set<RouteState>()
  const install = (agent: Agent): void => {
    if (installed.has(agent)) return
    const dispose = installAgent(ctx, agent, config.endpoint ?? 'https://api.typesafe.ai/v1/system-one', settings, states)
    installed.set(agent, dispose)
  }
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => { installed.get(agent)?.(); installed.delete(agent) })
  const disposeSettings = settings.watch((next, previous) => {
    if (previous.enabled && !next.enabled) {
      for (const state of states) {
        state.generation++
        state.abort?.abort(new Error('jev-router disabled'))
        state.route = undefined
        if (state.selection !== undefined) state.selection.current = undefined
      }
    }
  })
  ctx.effect(() => () => {
    disposeSettings()
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'jev-router: agent routes')
}
