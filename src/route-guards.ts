/** Pure route constraints applied after Jev returns an allowed candidate. */
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { CandidateModel, JevRouterSettings } from './config.ts'

/** Replay-backed estimate of the complete input for the proposed request. */
export interface InputMeasurement {
  tokens?: number
  estimated: boolean
}

/** Stable reasons consumed by diagnostics and the later presentation layer. */
export type RouteGuardReason =
  | 'suggestion_applied'
  | 'context_keep'
  | 'context_unknown'
  | 'context_upgrade_only'
  | 'minimum_hold'
  | 'tier_incomparable'

/** Result of applying explicit switch constraints to one allowed suggestion. */
export interface GuardedRoute {
  suggested: ModelSelection
  actual: ModelSelection
  reason: RouteGuardReason
}

/** Inputs captured at the beginning of one user turn. */
export interface RouteGuardInput {
  current: ModelSelection | undefined
  suggested: ModelSelection
  candidates: readonly CandidateModel[]
  input: InputMeasurement
  completedUserTurnsSinceSwitch: number | undefined
  settings: JevRouterSettings
}

function routeEquals(left: ModelSelection, right: ModelSelection): boolean {
  return left.provider === right.provider && left.model === right.model
}

/** Apply long-context and hold constraints without changing the Jev suggestion. */
/**
 * @param input - turn snapshot, measured input, and actual route history.
 * @returns suggested and actual routes plus the rule that produced the result.
 */
export function resolveGuardedRoute(input: RouteGuardInput): GuardedRoute {
  const { current, suggested, settings } = input
  if (current === undefined || routeEquals(current, suggested)) {
    return { suggested, actual: suggested, reason: 'suggestion_applied' }
  }
  const currentTier = input.candidates.find(candidate => routeEquals(candidate, current))?.tier
  const suggestedTier = input.candidates.find(candidate => routeEquals(candidate, suggested))?.tier
  const isUpgrade = currentTier === 'economy' && suggestedTier === 'capability'
  if (input.input.tokens === undefined && !isUpgrade) {
    return { suggested, actual: current, reason: 'context_unknown' }
  }
  const overLimit = settings.switchContextLimitTokens !== null
    && input.input.tokens !== undefined
    && input.input.tokens > settings.switchContextLimitTokens
  if (overLimit && settings.overLimitPolicy === 'keep') {
    return { suggested, actual: current, reason: 'context_keep' }
  }
  if (overLimit && settings.overLimitPolicy === 'upgrade_only') {
    if (!isUpgrade) {
      const reason = currentTier === undefined || suggestedTier === undefined
        ? 'tier_incomparable'
        : 'context_upgrade_only'
      return { suggested, actual: current, reason }
    }
  }
  if (!isUpgrade
    && settings.minHoldUserTurns > 0
    && input.completedUserTurnsSinceSwitch !== undefined
    && input.completedUserTurnsSinceSwitch < settings.minHoldUserTurns) {
    return { suggested, actual: current, reason: 'minimum_hold' }
  }
  return { suggested, actual: suggested, reason: 'suggestion_applied' }
}
