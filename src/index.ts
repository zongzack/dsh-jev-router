import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { ModelSelection as DurableModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import {
  DEFAULT_API_KEY_ENV, DEFAULT_CANDIDATES, defaultSettings, JevRouterSettingsSchema, validateSettings,
  type CandidateModel, type JevRouterSettings,
} from './config.ts'
import { boundJevState, classifyWithJev, type JevDecision } from './jev.ts'
import { measureCompleteInput } from './input-measurement.ts'
import { resolveGuardedRoute, type InputMeasurement, type RouteGuardReason } from './route-guards.ts'
import {
  cacheEvidenceFor, routerHistoryProjectionDefinition,
  routeKey,
} from './router-history.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'model/selection': DurableModelSelection
  }
}

export type { CandidateModel, JevRouterSettings } from './config.ts'
export {
  DEFAULT_API_KEY_ENV, DEFAULT_CANDIDATES, DEFAULT_MIN_HOLD_USER_TURNS,
  DEFAULT_SWITCH_CONTEXT_LIMIT_TOKENS, JevRouterSettingsSchema, defaultSettings, validateSettings,
} from './config.ts'
export { boundJevState, classifyWithJev } from './jev.ts'
export type { JevClientOptions, JevDecision, JevState } from './jev.ts'
export { measureCompleteInput } from './input-measurement.ts'
export type { GuardedRoute, InputMeasurement, RouteGuardInput, RouteGuardReason } from './route-guards.ts'
export { resolveGuardedRoute } from './route-guards.ts'
export {
  cacheEvidenceFor, routeKey, routerHistoryProjectionDefinition,
} from './router-history.ts'
export type { ActiveCacheEvidence, CacheEvidence, RouterHistoryState } from './router-history.ts'

/** Cordis package name shared by Host and Client faces. */
export const name = 'jev-router'
/** Host services required by the router. */
export const inject = [
  'agentDefaultModel', 'agents', 'credentials', 'llm', 'sessionProjections', 'settings', 'tokenMeter',
]

/** Optional deployment override for the TypeSafe endpoint, useful for a gateway or test server. */
/** Configuration accepted by the Host entry. */
export interface Config extends Partial<JevRouterSettings> {
  endpoint?: string
}

/** Schemastery schema used by the Cordis loader for optional deployment overrides. */
export const Config: z<Config> = z.object({
  endpoint: z.string().min(1).default('https://api.typesafe.ai/v1/system-one'),
  enabled: z.boolean(),
  candidateModels: z.array(z.object({
    provider: z.string().min(1), model: z.string().min(1), description: z.string().min(1),
    tier: z.union([z.const('economy'), z.const('capability')]),
  })).min(1),
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
  generation: number
  currentTurn?: number
  selection?: { current: ModelSelection | undefined; assembled: ModelSelection | undefined }
  input?: InputMeasurement
  guardReason?: RouteGuardReason | 'fallback'
  reportedTurn?: number | undefined
  showDecision?: boolean
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

function sameRoute(
  left: Pick<ModelSelection, 'provider' | 'model'>,
  right: Pick<ModelSelection, 'provider' | 'model'>,
): boolean {
  return left.provider === right.provider && left.model === right.model
}

function currentRoute(agent: Agent, state: RouteState, settings: JevRouterSettings): ModelSelection {
  const persisted = agent.session.requestHeader()?.config
  if (persisted !== undefined) return persisted
  if (state.route !== undefined) return state.route
  if (agent.options.provider && agent.options.model) {
    return {
      provider: agent.options.provider,
      model: agent.options.model,
      ...agent.options.reasoningEffort === undefined ? {} : { reasoningEffort: agent.options.reasoningEffort },
    }
  }
  return settings.defaultModel
}

function targetHasCapacity(info: LlmResolvedModelInfo, input: InputMeasurement): boolean {
  if (info.context === undefined || input.tokens === undefined) return false
  return input.tokens + (info.defaultMaxTokens ?? 1) <= info.context.contextWindow
}

function completeInputRequiresImage(agent: Agent, claimed: readonly UserMessage[]): boolean {
  const messages = [...agent.session.deriveMessages(), ...claimed]
  return messages.some(message => message.content.some(block => {
    if (block.type === 'image') return true
    if (block.type !== 'tool-result') return false
    return block.content.some(result => result.type === 'image')
  }))
}

function reportDecision(ctx: Context, agent: Agent, state: RouteState): void {
  if (state.showDecision !== true || state.decision === undefined || state.route === undefined || state.currentTurn === undefined) return
  if (state.reportedTurn === state.currentTurn) return
  state.reportedTurn = state.currentTurn
  ctx.logger.info(JSON.stringify({
    event: 'jev-router/decision',
    sessionId: String(agent.session.id),
    turn: state.currentTurn,
    suggested: { provider: state.decision.provider, model: state.decision.model },
    actual: { provider: state.route.provider, model: state.route.model },
    inputTokens: state.input?.tokens ?? null,
    inputTokensEstimated: state.input?.estimated ?? true,
    reason: state.guardReason ?? 'suggestion_applied',
  }))
  agent.session.append('jev-router/decision', {
    turn: state.currentTurn,
    suggested: { provider: state.decision.provider, model: state.decision.model },
    actual: { provider: state.route.provider, model: state.route.model },
    inputTokens: state.input?.tokens ?? null,
    estimated: state.input?.estimated ?? true,
    reason: state.guardReason ?? 'suggestion_applied',
  })
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
    if (session !== agent.session) return
    if (event.type === 'request/header'
      && state.decision !== undefined
      && state.route !== undefined
      && state.currentTurn !== undefined
      && state.reportedTurn !== state.currentTurn
      && sameRoute(event.data.header.config, state.route)) {
      reportDecision(ctx, agent, state)
      return
    }
    if (event.type === 'assistant/message'
      && state.decision !== undefined
      && sameRoute(event.data.message.source, state.route ?? event.data.message.source)) {
      reportDecision(ctx, agent, state)
      return
    }
    if (event.type !== 'model/selection') return
    state.fixed = true
    state.generation++
    state.abort?.abort(new Error('manual model selection'))
    selection.current = undefined
    state.route = undefined
  })
  const disposeAssembly = agent.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const settings = structuredClone(scope.get())
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
    state.reportedTurn = undefined
    state.showDecision = settings.showDecision
    const generation = ++state.generation
    const controller = new AbortController()
    state.abort = controller
    const linkedAbort = (): void => controller.abort()
    _context.signal?.addEventListener('abort', linkedAbort, { once: true })
    try {
      const apiKey = await ctx.credentials.resolve(credentialRef(settings.apiKeyEnv))
      if (apiKey === undefined) throw new Error(`credential ${settings.apiKeyEnv} is not configured`)
      const history = ctx.sessionProjections.stateOf(agent.session, 'jevRouterHistory')
      const activeRoute = currentRoute(agent, state, settings)
      const input = measureCompleteInput(ctx.tokenMeter, agent.session, assembly, state.claimed, activeRoute)
      state.input = input
      const candidates: CandidateModel[] = []
      const candidateInfo = new Map<string, LlmResolvedModelInfo>()
      const requiresImage = completeInputRequiresImage(agent, state.claimed)
      for (const candidate of settings.candidateModels) {
        try {
          const info = await ctx.llm.resolveModelInfo(candidate.provider, candidate.model, controller.signal)
          if (requiresImage && info.inputModalities?.includes('image') !== true) continue
          if (!targetHasCapacity(info, input)) continue
          candidates.push(candidate)
          candidateInfo.set(routeKey(candidate.provider, candidate.model), info)
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
        ...(settings.cacheAware
          ? { cache: {
              route: { provider: activeRoute.provider, model: activeRoute.model },
              evidence: history === undefined
                ? { status: 'unknown' as const }
                : cacheEvidenceFor(history, activeRoute),
            } }
          : {}),
      }
      const decision = await classifyWithJev(boundJevState(stateInput, settings.jevMaxStateChars), settings, apiKey.value, controller.signal, { endpoint })
      const info = candidateInfo.get(routeKey(decision.provider, decision.model))
      if (info === undefined) throw new Error('Jev selected a route outside the compatible candidate set')
      const route = choiceFromDecision(decision, candidates, info)
      if (route === undefined) throw new Error('Jev selected a route outside the configured candidate allow-list')
      if (state.disposed || controller.signal.aborted || generation !== state.generation || !scope.get().enabled) return next()
      const guarded = resolveGuardedRoute({
        current: activeRoute,
        suggested: route,
        candidates: settings.candidateModels,
        input,
        completedUserTurnsSinceSwitch: history?.completedUserTurnsSinceSwitch,
        settings,
      })
      selection.current = guarded.actual
      state.route = guarded.actual
      state.decision = decision
      state.guardReason = guarded.reason
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
        state.guardReason = 'fallback'
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
  const configuredDefault = config.defaultModel?.provider && config.defaultModel.model
    ? config.defaultModel
    : undefined
  const initial = defaultSettings(configuredDefault ?? ctx.agentDefaultModel.currentSelection())
  const definedOverrides = Object.fromEntries(
    Object.entries(config).filter(([key, value]) => key !== 'endpoint' && value !== undefined),
  ) as Partial<JevRouterSettings>
  const base: JevRouterSettings = {
    ...initial,
    ...definedOverrides,
    candidateModels: config.candidateModels?.length ? config.candidateModels : initial.candidateModels,
    defaultModel: configuredDefault ?? initial.defaultModel,
  }
  validateSettings(base)
  const disposeHistory = ctx.sessionProjections.register(routerHistoryProjectionDefinition)
  const settings = ctx.settings.register('jev-router', JevRouterSettingsSchema, { base, validate: validateSettings })
  const installed = new Map<Agent, () => void>()
  const states = new Set<RouteState>()
  const install = (agent: Agent): void => {
    if (installed.has(agent)) return
    const dispose = installAgent(ctx, agent, config.endpoint ?? 'https://api.typesafe.ai/v1/system-one', settings, states)
    installed.set(agent, dispose)
  }
  for (const agent of ctx.agents.list()) install(agent)
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
    disposeHistory()
    disposeSettings()
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'jev-router: agent routes')
}
