import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type ContentBlock, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { ModelSelection as DurableModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type {} from '@deepseek-ai/dsh-commands'
import {
  DEFAULT_API_KEY, DEFAULT_CANDIDATES, defaultSettings, JevRouterSettingsSchema, validateSettings,
  type CandidateModel, type JevRouterSettings,
} from './config.ts'
import { boundJevState, classifyWithJev, DEFAULT_JEV_ENDPOINT, type JevDecision } from './jev.ts'
import { measureCompleteInput } from './input-measurement.ts'
import { resolveGuardedRoute, type InputMeasurement, type RouteGuardReason } from './route-guards.ts'
import {
  cacheEvidenceFor, decodeDecisionCommandArgs, encodeDecisionCommandArgs, JEV_DECISION_COMMAND,
  routerHistoryProjectionDefinition, routeKey, type RouterHistoryState,
} from './router-history.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'model/selection': DurableModelSelection
  }
}

export type { CandidateModel, JevRouterSettings } from './config.ts'
export {
  DEFAULT_API_KEY, DEFAULT_CANDIDATES, DEFAULT_MIN_HOLD_USER_TURNS,
  DEFAULT_SWITCH_CONTEXT_LIMIT_TOKENS, JevRouterSettingsSchema, defaultSettings, validateSettings,
} from './config.ts'
export { boundJevState, classifyWithJev, DEFAULT_JEV_ENDPOINT } from './jev.ts'
export type { JevClientOptions, JevDecision, JevState, JevUsage } from './jev.ts'
export { measureCompleteInput } from './input-measurement.ts'
export type { GuardedRoute, InputMeasurement, RouteGuardInput, RouteGuardReason } from './route-guards.ts'
export { resolveGuardedRoute } from './route-guards.ts'
export {
  cacheEvidenceFor, routeKey, routerHistoryProjectionDefinition,
} from './router-history.ts'
export type { ActiveCacheEvidence, CacheEvidence, JevRouterHistoryView, RouterHistoryState } from './router-history.ts'

/** Stable identifier written with every route decision for later comparisons. */
export const ROUTER_POLICY_VERSION = 'jev-router/v1'

/** Return one main session to Auto mode through the durable command lifecycle.
 * @param agent - root Agent whose next user turns should be routed automatically.
 * @returns when the Auto command has settled.
 */
export async function enableAutoRouting(agent: Agent): Promise<void> {
  if (!isRootAgent(agent)) throw new Error('jev-router Auto mode is unavailable for subagents')
  const execution = await agent.ctx.commands.execute(agent, '/jev-auto', [], new AbortController().signal)
  if (execution?.result.kind !== 'success') throw new Error('jev-router Auto command is unavailable')
}

/** Cordis package name shared by Host and Client faces. */
export const name = 'jev-router'
/** Host services required by the router. */
export const inject = [
  'agentDefaultModel', 'agents', 'commands', 'llm', 'sessionProjections', 'settings', 'tokenMeter',
]

/** Optional deployment override for the TypeSafe endpoint, useful for a gateway or test server. */
/** Configuration accepted by the Host entry. */
export interface Config extends Partial<JevRouterSettings> {
  endpoint?: string
}

/** Schemastery schema used by the Cordis loader for optional deployment overrides. */
export const Config: z<Config> = z.object({
  endpoint: z.string().min(1).default(DEFAULT_JEV_ENDPOINT),
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
  recordMetrics: z.boolean(), apiKey: z.string(),
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
  currentTurn?: number | undefined
  selection?: { current: ModelSelection | undefined; assembled: ModelSelection | undefined }
  input?: InputMeasurement | undefined
  guardReason?: RouteGuardReason | 'fallback' | undefined
  reportedTurn?: number | undefined
  showDecision?: boolean
  recordMetrics?: boolean
  reasoningSupported?: boolean | undefined
  classificationMs?: number | undefined
  usage?: DecisionReport['usage'] | undefined
  inFlight?: Promise<void> | undefined
  modeCommands: Map<string, boolean>
}

interface DecisionReport {
  policyVersion: string
  turn: number
  suggested: { provider: string; model: string }
  actual: { provider: string; model: string }
  inputTokens: number | null
  estimated: boolean
  reason: string
  reasoningEffort?: string
  reasoningSupported?: boolean
  jevVersion?: string
  fallback?: string
  classificationMs?: number
  classificationUsage?: {
    inputTokens: number | null
    outputTokens: number | null
    totalTokens?: number | null | undefined
    cacheReadTokens?: number | null | undefined
    cacheWriteTokens?: number | null | undefined
  }
  usage?: {
    inputTokens: number | null
    outputTokens: number | null
    totalTokens?: number | null | undefined
    cacheReadTokens?: number | null | undefined
    cacheWriteTokens?: number | null | undefined
    reasoningTokens?: number | null | undefined
  }
}

// Protocol policy: short follow-ups may carry a small evidence window.
const SHORT_FOLLOWUP_MAX_CODE_POINTS = 80
const SHORT_FOLLOWUP_CONTEXT_ITEMS = 3

function isRootAgent(agent: Agent): boolean {
  return agent.session.header.origin !== 'subagent'
}

function textOf(message: UserMessage): string {
  return message.content.map(evidenceOfBlock).filter(Boolean).join('\n')
}

function evidenceOfBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return block.text
    case 'tool-call':
      return `tool call ${block.name}: ${block.arguments}`
    case 'tool-result':
      return block.content.map(evidenceOfBlock).join('\n')
    case 'image':
      return '[image]'
    case 'file':
      return '[file]'
    default:
      return ''
  }
}

function evidenceOfMessage(message: Message): string {
  return message.content.map(evidenceOfBlock).filter(Boolean).join('\n')
}

/** Select the small amount of prior task evidence useful for short follow-ups. */
function relatedContext(agent: Agent, claimed: readonly UserMessage[]): string[] | undefined {
  const input = claimed.map(textOf).join('\n').trim()
  const shortFollowup = Array.from(input).length <= SHORT_FOLLOWUP_MAX_CODE_POINTS
  if (!shortFollowup) return undefined
  const prior = agent.session.deriveMessages().filter(message => message.role !== 'system')
  const context: string[] = []
  for (let index = prior.length - 1; index >= 0 && context.length < SHORT_FOLLOWUP_CONTEXT_ITEMS; index--) {
    const message = prior[index]
    if (message === undefined) continue
    const text = evidenceOfMessage(message).trim()
    if (text.length === 0) continue
    const label = message.role === 'assistant' ? 'previous assistant proposal' : 'previous task evidence'
    context.unshift(`${label}: ${text}`)
  }
  return context.length === 0 ? undefined : context
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

async function settleWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([promise, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

function currentRoute(agent: Agent, state: RouteState, settings: JevRouterSettings): ModelSelection {
  const persisted = agent.session.requestHeader()?.config
  if (persisted !== undefined) {
    return {
      provider: persisted.provider,
      model: persisted.model,
      ...(persisted.reasoningEffort === undefined ? {} : { reasoningEffort: persisted.reasoningEffort }),
    }
  }
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

function decisionReport(state: RouteState): DecisionReport | undefined {
  if ((state.showDecision !== true && state.recordMetrics !== true)
    || state.decision === undefined || state.route === undefined || state.currentTurn === undefined) return undefined
  return {
    policyVersion: ROUTER_POLICY_VERSION,
    turn: state.currentTurn,
    suggested: { provider: state.decision.provider, model: state.decision.model },
    actual: { provider: state.route.provider, model: state.route.model },
    inputTokens: state.input?.tokens ?? null,
    estimated: state.input?.estimated ?? true,
    reason: state.guardReason ?? 'suggestion_applied',
    ...(state.route.reasoningEffort === undefined ? {} : { reasoningEffort: String(state.route.reasoningEffort) }),
    ...(state.reasoningSupported === undefined ? {} : { reasoningSupported: state.reasoningSupported }),
    ...(state.decision.jevVersion === undefined ? {} : { jevVersion: state.decision.jevVersion }),
    ...(state.guardReason === 'fallback' ? { fallback: state.decision.reason ?? 'classification failed' } : {}),
    ...(state.classificationMs === undefined ? {} : { classificationMs: state.classificationMs }),
    ...(state.decision.classificationUsage === undefined ? {} : { classificationUsage: state.decision.classificationUsage }),
    ...(state.usage === undefined ? {} : { usage: state.usage }),
  }
}

function reportDecision(ctx: Context, agent: Agent, state: RouteState): void {
  if (state.currentTurn === undefined || state.reportedTurn === state.currentTurn) return
  const data = decisionReport(state)
  if (data === undefined) return
  state.reportedTurn = data.turn
  const recordMetrics = state.recordMetrics === true
  // session/event observers run inside Session.append() publication. Defer
  // diagnostics until that request commit has completed.
  queueMicrotask(() => {
    if (state.disposed) return
    if (recordMetrics) {
      ctx.logger.info(JSON.stringify({
        event: 'jev-router/decision',
        sessionId: String(agent.session.id),
        ...data,
      }))
    }
  })
}

async function persistVisibleDecision(
  ctx: Context,
  agent: Agent,
  state: RouteState,
  signal: AbortSignal,
  authorize: (rawInput: string | undefined) => void,
): Promise<void> {
  if (state.showDecision !== true) return
  const report = decisionReport(state)
  if (report === undefined || signal.aborted) return
  const rawInput = ` ${encodeDecisionCommandArgs(report)}`
  authorize(rawInput)
  try {
    await ctx.commands.execute(
      agent,
      `/${JEV_DECISION_COMMAND}${rawInput}`,
      [],
      signal,
    )
  } catch (error: unknown) {
    if (!signal.aborted) ctx.logger.warn(`jev-router: failed to persist decision: ${String(error)}`)
  } finally {
    authorize(undefined)
  }
}

function choiceFromDecision(
  decision: JevDecision,
  candidates: readonly CandidateModel[],
  info: LlmResolvedModelInfo,
  current: ModelSelection,
  routeReasoning: boolean,
): { route: ModelSelection; reasoningSupported: boolean } | undefined {
  if (!candidates.some(candidate => routeAllowed(candidate, decision))) return undefined
  const same = current.provider === decision.provider && current.model === decision.model
  if (!routeReasoning || decision.reasoningEffort === undefined) {
    return {
      route: {
        provider: decision.provider,
        model: decision.model,
        ...(same && current.reasoningEffort !== undefined ? { reasoningEffort: current.reasoningEffort } : {}),
      },
      reasoningSupported: info.reasoning !== undefined,
    }
  }
  if (info.reasoning?.efforts.some(effort => String(effort.id) === decision.reasoningEffort) !== true) {
    throw new Error(`Jev selected unsupported reasoning effort "${decision.reasoningEffort}" for ${decision.provider}/${decision.model}`)
  }
  return {
    route: { provider: decision.provider, model: decision.model, reasoningEffort: ReasoningEffortId(decision.reasoningEffort) },
    reasoningSupported: true,
  }
}

/** Install one per-agent route controller on a live main Agent. */
function installAgent(
  ctx: Context,
  agent: Agent,
  endpoint: string,
  scope: { get(): JevRouterSettings },
  defaultFixed: boolean,
  authorizeDecision: (rawInput: string | undefined) => void,
  registry?: Set<RouteState>,
): () => Promise<void> {
  if (!isRootAgent(agent)) return () => Promise.resolve()
  const restored = ctx.sessionProjections.stateOf(agent.session, 'jevRouterHistory')
  const latestDecision = restored?.latestDecision
  const requestRoute = agent.session.requestHeader()?.config
  let restoredRoute: ModelSelection | undefined = requestRoute === undefined ? undefined : {
    provider: requestRoute.provider,
    model: requestRoute.model,
    ...(requestRoute.reasoningEffort === undefined ? {} : { reasoningEffort: requestRoute.reasoningEffort }),
  }
  if (restoredRoute === undefined && restored?.currentRoute !== undefined) {
    restoredRoute = { provider: restored.currentRoute.provider, model: restored.currentRoute.model }
    if (latestDecision !== undefined && restored.openTurn !== undefined
      && latestDecision.turn === restored.openTurn
      && latestDecision.actual.provider === restored.currentRoute.provider
      && latestDecision.actual.model === restored.currentRoute.model
      && latestDecision.reasoningEffort !== undefined) {
      restoredRoute.reasoningEffort = ReasoningEffortId(latestDecision.reasoningEffort)
    }
  }
  const fixed = restored?.mode === undefined ? defaultFixed : restored.mode === 'fixed'
  const state: RouteState = {
    claimed: [],
    modeCommands: new Map(),
    fixed,
    disposed: false,
    generation: 0,
    ...(!fixed && restoredRoute !== undefined ? { route: restoredRoute } : {}),
    ...(restored?.openTurn === undefined ? {} : { currentTurn: restored.openTurn, classifiedTurn: restored.openTurn }),
  }
  registry?.add(state)
  const selection = {
    current: fixed && restored?.commandFixed !== true ? undefined : restoredRoute,
    assembled: undefined as ModelSelection | undefined,
  }
  state.selection = selection
  const disposeSelection = installModelSelection(agent.ctx, selection)
  const disposeClaimed = agent.ctx.on('agent/inbox/claimed', ({ message, turn }) => {
    state.currentTurn = turn
    if (state.classifiedTurn !== turn) state.claimed.push(message)
  })
  const handleSessionEvent = (session: typeof agent.session, event: SessionEvent): void => {
    if (session !== agent.session) return
    if (event.type === 'assistant/message'
      && state.decision !== undefined
      && sameRoute(event.data.message.source, state.route ?? event.data.message.source)) {
      const usage = event.data.usage
      state.usage = usage === undefined ? undefined : {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
        cacheReadTokens: usage.cacheReadTokens ?? null,
        cacheWriteTokens: usage.cacheWriteTokens ?? null,
        reasoningTokens: usage.reasoningTokens ?? null,
      }
      // Prefer the first assistant settlement that carries usage. If a
      // provider omits usage for an early step, a later tool continuation may
      // still report it; defer the decision record until then or turn/end.
      if (usage !== undefined) reportDecision(ctx, agent, state)
      return
    }
    if (event.type === 'turn/end' && state.currentTurn === event.data.turn) {
      if (state.decision !== undefined) reportDecision(ctx, agent, state)
      state.currentTurn = undefined
      state.classifiedTurn = undefined
      state.decision = undefined
      state.guardReason = undefined
      state.input = undefined
      state.usage = undefined
      return
    }
    if (event.type === 'command/run'
      && (event.data.name === 'jev-auto' || event.data.name === 'jev-fixed')) {
      state.modeCommands.set(String(event.data.commandId), event.data.name === 'jev-fixed')
      return
    }
    if (event.type === 'command/done') {
      const nextFixed = state.modeCommands.get(String(event.data.commandId))
      if (nextFixed === undefined) return
      state.modeCommands.delete(String(event.data.commandId))
      if (event.data.kind !== 'success') return
      const wasFixed = state.fixed
      state.fixed = nextFixed
      state.generation++
      state.abort?.abort(new Error(`jev-router mode changed to ${nextFixed ? 'fixed' : 'auto'}`))
      if (nextFixed) {
        const fixedRoute = currentRoute(agent, state, scope.get())
        selection.current = fixedRoute
        state.route = fixedRoute
      } else {
        selection.current = undefined
        state.route = undefined
      }
      if (wasFixed === state.fixed) return
      return
    }
    if (event.type !== 'model/selection') return
    state.fixed = true
    state.generation++
    state.abort?.abort(new Error('manual model selection'))
    selection.current = undefined
    state.route = undefined
  }
  const disposeSession = ctx.on('session/event', handleSessionEvent)
  if (!state.fixed && restored?.mode === undefined) {
    queueMicrotask(() => {
      // A manual selection or Fixed command can win during agent construction;
      // never let the deferred default-Auto record overwrite that user action.
      if (!state.disposed && !state.fixed) {
        void ctx.commands.execute(agent, '/jev-auto', [], new AbortController().signal)
      }
    })
  }
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
    let finish!: () => void
    state.inFlight = new Promise<void>(resolve => { finish = resolve })
    state.classifiedTurn = turnNumber
    state.reportedTurn = undefined
    state.showDecision = settings.showDecision
    state.recordMetrics = settings.recordMetrics
    state.classificationMs = undefined
    const generation = ++state.generation
    const controller = new AbortController()
    state.abort = controller
    let timedOut = false
    const classificationTimer = setTimeout(
      () => {
        timedOut = true
        controller.abort(new Error('Jev classification timed out'))
      },
      settings.jevTimeoutMs,
    )
    const linkedAbort = (): void => controller.abort()
    _context.signal?.addEventListener('abort', linkedAbort, { once: true })
    let history: RouterHistoryState | undefined
    let activeRoute: ModelSelection | undefined
    let classificationStarted: number | undefined
    try {
      history = ctx.sessionProjections.stateOf(agent.session, 'jevRouterHistory')
      activeRoute = currentRoute(agent, state, settings)
      const apiKey = settings.apiKey.trim()
      if (apiKey.length === 0) throw new Error('Jev API key is not configured')
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
      const reasoningOptions = candidates.map(candidate => {
        const info = candidateInfo.get(routeKey(candidate.provider, candidate.model))
        return {
          provider: candidate.provider,
          model: candidate.model,
          efforts: info?.reasoning?.efforts.map(effort => String(effort.id)) ?? [],
        }
      })
      const context = relatedContext(agent, state.claimed)
      const stateInput = {
        input: state.claimed.map(textOf).join('\n'),
        ...(context === undefined ? {} : { context }),
        candidates,
        reasoning: {
          enabled: settings.routeReasoning,
          ...(activeRoute.reasoningEffort === undefined ? {} : { current: String(activeRoute.reasoningEffort) }),
          options: reasoningOptions,
        },
        ...(settings.cacheAware
          ? { cache: {
              route: { provider: activeRoute.provider, model: activeRoute.model },
              evidence: history === undefined
                ? { status: 'unknown' as const }
                : cacheEvidenceFor(history, activeRoute),
            } }
          : {}),
      }
      classificationStarted = performance.now()
      const decision = await classifyWithJev(boundJevState(stateInput, settings.jevMaxStateChars), settings, apiKey, controller.signal, { endpoint })
      state.classificationMs = Math.max(0, Math.round(performance.now() - classificationStarted))
      const info = candidateInfo.get(routeKey(decision.provider, decision.model))
      if (info === undefined) throw new Error('Jev selected a route outside the compatible candidate set')
      const choice = choiceFromDecision(decision, candidates, info, activeRoute, settings.routeReasoning)
      if (choice === undefined) throw new Error('Jev selected a route outside the configured candidate allow-list')
      if (state.disposed || controller.signal.aborted || generation !== state.generation || !scope.get().enabled) return next()
      const guarded = resolveGuardedRoute({
        current: activeRoute,
        suggested: choice.route,
        candidates: settings.candidateModels,
        input,
        completedUserTurnsSinceSwitch: history?.completedUserTurnsSinceSwitch,
        settings,
      })
      selection.current = guarded.actual
      state.route = guarded.actual
      state.decision = decision
      state.guardReason = guarded.reason
      state.reasoningSupported = choice.reasoningSupported
      await persistVisibleDecision(ctx, agent, state, controller.signal, authorizeDecision)
    } catch (error) {
      if (!controller.signal.aborted || timedOut) {
        if (classificationStarted !== undefined && state.classificationMs === undefined) {
          state.classificationMs = Math.max(0, Math.round(performance.now() - classificationStarted))
        }
        const fallback = activeRoute ?? settings.defaultModel
        const fallbackController = new AbortController()
        state.abort = fallbackController
        const abortFallback = (): void => fallbackController.abort(_context.signal?.reason)
        _context.signal?.addEventListener('abort', abortFallback, { once: true })
        try {
          await ctx.llm.resolveModelInfo(fallback.provider, fallback.model, fallbackController.signal)
        } catch (fallbackError: unknown) {
          if (fallbackController.signal.aborted
            && (state.disposed || generation !== state.generation
              || !scope.get().enabled || _context.signal?.aborted === true)) return next()
          throw new Error(`no usable fallback model (${fallback.provider}/${fallback.model}): ${String(fallbackError)}`, { cause: fallbackError })
        } finally {
          _context.signal?.removeEventListener('abort', abortFallback)
        }
        if (state.disposed || generation !== state.generation || !scope.get().enabled) return next()
        selection.current = {
          provider: fallback.provider,
          model: fallback.model,
          ...(fallback.reasoningEffort === undefined ? {} : { reasoningEffort: fallback.reasoningEffort }),
        }
        state.route = selection.current
        state.decision = { provider: fallback.provider, model: fallback.model, reason: `fallback: ${String(error)}` }
        state.guardReason = 'fallback'
        state.reasoningSupported = undefined
        await persistVisibleDecision(ctx, agent, state, fallbackController.signal, authorizeDecision)
      }
    } finally {
      clearTimeout(classificationTimer)
      _context.signal?.removeEventListener('abort', linkedAbort)
      state.abort = undefined
      state.claimed = []
      finish()
      state.inFlight = undefined
    }
    return next()
  }, { prepend: true })
  return async () => {
    state.disposed = true
    state.abort?.abort(new Error('jev-router unloaded'))
    registry?.delete(state)
    disposeClaimed(); disposeSession(); disposeAssembly(); disposeSelection()
    await state.inFlight
  }
}

/**
 * Host plugin entry.
 * @param ctx - host Cordis context with Agent, model, and settings services.
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
  ctx.commands.register({
    definitionId: CommandDefinitionId('@zong/dsh-jev-router/auto'),
    name: 'jev-auto',
    description: 'Return this session to Jev automatic routing',
    recordInput: false,
    handler: ({ agent }) => {
      if (!isRootAgent(agent)) throw new Error('jev-router Auto mode is unavailable for subagents')
      return { kind: 'success', text: 'Jev routing is now Auto.' }
    },
  })
  const authorizedDecisions = new WeakMap<Agent, string>()
  ctx.commands.register({
    definitionId: CommandDefinitionId('@zong/dsh-jev-router/fixed'),
    name: 'jev-fixed',
    description: 'Keep this session on its current model route',
    recordInput: false,
    handler: ({ agent }) => {
      if (!isRootAgent(agent)) throw new Error('jev-router Fixed mode is unavailable for subagents')
      return { kind: 'success', text: 'Jev routing is now Fixed.' }
    },
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId('@zong/dsh-jev-router/decision'),
    name: JEV_DECISION_COMMAND,
    description: 'Record an applied Jev route decision',
    recordInput: true,
    handler: ({ agent, rawInput }) => {
      const authorized = authorizedDecisions.get(agent)
      authorizedDecisions.delete(agent)
      if (!isRootAgent(agent) || authorized !== rawInput || decodeDecisionCommandArgs(rawInput) === undefined) {
        return { kind: 'error', text: 'Invalid Jev route decision record.' }
      }
      return { kind: 'success' }
    },
  })
  const installed = new Map<Agent, () => Promise<void>>()
  const states = new Set<RouteState>()
  const install = (agent: Agent, defaultFixed: boolean): void => {
    if (installed.has(agent)) return
    const dispose = installAgent(
      ctx,
      agent,
      config.endpoint ?? DEFAULT_JEV_ENDPOINT,
      settings,
      defaultFixed || !settings.get().enabled,
      rawInput => {
        if (rawInput === undefined) authorizedDecisions.delete(agent)
        else authorizedDecisions.set(agent, rawInput)
      },
      states,
    )
    installed.set(agent, dispose)
  }
  for (const agent of ctx.agents.list()) install(agent, true)
  ctx.on('agent/created', ({ agent, source }) => { install(agent, source !== 'startup') })
  ctx.on('agent/disposed', async ({ agent }) => { await installed.get(agent)?.(); installed.delete(agent) })
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
  ctx.effect(() => async () => {
    disposeHistory()
    disposeSettings()
    await Promise.all([...installed.values()].map(dispose => dispose()))
    installed.clear()
  }, 'jev-router: agent routes')
}
