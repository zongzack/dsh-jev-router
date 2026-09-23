import { describe, expect, it } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  cacheEvidenceFor, encodeDecisionCommandArgs, JEV_DECISION_COMMAND, routerHistoryProjectionDefinition,
} from '../src/router-history.ts'

function event<T extends SessionEvent['type']>(
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
  seq: number,
  time = seq + 1,
): Extract<SessionEvent, { type: T }> {
  return { type, data, seq: SessionSeq(seq), time } as Extract<SessionEvent, { type: T }>
}

const assistant = (model: string) => createAssistantMessage({
  content: [{ type: 'text', text: 'done' }],
  source: { provider: 'ctapi', model },
})

describe('router history projection', () => {
  it('distinguishes a missing cache report from an explicit zero hit', () => {
    let state = routerHistoryProjectionDefinition.init({} as never, 0 as never)
    state = routerHistoryProjectionDefinition.apply(state, event('assistant/message', {
      turn: 1,
      step: 1,
      message: assistant('flash'),
      stream: [],
      usage: { inputTokens: 12, outputTokens: 3 },
    }, 0, 10))
    expect(state.cacheByRoute['ctapi/flash']).toEqual({ status: 'unknown', observedAt: 10 })

    state = routerHistoryProjectionDefinition.apply(state, event('assistant/message', {
      turn: 2,
      step: 1,
      message: assistant('flash'),
      stream: [],
      usage: { inputTokens: 9, outputTokens: 2, cacheReadTokens: 0 },
    }, 1, 20))
    expect(state.cacheByRoute['ctapi/flash']).toEqual({
      status: 'known',
      cacheReadTokens: 0,
      uncachedInputTokens: 9,
      observedAt: 20,
    })
  })

  it('invalidates old cache evidence when the actual route changes', () => {
    let state = routerHistoryProjectionDefinition.init({} as never, 0 as never)
    state = routerHistoryProjectionDefinition.apply(state, event('turn/start', { turn: 1 }, 0))
    state = routerHistoryProjectionDefinition.apply(state, event('request/header', {
      header: { config: { provider: 'ctapi', model: 'flash' } },
      reason: 'initial',
    }, 1))
    state = routerHistoryProjectionDefinition.apply(state, event('assistant/message', {
      turn: 1,
      step: 1,
      message: assistant('flash'),
      stream: [],
      usage: { inputTokens: 9, outputTokens: 2, cacheReadTokens: 4 },
    }, 2, 30))
    expect(cacheEvidenceFor(state, { provider: 'ctapi', model: 'flash' })).toMatchObject({ status: 'known' })

    state = routerHistoryProjectionDefinition.apply(state, event('request/header', {
      header: { config: { provider: 'ctapi', model: 'pro' } },
      reason: 'change',
    }, 3))
    expect(cacheEvidenceFor(state, { provider: 'ctapi', model: 'pro' })).toEqual({ status: 'unknown' })
    expect(cacheEvidenceFor(state, { provider: 'ctapi', model: 'flash' })).toEqual({ status: 'unknown' })
  })

  it('rebuilds the hold counter from actual route changes and completed turn ends', () => {
    let state = routerHistoryProjectionDefinition.init({} as never, 0 as never)
    const fold = (next: SessionEvent): void => { state = routerHistoryProjectionDefinition.apply(state, next) }
    fold(event('turn/start', { turn: 1 }, 0))
    fold(event('request/header', {
      header: { config: { provider: 'ctapi', model: 'flash' } }, reason: 'initial',
    }, 1))
    fold(event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2))
    expect(state.completedUserTurnsSinceSwitch).toBeUndefined()

    fold(event('turn/start', { turn: 2 }, 3))
    fold(event('request/header', {
      header: { config: { provider: 'ctapi', model: 'pro' } }, reason: 'change',
    }, 4))
    fold(event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 5))
    expect(state.completedUserTurnsSinceSwitch).toBe(1)

    fold(event('turn/start', { turn: 3 }, 6))
    fold(event('turn/end', { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 7))
    expect(state.completedUserTurnsSinceSwitch).toBe(1)

    fold(event('turn/start', { turn: 4 }, 8))
    fold(event('turn/end', { turn: 4, reason: { kind: 'completed' } }, 9))
    expect(state.completedUserTurnsSinceSwitch).toBe(2)
  })

  it('replays mode and Jev version into the client-visible decision', () => {
    let state = routerHistoryProjectionDefinition.init({} as never, 0 as never)
    state = routerHistoryProjectionDefinition.apply(state, event('command/run', {
      commandId: 'auto' as never, name: 'jev-auto', source: { kind: 'user' },
    }, 0))
    state = routerHistoryProjectionDefinition.apply(state, event('command/done', {
      commandId: 'auto' as never, kind: 'success',
    }, 1))
    state = routerHistoryProjectionDefinition.apply(state, event('turn/start', { turn: 1 }, 2))
    const decision = {
      turn: 1,
      suggested: { provider: 'ctapi', model: 'pro' },
      actual: { provider: 'ctapi', model: 'pro' },
      inputTokens: 12,
      estimated: true,
      reason: 'suggestion_applied',
      jevVersion: 'jev-2026-09',
    }
    state = routerHistoryProjectionDefinition.apply(state, event('command/run', {
      commandId: 'decision' as never,
      name: JEV_DECISION_COMMAND,
      args: ` ${encodeDecisionCommandArgs(decision)}`,
      source: { kind: 'user' },
    }, 3))
    state = routerHistoryProjectionDefinition.apply(state, event('command/done', {
      commandId: 'decision' as never, kind: 'success',
    }, 4))
    state = routerHistoryProjectionDefinition.apply(state, event('request/header', {
      header: { config: { provider: 'ctapi', model: 'pro' } }, reason: 'initial',
    }, 5))
    expect(routerHistoryProjectionDefinition.wire.view(state)).toMatchObject({
      mode: 'auto', decision: { jevVersion: 'jev-2026-09' },
    })

    state = routerHistoryProjectionDefinition.apply(state, event('command/run', {
      commandId: 'fixed' as never, name: 'jev-fixed', source: { kind: 'user' },
    }, 6))
    expect(routerHistoryProjectionDefinition.wire.view(state)).toMatchObject({ mode: 'auto' })
    state = routerHistoryProjectionDefinition.apply(state, event('command/done', {
      commandId: 'fixed' as never, kind: 'success',
    }, 7))
    expect(routerHistoryProjectionDefinition.wire.view(state)).toMatchObject({ mode: 'fixed' })
  })

  it('attaches reported execution usage to the matching persisted decision without inventing cache fields', () => {
    let state = routerHistoryProjectionDefinition.init({ id: 'metrics' } as never, 0 as never)
    state = routerHistoryProjectionDefinition.apply(state, event('turn/start', { turn: 1 }, 0))
    const decision = {
      policyVersion: 'jev-router/v1',
      turn: 1,
      suggested: { provider: 'ctapi', model: 'flash' },
      actual: { provider: 'ctapi', model: 'flash' },
      inputTokens: 12,
      estimated: true,
      reason: 'suggestion_applied',
      classificationMs: 25,
      classificationUsage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null },
    }
    state = routerHistoryProjectionDefinition.apply(state, event('command/run', {
      commandId: 'metrics-decision' as never,
      name: JEV_DECISION_COMMAND,
      args: ` ${encodeDecisionCommandArgs(decision)}`,
      source: { kind: 'user' },
    }, 1))
    state = routerHistoryProjectionDefinition.apply(state, event('command/done', {
      commandId: 'metrics-decision' as never, kind: 'success',
    }, 2))
    state = routerHistoryProjectionDefinition.apply(state, event('request/header', {
      header: { config: { provider: 'ctapi', model: 'flash' } }, reason: 'initial',
    }, 3))
    state = routerHistoryProjectionDefinition.apply(state, event('assistant/message', {
      turn: 1,
      step: 1,
      message: assistant('flash'),
      stream: [],
      usage: { inputTokens: 9, outputTokens: 2, cacheReadTokens: 0 },
    }, 4))

    expect(routerHistoryProjectionDefinition.wire.view(state).decision).toMatchObject({
      policyVersion: 'jev-router/v1',
      classificationMs: 25,
      classificationUsage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: null },
      usage: {
        inputTokens: 9,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
    })
  })

  it('ignores failed mode commands and replays decisions without process-local state', () => {
    let state = routerHistoryProjectionDefinition.init({ id: 'pure-replay' } as never, 0 as never)
    const initialView = routerHistoryProjectionDefinition.wire.view(state)
    state = routerHistoryProjectionDefinition.apply(state, event('command/run', {
      commandId: 'failed-auto' as never, name: 'jev-auto', source: { kind: 'user' },
    }, 0))
    expect(routerHistoryProjectionDefinition.wire.view(state)).toBe(initialView)
    state = routerHistoryProjectionDefinition.apply(state, event('command/done', {
      commandId: 'failed-auto' as never, kind: 'error', text: 'denied',
    }, 1))
    expect(routerHistoryProjectionDefinition.wire.view(state)).toBe(initialView)
  })
})
