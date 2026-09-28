import { describe, expect, it } from 'vitest'
import { resolveGuardedRoute, shouldSyncModelSelection } from '../src/route-guards.ts'
import { defaultSettings } from '../src/config.ts'

const FLASH = { provider: 'ctapi', model: 'deepseek-v4-flash-vip' } as const
const PRO = { provider: 'ctapi', model: 'deepseek-v4-pro-vip' } as const

describe('route switching guards', () => {
  it('syncs a stale visible selection without repeating an already aligned route', () => {
    expect(shouldSyncModelSelection(FLASH, FLASH, PRO)).toBe(true)
    expect(shouldSyncModelSelection(PRO, FLASH, PRO)).toBe(true)
    expect(shouldSyncModelSelection(FLASH, FLASH, FLASH)).toBe(false)
    expect(shouldSyncModelSelection(FLASH, FLASH, undefined)).toBe(false)
  })

  it('allows an ordinary downgrade at the limit and blocks it above the limit', () => {
    const settings = {
      ...defaultSettings(PRO),
      switchContextLimitTokens: 100,
      overLimitPolicy: 'upgrade_only' as const,
      minHoldUserTurns: 0,
    }

    expect(resolveGuardedRoute({
      current: PRO,
      suggested: FLASH,
      candidates: settings.candidateModels,
      input: { tokens: 100, estimated: true },
      completedUserTurnsSinceSwitch: undefined,
      settings,
    })).toMatchObject({ actual: FLASH, reason: 'suggestion_applied' })

    expect(resolveGuardedRoute({
      current: PRO,
      suggested: FLASH,
      candidates: settings.candidateModels,
      input: { tokens: 101, estimated: true },
      completedUserTurnsSinceSwitch: undefined,
      settings,
    })).toMatchObject({ actual: PRO, reason: 'context_upgrade_only' })
  })

  it('keeps the current model above the limit even when Jev asks for an upgrade', () => {
    const settings = {
      ...defaultSettings(FLASH),
      switchContextLimitTokens: 100,
      overLimitPolicy: 'keep' as const,
      minHoldUserTurns: 0,
    }
    expect(resolveGuardedRoute({
      current: FLASH,
      suggested: PRO,
      candidates: settings.candidateModels,
      input: { tokens: 101, estimated: true },
      completedUserTurnsSinceSwitch: undefined,
      settings,
    })).toMatchObject({ actual: FLASH, reason: 'context_keep' })
  })

  it('never downgrades with unknown input size but still permits a necessary upgrade', () => {
    const settings = { ...defaultSettings(PRO), minHoldUserTurns: 0 }
    const route = (current: typeof FLASH | typeof PRO, suggested: typeof FLASH | typeof PRO) => resolveGuardedRoute({
      current,
      suggested,
      candidates: settings.candidateModels,
      input: { estimated: true },
      completedUserTurnsSinceSwitch: undefined,
      settings,
    })
    expect(route(PRO, FLASH)).toMatchObject({ actual: PRO, reason: 'context_unknown' })
    expect(route(FLASH, PRO)).toMatchObject({ actual: PRO, reason: 'suggestion_applied' })
  })

  it('counts completed user turns after a switch and never holds back an upgrade', () => {
    const settings = { ...defaultSettings(PRO), switchContextLimitTokens: null }
    const route = (current: typeof FLASH | typeof PRO, suggested: typeof FLASH | typeof PRO, completed: number) => resolveGuardedRoute({
      current,
      suggested,
      candidates: settings.candidateModels,
      input: { tokens: 10, estimated: true },
      completedUserTurnsSinceSwitch: completed,
      settings,
    })
    expect(route(PRO, FLASH, 0)).toMatchObject({ actual: PRO, reason: 'minimum_hold' })
    expect(route(PRO, FLASH, 1)).toMatchObject({ actual: PRO, reason: 'minimum_hold' })
    expect(route(PRO, FLASH, 2)).toMatchObject({ actual: FLASH, reason: 'suggestion_applied' })
    expect(route(FLASH, PRO, 0)).toMatchObject({ actual: PRO, reason: 'suggestion_applied' })
  })

  it('keeps an unranked current route when an active rule cannot prove an upgrade', () => {
    const current = { provider: 'other', model: 'custom' }
    const settings = {
      ...defaultSettings(current),
      switchContextLimitTokens: 10,
      minHoldUserTurns: 0,
    }
    expect(resolveGuardedRoute({
      current,
      suggested: PRO,
      candidates: settings.candidateModels,
      input: { tokens: 11, estimated: true },
      completedUserTurnsSinceSwitch: undefined,
      settings,
    })).toMatchObject({ actual: current, reason: 'tier_incomparable' })
  })
})
