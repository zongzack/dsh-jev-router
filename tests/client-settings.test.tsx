import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { JevRouterCard } from '../src/client.tsx'
import { defaultSettings } from '../src/config.ts'

describe('Jev router settings card', () => {
  it('shows common cache guards, folds hold turns under advanced settings, and saves them atomically', async () => {
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
    act(() => {
      limit.props.onChange({ currentTarget: { value: '65536' } })
      policy.props.onChange({ currentTarget: { value: 'keep' } })
      cache.props.onChange({ currentTarget: { checked: false } })
      hold.props.onChange({ currentTarget: { value: '0' } })
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
    ]))
  })
})
