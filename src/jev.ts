import type { CandidateModel, JevRouterSettings } from './config.ts'
import type { ActiveCacheEvidence } from './router-history.ts'

/** Structured state sent to TypeSafe; it intentionally contains no credentials. */
export interface JevState {
  input: string
  context?: readonly string[]
  candidates: readonly CandidateModel[]
  reasoning?: {
    enabled: boolean
    current?: string
    options: readonly {
      provider: string
      model: string
      efforts: readonly string[]
    }[]
  }
  cache?: {
    route: { provider: string; model: string }
    evidence: ActiveCacheEvidence
  }
  truncated?: true
}

/** Validated Jev routing response. */
export interface JevDecision {
  provider: string
  model: string
  reasoningEffort?: string
  confidence?: number
  reason?: string
  jevVersion?: string
}

/** Optional transport overrides used by tests and deployments. */
export interface JevClientOptions {
  endpoint?: string
  fetch?: typeof globalThis.fetch
}

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/system-one'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readDecision(value: unknown): JevDecision {
  const root = isRecord(value) && isRecord(value.result) ? value.result : value
  if (!isRecord(root) || typeof root.provider !== 'string' || typeof root.model !== 'string') {
    throw new Error('Jev returned no valid provider/model choice')
  }
  if (root.reasoningEffort !== undefined && typeof root.reasoningEffort !== 'string') {
    throw new Error('Jev returned an invalid reasoning effort')
  }
  if (root.confidence !== undefined
    && (typeof root.confidence !== 'number' || !Number.isFinite(root.confidence)
      || root.confidence < 0 || root.confidence > 1)) {
    throw new Error('Jev returned an invalid confidence')
  }
  return {
    provider: root.provider,
    model: root.model,
    ...(root.reasoningEffort === undefined ? {} : { reasoningEffort: root.reasoningEffort }),
    ...(root.confidence === undefined ? {} : { confidence: root.confidence }),
    ...(typeof root.reason === 'string' ? { reason: root.reason } : {}),
    ...(typeof root.jevVersion === 'string' ? { jevVersion: root.jevVersion } : {}),
  }
}

/** Call TypeSafe System One with a bounded total wait and a bearer credential. */
/**
 * @param state - bounded routing evidence and candidate allow-list.
 * @param settings - timeout and routing settings.
 * @param apiKey - resolved TypeSafe credential.
 * @param signal - caller-owned cancellation signal.
 * @param options - endpoint and fetch overrides.
 * @returns the validated structured route decision.
 */
export async function classifyWithJev(
  state: JevState,
  settings: JevRouterSettings,
  apiKey: string,
  signal: AbortSignal,
  options: JevClientOptions = {},
): Promise<JevDecision> {
  const controller = new AbortController()
  const abort = (): void => controller.abort(signal.reason)
  if (signal.aborted) abort()
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('Jev classification timed out')), settings.jevTimeoutMs)
  try {
    const response = await (options.fetch ?? globalThis.fetch)(options.endpoint ?? DEFAULT_ENDPOINT, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'jev-latest',
        state,
        choice: {
          name: 'model',
          options: state.candidates.map(candidate => ({
            provider: candidate.provider,
            model: candidate.model,
            description: candidate.description,
            tier: candidate.tier,
          })),
        },
        ...(state.reasoning === undefined ? {} : {
          reasoning: {
            enabled: state.reasoning.enabled,
            current: state.reasoning.current,
            options: state.reasoning.options,
          },
        }),
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Jev request failed with HTTP ${String(response.status)}`)
    return readDecision(await response.json())
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

/** Keep serialized routing evidence within the configured Unicode budget. */
/**
 * @param state - unbounded routing evidence.
 * @param maxChars - inclusive serialized JSON character budget.
 * @returns evidence that fits the budget and records truncation when needed.
 */
export function boundJevState(state: JevState, maxChars: number): JevState {
  if (!Number.isInteger(maxChars) || maxChars <= 0) throw new RangeError('maxChars must be positive')
  const serializedLength = (candidate: JevState): number => Array.from(JSON.stringify(candidate)).length
  const fits = (candidate: JevState): boolean => serializedLength(candidate) <= maxChars
  if (fits(state)) return state
  const candidates = [...state.candidates]
  const inputCodePoints = Array.from(state.input)
  const minimumInput = inputCodePoints.length === 0 ? '' : inputCodePoints[0]!
  const minimal: JevState = {
    input: minimumInput,
    candidates,
    ...(state.reasoning === undefined ? {} : { reasoning: state.reasoning }),
    ...(state.cache === undefined ? {} : { cache: state.cache }),
    truncated: true,
  }
  if (!fits(minimal)) throw new RangeError('jevMaxStateChars is too small for valid routing evidence including the current input')
  let input = state.input
  let context = state.context === undefined ? undefined : [...state.context]
  const make = (): JevState => ({
    input,
    candidates,
    ...(context === undefined ? {} : { context }),
    ...(state.reasoning === undefined ? {} : { reasoning: state.reasoning }),
    ...(state.cache === undefined ? {} : { cache: state.cache }),
    truncated: true,
  })
  const shorten = (value: string, amount: number): string => Array.from(value).slice(0, amount).join('')
  while (!fits(make())) {
    const fields = [input, ...(context ?? [])]
    let longestIndex = context?.length ? 1 : 0
    let longestLength = -1
    for (const [index, value] of fields.entries()) {
      const length = Array.from(value).length
      const minimum = index === 0 ? Array.from(minimumInput).length : 0
      if (length > minimum && length > longestLength) {
        longestIndex = index
        longestLength = length
      }
    }
    if (longestLength < 0) break
    const minimum = longestIndex === 0 ? Array.from(minimumInput).length : 0
    const nextLength = Math.max(minimum, longestLength - Math.max(1, Math.ceil(longestLength / 10)))
    if (longestIndex === 0) input = shorten(input, nextLength)
    else if (context !== undefined) {
      const contextIndex = longestIndex - 1
      const shortened = shorten(context[contextIndex] ?? '', nextLength)
      if (shortened.length === 0) {
        context.splice(contextIndex, 1)
        if (context.length === 0) context = undefined
      } else {
        context[contextIndex] = shortened
      }
    }
  }
  if (!fits(make())) {
    // The candidate list and cache marker are the minimum useful evidence. The
    // explicit error prevents silently sending a state without its allow-list.
    throw new RangeError('jevMaxStateChars cannot contain valid routing evidence')
  }
  return make()
}
