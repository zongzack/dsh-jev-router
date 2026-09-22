import type { CandidateModel, JevRouterSettings } from './config.ts'

/** Structured state sent to TypeSafe; it intentionally contains no credentials. */
export interface JevState {
  input: string
  context?: readonly string[]
  candidates: readonly CandidateModel[]
  cache?: Record<string, unknown>
}

/** Validated Jev routing response. */
export interface JevDecision {
  provider: string
  model: string
  reasoningEffort?: string
  reason?: string
  jevVersion?: string
}

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
  return {
    provider: root.provider,
    model: root.model,
    ...(root.reasoningEffort === undefined ? {} : { reasoningEffort: root.reasoningEffort }),
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
  const fits = (candidate: JevState): boolean => JSON.stringify(candidate).length <= maxChars
  if (fits(state)) return state
  const candidates = [...state.candidates]
  const minimal: JevState = { input: '', candidates }
  if (!fits(minimal)) throw new RangeError('jevMaxStateChars is too small for the configured candidates')
  let input = state.input
  let context = state.context === undefined ? undefined : [...state.context]
  const make = (): JevState => ({
    input,
    candidates,
    ...(context === undefined ? {} : { context }),
    truncated: true,
  } as JevState)
  while (!fits(make())) {
    if (input.length > 0) input = input.slice(0, Math.max(0, input.length - Math.max(1, Math.ceil(input.length / 10))))
    else if (context !== undefined && context.length > 0) {
      context = context.slice(0, -1)
    } else break
  }
  if (!fits(make())) throw new RangeError('jevMaxStateChars cannot contain valid routing evidence')
  return make()
}
