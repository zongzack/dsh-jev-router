/** Replayable route, completed-turn, and cache evidence derived from Session events. */
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** Durable, user-visible outcome of one applied routing decision. */
export interface JevRouterDecisionView {
  turn: number
  suggested: { provider: string; model: string }
  actual: { provider: string; model: string }
  inputTokens: number | null
  estimated: boolean
  reason: string
}

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
  turn: z.number().int().nonnegative(),
  suggested: routeSchema,
  actual: routeSchema,
  inputTokens: z.number().int().nonnegative().nullable(),
  estimated: z.boolean(),
  reason: z.string().min(1),
}).strict()

/** Cache evidence for one exact provider/model route. */
export type CacheEvidence = z.infer<typeof cacheEvidenceSchema>
type KnownCacheEvidence = Extract<CacheEvidence, { status: 'known' }>

/** Evidence safe to attach to the next classification request. */
export type ActiveCacheEvidence = KnownCacheEvidence | { status: 'unknown' }

const routerHistoryStateSchema = z.object({
  openTurn: z.number().int().nonnegative().optional(),
  currentRoute: routeSchema.optional(),
  switchedTurn: z.number().int().nonnegative().optional(),
  completedUserTurnsSinceSwitch: z.number().int().nonnegative().optional(),
  cacheByRoute: z.record(z.string(), cacheEvidenceSchema),
  lastResponseRouteKey: z.string().optional(),
  latestDecision: decisionViewSchema.optional(),
}).strict()

/** Host-only state required to apply route guards after restart. */
export type RouterHistoryState = z.infer<typeof routerHistoryStateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    jevRouterHistory: JevRouterDecisionView | undefined
  }
  interface SessionProjectionStateMap {
    jevRouterHistory: RouterHistoryState
  }
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionMap {
    jevRouterHistory: JevRouterDecisionView | undefined
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'jev-router/decision': JevRouterDecisionView
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
  stateVersion: 1,
  stateSchema: routerHistoryStateSchema,
  init: (_header, _inheritedEventCount): RouterHistoryState => ({ cacheByRoute: {} }),
  apply: (state: RouterHistoryState, event: SessionEvent): RouterHistoryState => {
    if (event.type === 'jev-router/decision') return { ...state, latestDecision: event.data }
    if (event.type === 'turn/start') return { ...state, openTurn: event.data.turn }
    if (event.type === 'request/header') {
      const route = {
        provider: event.data.header.config.provider,
        model: event.data.header.config.model,
      }
      if (sameRoute(state.currentRoute, route)) return state
      const { lastResponseRouteKey: _staleCache, ...withoutLastResponse } = state
      const switched = state.currentRoute !== undefined && state.openTurn !== undefined
      return {
        ...withoutLastResponse,
        currentRoute: route,
        ...(switched
          ? { switchedTurn: state.openTurn, completedUserTurnsSinceSwitch: 0 }
          : {}),
      }
    }
    if (event.type === 'turn/end') {
      const { openTurn: _closedTurn, ...closed } = state
      if (event.data.reason.kind !== 'completed' || state.switchedTurn === undefined) return closed
      return {
        ...closed,
        completedUserTurnsSinceSwitch: (state.completedUserTurnsSinceSwitch ?? 0) + 1,
      }
    }
    if (event.type === 'assistant/message') {
      const key = routeKey(event.data.message.source.provider, event.data.message.source.model)
      const usage = event.data.usage
      const evidence: CacheEvidence = usage?.cacheReadTokens === undefined
        ? { status: 'unknown', observedAt: event.time }
        : {
            status: 'known',
            cacheReadTokens: usage.cacheReadTokens,
            uncachedInputTokens: usage.inputTokens,
            observedAt: event.time,
          }
      return {
        ...state,
        cacheByRoute: { ...state.cacheByRoute, [key]: evidence },
        lastResponseRouteKey: key,
      }
    }
    return state
  },
  wire: {
    viewSchema: decisionViewSchema.optional(),
    view: state => state.latestDecision,
  },
} satisfies ProjectionDefinition<'jevRouterHistory', RouterHistoryState> & {
  wire: NonNullable<ProjectionDefinition<'jevRouterHistory', RouterHistoryState>['wire']>
}
