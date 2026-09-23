import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { JevRouterCard, JevRouterModeControl } from '../src/client.tsx'
import { defaultSettings } from '../src/config.ts'

describe('Jev router settings card', () => {
  it('shows common guards, folds reasoning and Jev limits under advanced settings, and saves atomically', async () => {
    const value = defaultSettings({ provider: 'ctapi', model: 'deepseek-v4-pro-vip' })
    const mutate = vi.fn<(ops: unknown[]) => Promise<void>>(async () => {})
    const snapshot = { value, writable: true }
    const settings = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      mutate,
      set: vi.fn(async () => {}),
    }
    const props = {
      view: 'full',
      t: (key: string) => key,
      settings,
    } as unknown as Parameters<typeof JevRouterCard>[0]
    const view = create(<JevRouterCard {...props} />)
    const root = view.root

    expect(root.findByType('details').findByType('summary').children).toContain('advanced')
    const limit = root.findByProps({ name: 'switchContextLimitTokens' })
    const policy = root.findByProps({ name: 'overLimitPolicy' })
    const cache = root.findByProps({ name: 'cacheAware' })
    const hold = root.findByProps({ name: 'minHoldUserTurns' })
    const reasoning = root.findByProps({ name: 'routeReasoning' })
    const timeout = root.findByProps({ name: 'jevTimeoutMs' })
    const budget = root.findByProps({ name: 'jevMaxStateChars' })
    const showDecision = root.findByProps({ name: 'showDecision' })
    const recordMetrics = root.findByProps({ name: 'recordMetrics' })
    act(() => {
      limit.props.onChange({ currentTarget: { value: '65536' } })
      policy.props.onChange({ currentTarget: { value: 'keep' } })
      cache.props.onChange({ currentTarget: { checked: false } })
      hold.props.onChange({ currentTarget: { value: '0' } })
      reasoning.props.onChange({ currentTarget: { checked: false } })
      timeout.props.onChange({ currentTarget: { value: '3500' } })
      budget.props.onChange({ currentTarget: { value: '9000' } })
      showDecision.props.onChange({ currentTarget: { checked: false } })
      recordMetrics.props.onChange({ currentTarget: { checked: false } })
    })
    await act(async () => {
      root.findByType('form').props.onSubmit({ preventDefault() {} })
    })

    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([
      { op: 'set', path: ['switchContextLimitTokens'], value: 65_536 },
      { op: 'set', path: ['overLimitPolicy'], value: 'keep' },
      { op: 'set', path: ['minHoldUserTurns'], value: 0 },
      { op: 'set', path: ['cacheAware'], value: false },
      { op: 'set', path: ['routeReasoning'], value: false },
      { op: 'set', path: ['jevTimeoutMs'], value: 3_500 },
      { op: 'set', path: ['jevMaxStateChars'], value: 9_000 },
      { op: 'set', path: ['showDecision'], value: false },
      { op: 'set', path: ['recordMetrics'], value: false },
    ]))
  })
})

describe('Jev router session mode control', () => {
  it('toggles both Fixed and Auto through durable mode commands', async () => {
    const setMode = vi.fn(async () => true)
    const props = {
      t: (key: string) => key,
      useProjection: () => ({ mode: 'fixed' }),
      setMode,
    } as unknown as Parameters<typeof JevRouterModeControl>[0]
    const view = create(<JevRouterModeControl {...props} />)
    expect(view.root.findByType('button').children).toEqual(['modeFixed'])
    await act(async () => { view.root.findByType('button').props.onClick() })
    expect(setMode).toHaveBeenCalledWith('auto')

    const auto = create(<JevRouterModeControl {...{
      ...props,
      useProjection: () => ({ mode: 'auto' }),
    }} />)
    expect(auto.root.findByType('button').props.disabled).toBe(false)
    await act(async () => { auto.root.findByType('button').props.onClick() })
    expect(setMode).toHaveBeenLastCalledWith('fixed')
  })
})
