/** Replayable route, completed-turn, and cache evidence derived from Session events. */
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** Durable, user-visible outcome of one applied routing decision. */
export interface JevRouterDecisionView {
  /** Version of the routing policy that produced this decision. */
  policyVersion?: string | undefined
  turn: number
  suggested: { provider: string; model: string }
  actual: { provider: string; model: string }
  inputTokens: number | null
  estimated: boolean
  reason: string
  reasoningEffort?: string | undefined
  reasoningSupported?: boolean | undefined
  fallback?: string | undefined
  jevVersion?: string | undefined
  /** Wall-clock time spent waiting for the Jev classification request. */
  classificationMs?: number | undefined
  /** Usage reported by TypeSafe for the classification request. */
  classificationUsage?: {
    inputTokens: number | null
    outputTokens: number | null
    totalTokens?: number | null | undefined
    cacheReadTokens?: number | null | undefined
    cacheWriteTokens?: number | null | undefined
  } | undefined
  /** Usage reported by the actual execution request for this turn. */
  usage?: {
    inputTokens: number | null
    outputTokens: number | null
    totalTokens?: number | null | undefined
    cacheReadTokens?: number | null | undefined
    cacheWriteTokens?: number | null | undefined
    reasoningTokens?: number | null | undefined
  } | undefined
}

/** Client-visible durable mode plus the latest optional decision. */
export interface JevRouterHistoryView {
  mode?: 'auto' | 'fixed' | undefined
  decision?: JevRouterDecisionView | undefined
}

/** Internal standard command used to persist an informational route decision. */
export const JEV_DECISION_COMMAND = 'jev-router-decision'
/** Internal command that mirrors an automatic route into the standard model-selection projection. */
export const JEV_ROUTE_SYNC_COMMAND = 'jev-router-route-sync'

const routeSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
}).strict()

const cacheEvidenceSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unknown'), observedAt: z.number().int().nonnegative() }).strict(),
  z.object({
    status: z.literal('known'),
    cacheReadTokens: z.number().int().nonnegative(),
    uncachedInputTokens: z.number().int().nonnegative(),
    observedAt: z.number().int().nonnegative(),
  }).strict(),
])

const decisionViewSchema = z.object({
  policyVersion: z.string().min(1).optional(),
  turn: z.number().int().nonnegative(),
  suggested: routeSchema,
  actual: routeSchema,
  inputTokens: z.number().int().nonnegative().nullable(),
  estimated: z.boolean(),
  reason: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
  reasoningSupported: z.boolean().optional(),
  fallback: z.string().min(1).optional(),
  jevVersion: z.string().min(1).optional(),
  classificationMs: z.number().nonnegative().optional(),
  classificationUsage: z.object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable().optional(),
    cacheReadTokens: z.number().int().nonnegative().nullable().optional(),
    cacheWriteTokens: z.number().int().nonnegative().nullable().optional(),
  }).strict().optional(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable().optional(),
    cacheReadTokens: z.number().int().nonnegative().nullable().optional(),
    cacheWriteTokens: z.number().int().nonnegative().nullable().optional(),
    reasoningTokens: z.number().int().nonnegative().nullable().optional(),
  }).strict().optional(),
}).strict()

const historyViewSchema = z.object({
  mode: z.union([z.literal('auto'), z.literal('fixed')]).optional(),
  decision: decisionViewSchema.optional(),
}).strict()

const commandIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mode'), mode: z.union([z.literal('auto'), z.literal('fixed')]), commandFixed: z.boolean() }).strict(),
  z.object({ kind: z.literal('decision'), decision: decisionViewSchema }).strict(),
  z.object({ kind: z.literal('route-sync'), route: routeSchema }).strict(),
])

/** Cache evidence for one exact provider/model route. */
export type CacheEvidence = z.infer<typeof cacheEvidenceSchema>
type KnownCacheEvidence = Extract<CacheEvidence, { status: 'known' }>

/** Evidence safe to attach to the next classification request. */
export type ActiveCacheEvidence = KnownCacheEvidence | { status: 'unknown' }

const routerHistoryStateSchema = z.object({
  sessionId: z.string().min(1),
  openTurn: z.number().int().nonnegative().optional(),
  currentRoute: routeSchema.optional(),
  switchedTurn: z.number().int().nonnegative().optional(),
  completedUserTurnsSinceSwitch: z.number().int().nonnegative().optional(),
  cacheByRoute: z.record(z.string(), cacheEvidenceSchema),
  lastResponseRouteKey: z.string().optional(),
  latestDecision: decisionViewSchema.optional(),
  pendingDecision: decisionViewSchema.optional(),
  view: historyViewSchema,
  commandIntents: z.record(z.string(), commandIntentSchema),
  mode: z.union([z.literal('auto'), z.literal('fixed')]).optional(),
  commandFixed: z.boolean().optional(),
}).strict()

/** Host-only state required to apply route guards after restart. */
export type RouterHistoryState = z.infer<typeof routerHistoryStateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    jevRouterHistory: JevRouterHistoryView
  }
  interface SessionProjectionStateMap {
    jevRouterHistory: RouterHistoryState
  }
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionMap {
    jevRouterHistory: JevRouterHistoryView
  }
}

/** Encode a validated decision into the standard command lifecycle's args field. */
export function encodeDecisionCommandArgs(decision: JevRouterDecisionView): string {
  return JSON.stringify(decision)
}

/** Decode the informational command payload during deterministic projection replay. */
export function decodeDecisionCommandArgs(args: string | undefined): JevRouterDecisionView | undefined {
  if (args === undefined) return undefined
  try {
    const parsed = decisionViewSchema.safeParse(JSON.parse(args.trim()))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** Encode an automatic route for the internal model-selection synchronization command. */
export function encodeRouteSyncCommandArgs(route: { provider: string; model: string; reasoningEffort?: string }): string {
  return JSON.stringify(route)
}

/** Decode one internally authorized automatic route synchronization payload. */
export function decodeRouteSyncCommandArgs(
  args: string | undefined,
): { provider: string; model: string; reasoningEffort?: string } | undefined {
  if (args === undefined) return undefined
  try {
    const parsed = z.object({
      provider: z.string().min(1),
      model: z.string().min(1),
      reasoningEffort: z.string().min(1).optional(),
    }).strict().safeParse(JSON.parse(args.trim()))
    if (!parsed.success) return undefined
    return {
      provider: parsed.data.provider,
      model: parsed.data.model,
      ...(parsed.data.reasoningEffort === undefined ? {} : { reasoningEffort: parsed.data.reasoningEffort }),
    }
  } catch {
    return undefined
  }
}

/** Stable storage key for one exact provider/model route. */
/**
 * @param provider - registered provider route.
 * @param model - provider-owned model id.
 * @returns an unambiguous encoded pair.
 */
export function routeKey(provider: string, model: string): string {
  return `${encodeURIComponent(provider)}/${encodeURIComponent(model)}`
}

function sameRoute(
  left: { provider: string; model: string } | undefined,
  right: { provider: string; model: string },
): boolean {
  return left?.provider === right.provider && left.model === right.model
}

function viewWithMode(state: RouterHistoryState, mode: 'auto' | 'fixed'): JevRouterHistoryView {
  return state.view.mode === mode ? state.view : { ...state.view, mode }
}

/** Return only cache evidence still relevant to the active exact route. */
/**
 * @param state - replayed state for one Session.
 * @param route - current actual provider/model route.
 * @returns known provider evidence or an explicit unknown marker.
 */
export function cacheEvidenceFor(
  state: RouterHistoryState,
  route: { provider: string; model: string },
): ActiveCacheEvidence {
  const key = routeKey(route.provider, route.model)
  if (!sameRoute(state.currentRoute, route) || state.lastResponseRouteKey !== key) return { status: 'unknown' }
  const evidence = state.cacheByRoute[key]
  return evidence?.status === 'known' ? evidence : { status: 'unknown' }
}

/** Host-only durable-history projection shared by every routed main session. */
export const routerHistoryProjectionDefinition = {
  key: 'jevRouterHistory',
  stateVersion: 5,
  stateSchema: routerHistoryStateSchema,
  init: (header, _inheritedEventCount): RouterHistoryState => ({
    sessionId: String(header.id),
    cacheByRoute: {},
    commandIntents: {},
    view: {},
  }),
  apply: (state: RouterHistoryState, event: SessionEvent): RouterHistoryState => {
    if (event.type === 'command/run' && event.data.name === 'jev-auto') {
      return {
        ...state,
        commandIntents: {
          ...state.commandIntents,
          [event.data.commandId]: { kind: 'mode', mode: 'auto', commandFixed: false },
        },
      }
    }
    if (event.type === 'command/run' && event.data.name === 'jev-fixed') {
      return {
        ...state,
        commandIntents: {
          ...state.commandIntents,
          [event.data.commandId]: { kind: 'mode', mode: 'fixed', commandFixed: true },
        },
      }
    }
    if (event.type === 'command/run' && event.data.name === JEV_DECISION_COMMAND) {
      const decision = decodeDecisionCommandArgs(event.data.args)
      return decision === undefined
        ? state
        : {
            ...state,
            commandIntents: {
              ...state.commandIntents,
              [event.data.commandId]: { kind: 'decision', decision },
            },
          }
    }
    if (event.type === 'command/run' && event.data.name === JEV_ROUTE_SYNC_COMMAND) {
      const route = decodeRouteSyncCommandArgs(event.data.args)
      return route === undefined
        ? state
        : {
            ...state,
            commandIntents: {
              ...state.commandIntents,
              [event.data.commandId]: { kind: 'route-sync', route },
            },
          }
    }
    if (event.type === 'command/done') {
      const intent = state.commandIntents[event.data.commandId]
      if (intent === undefined) return state
      const { [event.data.commandId]: _done, ...remaining } = state.commandIntents
      if (event.data.kind !== 'success') return { ...state, commandIntents: remaining }
      if (intent.kind === 'mode') {
        return {
          ...state,
          commandIntents: remaining,
          mode: intent.mode,
          commandFixed: intent.commandFixed,
          view: viewWithMode(state, intent.mode),
        }
      }
      if (intent.kind === 'route-sync') return { ...state, commandIntents: remaining }
      return {
        ...state,
        commandIntents: remaining,
        pendingDecision: intent.decision,
      }
    }
    if (event.type === 'model/selection') {
      const automatic = Object.values(state.commandIntents).some(intent => intent.kind === 'route-sync'
        && sameRoute(intent.route, event.data))
      if (automatic) return state
      return { ...state, mode: 'fixed', commandFixed: false, view: viewWithMode(state, 'fixed') }
    }
    if (event.type === 'turn/start') return { ...state, openTurn: event.data.turn }
    if (event.type === 'request/header') {
      const route = {
        provider: event.data.header.config.provider,
        model: event.data.header.config.model,
      }
      const pending = state.pendingDecision !== undefined
        && state.pendingDecision.turn === state.openTurn
        && sameRoute(state.pendingDecision.actual, route)
        ? state.pendingDecision
        : undefined
      const { pendingDecision: _pending, ...withoutPending } = state
      if (sameRoute(state.currentRoute, route)) {
        return state.pendingDecision === undefined
          ? state
          : pending === undefined
            ? withoutPending
          : {
              ...withoutPending,
              latestDecision: pending,
              view: { ...state.view, decision: pending },
            }
      }
      const { lastResponseRouteKey: _staleCache, ...withoutLastResponse } = withoutPending
      const switched = state.currentRoute !== undefined && state.openTurn !== undefined
      return {
        ...withoutLastResponse,
        currentRoute: route,
        ...(pending === undefined
          ? {}
          : { latestDecision: pending, view: { ...state.view, decision: pending } }),
        ...(switched
          ? { switchedTurn: state.openTurn, completedUserTurnsSinceSwitch: 0 }
          : {}),
      }
    }
    if (event.type === 'turn/end') {
      const { openTurn: _closedTurn, pendingDecision: _pending, ...closed } = state
      if (event.data.reason.kind !== 'completed' || state.switchedTurn === undefined) return closed
      return {
        ...closed,
        completedUserTurnsSinceSwitch: (state.completedUserTurnsSinceSwitch ?? 0) + 1,
      }
    }
    if (event.type === 'assistant/message') {
      const key = routeKey(event.data.message.source.provider, event.data.message.source.model)
      const pending = state.pendingDecision !== undefined
        && state.pendingDecision.turn === state.openTurn
        && sameRoute(state.pendingDecision.actual, event.data.message.source)
        ? state.pendingDecision
        : undefined
      const { pendingDecision: _pending, ...withoutPending } = state
      const usage = event.data.usage
      const usageView = usage === undefined ? undefined : {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
        cacheReadTokens: usage.cacheReadTokens ?? null,
        cacheWriteTokens: usage.cacheWriteTokens ?? null,
        reasoningTokens: usage.reasoningTokens ?? null,
      }
      const existing = pending === undefined
        && state.latestDecision !== undefined
        && state.latestDecision.turn === state.openTurn
        && sameRoute(state.latestDecision.actual, event.data.message.source)
        ? state.latestDecision
        : pending
      const completedDecision = existing === undefined || usageView === undefined
        ? existing
        : { ...existing, usage: usageView }
      const evidence: CacheEvidence = usage?.cacheReadTokens === undefined
        ? { status: 'unknown', observedAt: event.time }
        : {
            status: 'known',
            cacheReadTokens: usage.cacheReadTokens,
            uncachedInputTokens: usage.inputTokens,
            observedAt: event.time,
          }
      return {
        ...withoutPending,
        cacheByRoute: { ...state.cacheByRoute, [key]: evidence },
        lastResponseRouteKey: key,
        ...(completedDecision === undefined
          ? {}
          : { latestDecision: completedDecision, view: { ...state.view, decision: completedDecision } }),
      }
    }
    return state
  },
  wire: {
    viewSchema: historyViewSchema,
    view: state => state.view,
  },
} satisfies ProjectionDefinition<'jevRouterHistory', RouterHistoryState> & {
  wire: NonNullable<ProjectionDefinition<'jevRouterHistory', RouterHistoryState>['wire']>
}
