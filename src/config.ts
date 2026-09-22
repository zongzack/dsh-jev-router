import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'

/** A user-controlled candidate route and its explicit, non-inferred tier. */
export interface CandidateModel {
  provider: string
  model: string
  description: string
  tier: 'economy' | 'capability'
}

/** Persisted settings owned by the `jev-router` namespace. */
export interface JevRouterSettings {
  enabled: boolean
  candidateModels: CandidateModel[]
  defaultModel: ModelSelection
  routeReasoning: boolean
  switchContextLimitTokens: number | null
  overLimitPolicy: 'keep' | 'upgrade_only'
  minHoldUserTurns: number
  cacheAware: boolean
  jevTimeoutMs: number
  jevMaxStateChars: number
  showDecision: boolean
  recordMetrics: boolean
  apiKeyEnv: string
}

export const DEFAULT_CANDIDATES: readonly CandidateModel[] = Object.freeze([
  {
    provider: 'ctapi',
    model: 'deepseek-v4-flash-vip',
    description: '经济档：适合常规问答、转换和短任务。',
    tier: 'economy',
  },
  {
    provider: 'ctapi',
    model: 'deepseek-v4-pro-vip',
    description: '能力档：适合复杂推理、工具和长任务。',
    tier: 'capability',
  },
])

export const DEFAULT_API_KEY_ENV = 'TYPESAFE_API_KEY'

/** Build the first-run settings from the deployment's current model. */
/**
 * @param defaultModel - deployment model used for first-run fallback.
 * @returns disabled first-run settings.
 */
export function defaultSettings(defaultModel: ModelSelection): JevRouterSettings {
  return {
    enabled: false,
    candidateModels: DEFAULT_CANDIDATES.map(candidate => ({ ...candidate })),
    defaultModel: { ...defaultModel },
    routeReasoning: true,
    switchContextLimitTokens: 32_768,
    overLimitPolicy: 'upgrade_only',
    minHoldUserTurns: 2,
    cacheAware: true,
    jevTimeoutMs: 2_000,
    jevMaxStateChars: 6_000,
    showDecision: true,
    recordMetrics: true,
    apiKeyEnv: DEFAULT_API_KEY_ENV,
  }
}

const candidateSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  description: z.string().min(1),
  tier: z.union([z.const('economy'), z.const('capability')]),
})

const modelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
})

/** Settings schema exposed to dsh's settings service and client renderer. */
export const JevRouterSettingsSchema: z<JevRouterSettings> = z.object({
  enabled: z.boolean().default(false),
  candidateModels: z.array(candidateSchema).min(1),
  defaultModel: modelSelectionSchema,
  routeReasoning: z.boolean().default(true),
  switchContextLimitTokens: z.union([z.number().step(1).min(1), z.const(null)]).default(32_768),
  overLimitPolicy: z.union([z.const('keep'), z.const('upgrade_only')]).default('upgrade_only'),
  minHoldUserTurns: z.number().step(1).min(0).default(2),
  cacheAware: z.boolean().default(true),
  jevTimeoutMs: z.number().step(1).min(1).default(2_000),
  jevMaxStateChars: z.number().step(1).min(1).default(6_000),
  showDecision: z.boolean().default(true),
  recordMetrics: z.boolean().default(true),
  apiKeyEnv: z.string().min(1).default(DEFAULT_API_KEY_ENV),
})

/** Validate cross-field rules before settings persistence. */
/**
 * @param value - candidate settings to validate.
 * @returns nothing when the settings are valid.
 * @throws when a cross-field invariant is violated.
 */
export function validateSettings(value: JevRouterSettings): void {
  const seen = new Set<string>()
  for (const candidate of value.candidateModels) {
    const key = `${candidate.provider}/${candidate.model}`
    if (seen.has(key)) throw new TypeError(`candidateModels contains duplicate route "${key}"`)
    seen.add(key)
  }
  try {
    credentialRef(value.apiKeyEnv)
  } catch (error) {
    throw new TypeError(`apiKeyEnv must be a credential reference: ${String(error)}`, { cause: error })
  }
  if (value.switchContextLimitTokens !== null && value.switchContextLimitTokens <= 0) {
    throw new TypeError('switchContextLimitTokens must be positive or null')
  }
}
