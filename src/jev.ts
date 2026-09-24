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
  classificationUsage?: JevUsage
}

/** Token/cache accounting reported by TypeSafe for the classification call. */
export interface JevUsage {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens?: number | null | undefined
  cacheReadTokens?: number | null | undefined
  cacheWriteTokens?: number | null | undefined
}

/** Optional transport overrides used by tests and deployments. */
export interface JevClientOptions {
  endpoint?: string
  fetch?: typeof globalThis.fetch
}

/** Current TypeSafe System One HTTP endpoint. */
export const DEFAULT_JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

interface JevRouteChoice {
  key: string
  provider: string
  model: string
  reasoningEffort?: string
  criterion: {
    provider: string
    model: string
    description: string
    tier: CandidateModel['tier']
    reasoningEffort: string
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function routeChoices(state: JevState): JevRouteChoice[] {
  const reasoningByRoute = new Map(
    state.reasoning?.options.map(option => [`${option.provider}/${option.model}`, option.efforts] as const) ?? [],
  )
  const choices: JevRouteChoice[] = []
  for (const candidate of state.candidates) {
    const efforts = state.reasoning?.enabled === true
      ? reasoningByRoute.get(`${candidate.provider}/${candidate.model}`) ?? []
      : []
    const routeEfforts: readonly (string | undefined)[] = efforts.length === 0 ? [undefined] : efforts
    for (const reasoningEffort of routeEfforts) {
      choices.push({
        key: `route_${String(choices.length)}`,
        provider: candidate.provider,
        model: candidate.model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        criterion: {
          provider: candidate.provider,
          model: candidate.model,
          description: candidate.description,
          tier: candidate.tier,
          reasoningEffort: reasoningEffort ?? 'adapter-default',
        },
      })
    }
  }
  return choices
}

function readClassificationUsage(value: unknown, root?: Record<string, unknown>): JevUsage | undefined {
  const usageSource = isRecord(value) && isRecord(value.usage)
    ? value.usage
    : isRecord(root?.usage) ? root.usage : undefined
  if (usageSource === undefined) return undefined
  const readCount = (field: string, wireField: string): number | null | undefined => {
    const count = usageSource[wireField] ?? usageSource[field]
    if (count === undefined) return undefined
    if (count === null) return null
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Jev returned an invalid ${field} usage value`)
    }
    return count
  }
  const inputTokens = readCount('inputTokens', 'input_tokens')
  const outputTokens = readCount('outputTokens', 'output_tokens')
  const totalTokens = readCount('totalTokens', 'total_tokens')
  const cacheReadTokens = readCount('cacheReadTokens', 'cache_read_tokens')
  const cacheWriteTokens = readCount('cacheWriteTokens', 'cache_write_tokens')
  return {
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    cacheReadTokens: cacheReadTokens ?? null,
    cacheWriteTokens: cacheWriteTokens ?? null,
  }
}

function readDecision(value: unknown, choices: readonly JevRouteChoice[]): JevDecision {
  if (isRecord(value) && Object.hasOwn(value, 'answers')) {
    if (!isRecord(value.answers) || !isRecord(value.answers.model)) {
      throw new Error('Jev returned no valid model Choice answer')
    }
    const answer = value.answers.model
    if (answer.type !== 'choice' || typeof answer.choice !== 'string') {
      throw new Error('Jev returned no valid model Choice answer')
    }
    const route = choices.find(choice => choice.key === answer.choice)
    if (route === undefined) throw new Error(`Jev returned unknown model choice "${answer.choice}"`)
    if (answer.confidence !== undefined
      && (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)
        || answer.confidence < 0 || answer.confidence > 1)) {
      throw new Error('Jev returned an invalid confidence')
    }
    const classificationUsage = readClassificationUsage(value)
    return {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
      ...(typeof value.model === 'string' ? { jevVersion: value.model } : {}),
      ...(classificationUsage === undefined ? {} : { classificationUsage }),
    }
  }

  // Preserve compatibility with endpoint overrides that still return the
  // original plugin response shape while the public TypeSafe API uses answers.
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
  const classificationUsage = readClassificationUsage(value, root)
  return {
    provider: root.provider,
    model: root.model,
    ...(root.reasoningEffort === undefined ? {} : { reasoningEffort: root.reasoningEffort }),
    ...(root.confidence === undefined ? {} : { confidence: root.confidence }),
    ...(typeof root.reason === 'string' ? { reason: root.reason } : {}),
    ...(typeof root.jevVersion === 'string' ? { jevVersion: root.jevVersion } : {}),
    ...(classificationUsage === undefined ? {} : { classificationUsage }),
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
    const choices = routeChoices(state)
    const response = await (options.fetch ?? globalThis.fetch)(options.endpoint ?? DEFAULT_JEV_ENDPOINT, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'jev-latest',
        state,
        questions: {
          model: {
            type: 'choice',
            instructions: 'Select the best execution route and reasoning effort for the current user request. Prefer an economy route for simple, routine, or short work, and a capability route for complex reasoning, tool use, or quality-critical work. Choose the least expensive reasoning effort sufficient for the task.',
            criteria: Object.fromEntries(choices.map(choice => [choice.key, choice.criterion])),
          },
        },
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Jev request failed with HTTP ${String(response.status)}`)
    return readDecision(await response.json(), choices)
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
