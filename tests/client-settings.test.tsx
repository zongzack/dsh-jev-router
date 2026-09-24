import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { JevRouterCard, JevRouterModeControl } from '../src/client.tsx'
import { defaultSettings } from '../src/config.ts'

const catalog = {
  default: { provider: 'ctapi', model: 'deepseek-v4-pro-vip' },
  routableProviders: ['ctapi'],
  groups: [{
    id: 'ctapi',
    name: 'CTAPI',
    models: [
      { id: 'deepseek-v4-flash-vip', name: 'DeepSeek Flash', description: 'Fast model' },
      { id: 'deepseek-v4-pro-vip', name: 'DeepSeek Pro', description: 'Powerful model' },
    ],
  }],
  failures: [],
} as const

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
      loadModelCatalog: vi.fn(async () => catalog),
    } as unknown as Parameters<typeof JevRouterCard>[0]
    let view!: ReturnType<typeof create>
    await act(async () => { view = create(<JevRouterCard {...props} />) })
    const root = view.root

    expect(root.findAllByType('textarea')).toHaveLength(0)
    expect(root.findAllByProps({ name: 'candidateModel' })).toHaveLength(2)
    expect(root.findByProps({ id: 'jev-default-model' }).props.value).toBe('ctapi/deepseek-v4-pro-vip')

    const apiKey = root.findByProps({ id: 'jev-api-key' })
    expect(apiKey.props.type).toBe('password')
    act(() => {
      apiKey.props.onChange({ currentTarget: { value: 'jev-secret' } })
    })

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
      { op: 'set', path: ['apiKey'], value: 'jev-secret' },
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

  it('loads candidates from the configured model catalog and blocks stale routes', async () => {
    const value = defaultSettings({ provider: 'ctapi', model: 'deepseek-v4-pro-vip' })
    const mutate = vi.fn(async () => {})
    const props = {
      view: 'full',
      t: (key: string) => key,
      settings: {
        getSnapshot: () => ({ value, writable: true }),
        subscribe: () => () => {},
        mutate,
        set: vi.fn(async () => {}),
      },
      loadModelCatalog: vi.fn(async () => ({
        ...catalog,
        groups: [{ ...catalog.groups[0], models: [catalog.groups[0].models[1]] }],
      })),
    } as unknown as Parameters<typeof JevRouterCard>[0]
    let view!: ReturnType<typeof create>
    await act(async () => { view = create(<JevRouterCard {...props} />) })

    const stale = view.root.findByProps({ id: 'jev-candidate-model-0' })
    expect(stale.findAllByType('option')[0]?.children.join('')).toContain('modelMissing')
    await act(async () => { view.root.findByType('form').props.onSubmit({ preventDefault() {} }) })
    expect(mutate).not.toHaveBeenCalled()
    expect(view.root.findByProps({ role: 'status' }).children.join('')).toContain('modelMissing')
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
    expect(view.root.findByType('button').props.style).toMatchObject({
      height: 28,
      borderRadius: 24,
      fontSize: 13,
      fontWeight: 500,
    })
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
