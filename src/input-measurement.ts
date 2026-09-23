/** Complete next-request pressure measurement built from dsh's replay-aware token meter. */
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { createSystemMessage, createUserMessage, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { renderContextSnapshot, renderPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { InputMeasurement } from './route-guards.ts'

const SYSTEM_PROMPT_PLUGIN = '@deepseek-ai/dsh-system-prompt'

function singleText(message: Message): string | undefined {
  const [block] = message.content
  return message.content.length === 1 && block?.type === 'text' ? block.text : undefined
}

function hasSystemPrompt(messages: readonly Message[], text: string): boolean {
  return messages.some(message => message.role === 'system' && singleText(message) === text)
}

function hasRuntimeContext(messages: readonly Message[], text: string): boolean {
  return messages.some(message => message.role === 'user'
    && message.source.kind === 'plugin'
    && message.source.plugin === SYSTEM_PROMPT_PLUGIN
    && singleText(message) === text)
}

/** Estimate the complete request that will follow routing without changing its model-visible history. */
/**
 * @param meter - dsh replay-aware token meter.
 * @param session - Session whose durable surface supplies history and tool results.
 * @param assembly - current system prompt, runtime context, and tool schemas.
 * @param claimed - complete user batch claimed for this turn.
 * @param route - current route used for route-owned request pricing.
 * @returns token count with an estimate marker, or unknown when replay cannot be measured.
 */
export function measureCompleteInput(
  meter: TokenMeter,
  session: Session,
  assembly: PromptAssembly,
  claimed: readonly UserMessage[],
  route: ModelSelection,
): InputMeasurement {
  try {
    const previousHeader = session.requestHeader()
    const { tools: _previousTools, ...headerWithoutTools } = previousHeader ?? { config: route }
    const requestHeader = {
      ...headerWithoutTools,
      config: { ...headerWithoutTools.config, provider: route.provider, model: route.model },
      ...(assembly.tools.length === 0 ? {} : { tools: assembly.tools }),
    }
    const measurement = meter.measure(session, requestHeader)
    const messages = session.deriveMessages()
    let addedTokens = 0

    const prompt = renderPrompt(assembly)
    if (!hasSystemPrompt(messages, prompt)) {
      addedTokens += meter.estimateMessage(createSystemMessage(prompt, SYSTEM_PROMPT_PLUGIN))
    }
    const runtimeContext = renderContextSnapshot(assembly)
    if (runtimeContext.length > 0 && !hasRuntimeContext(messages, runtimeContext)) {
      addedTokens += meter.estimateMessage(createUserMessage({
        content: [{ type: 'text', text: runtimeContext }],
        source: { kind: 'plugin', plugin: SYSTEM_PROMPT_PLUGIN },
      }))
    }
    for (const message of claimed) addedTokens += meter.estimateMessage(message)

    const baselineInputTokens = measurement.baseline.kind === 'usage'
      ? measurement.baseline.usage.inputTokens
        + (measurement.baseline.usage.cacheReadTokens ?? 0)
        + (measurement.baseline.usage.cacheWriteTokens ?? 0)
      : measurement.baseline.tokens
    return {
      tokens: Math.max(0, baselineInputTokens + (measurement.surfaceDeltaTokens ?? 0) + addedTokens),
      estimated: measurement.baseline.kind !== 'usage' || addedTokens > 0,
    }
  } catch (_error) {
    // A malformed or temporarily unavailable replay cannot support a cost-motivated downgrade.
    return { estimated: true }
  }
}
