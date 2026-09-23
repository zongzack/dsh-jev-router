import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { measureCompleteInput } from '../src/input-measurement.ts'

describe('complete input measurement', () => {
  it('adds the assembled prompt, tools, runtime context, and claimed batch to durable history pressure', () => {
    const measure = vi.fn(() => ({
      totalTokens: 40,
      baseline: { kind: 'usage' as const, tokens: 40, usage: { inputTokens: 30, outputTokens: 10 } },
    }))
    const meter = {
      measure,
      estimateMessage: vi.fn((message: { role: string; content: readonly unknown[] }) => {
        if (message.role === 'system') return 7
        return message.content.length === 0 ? 0 : 5
      }),
    }
    const session = {
      requestHeader: () => ({ config: { provider: 'ctapi', model: 'flash' } }),
      deriveMessages: () => [],
    }
    const claimed = [createUserMessage({ content: [{ type: 'text', text: 'question' }], source: { kind: 'user' } })]
    const assembly = {
      sections: [{ name: 'policy', text: 'follow policy' }],
      contexts: [{ name: 'workspace', text: 'cwd facts' }],
      tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }],
      variables: {},
    }

    expect(measureCompleteInput(meter as never, session as never, assembly as never, claimed, {
      provider: 'ctapi', model: 'flash',
    })).toEqual({ tokens: 47, estimated: true })
    expect(measure).toHaveBeenCalledWith(session, expect.objectContaining({
      config: { provider: 'ctapi', model: 'flash' },
      tools: assembly.tools,
    }))
  })
})
