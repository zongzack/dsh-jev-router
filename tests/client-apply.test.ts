import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, JevRouterModeControl } from '../src/client.tsx'

const Empty = () => null

async function loadPublishedSlotRegistry(): Promise<new (ctx: Context) => unknown> {
  const [cordis, slotCore, react, jsxRuntime] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-client-ui-slots'),
    import('react'),
    import('react/jsx-runtime'),
  ])
  const dependencies: Record<string, unknown> = {
    '@deepseek-ai/cordis': cordis,
    '@deepseek-ai/dsh-client-ui-slots': slotCore,
    react,
    'react-dom': {},
    'react-dom/client': {},
    'react/jsx-runtime': jsxRuntime,
  }
  let published: { SlotRegistry?: new (ctx: Context) => unknown } | undefined
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __ModuleLoader__: {
        load: (definition: {
          factory: (require: (specifier: string) => unknown) => { SlotRegistry?: new (ctx: Context) => unknown }
        }) => {
          published = definition.factory(specifier => dependencies[specifier])
        },
      },
    },
  })
  try {
    await import('@deepseek-ai/dsh-client-ui-renderer/client')
  } finally {
    Reflect.deleteProperty(globalThis, 'window')
  }
  if (published?.SlotRegistry === undefined) throw new Error('published SlotRegistry did not load')
  return published.SlotRegistry
}

function declareSurfaces(ctx: Context): () => void {
  return ctx.slots.register({
    name: 'root',
    children: {
      'plugins.item': { kind: 'list', scope: 'root' },
      'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    },
  } as never, Empty)
}

describe('Jev router Client composition', () => {
  it('registers a live mode slot, targets its session, and unloads without duplicates', async () => {
    const SlotRegistry = await loadPublishedSlotRegistry()
    const ctx = new Context()
    await (ctx.plugin as unknown as (plugin: unknown) => { await(): Promise<void> })(SlotRegistry).await()
    const removeSurfaces = declareSurfaces(ctx)
    const command = vi.fn(async (_input: string) => ({
      ok: true as const,
      value: { matched: true, result: { kind: 'success' as const, text: 'ok' } },
    }))
    const session = { command }
    const agentContext = new Context()
    const sessionId = SessionId('client-mode')
    ctx.provide('locale', {
      register: () => () => {},
      bind: () => (key: string) => key,
    } as never)
    ctx.provide('settingsScope', {
      bind: () => ({
        getSnapshot: () => ({ value: undefined, writable: false }),
        subscribe: () => () => {},
      }),
    } as never)
    ctx.provide('remote', {
      session: {
        modelCatalog: async () => ({
          ok: true,
          value: { default: { provider: 'fixture', model: 'model' }, routableProviders: ['fixture'], groups: [], failures: [] },
        }),
      },
    } as never)
    ctx.provide('remote.session', {} as never)
    ctx.provide('sessions', {
      scope: (id: SessionId) => id === sessionId ? agentContext : undefined,
      sessionOf: (candidate: Context) => candidate === agentContext ? session : undefined,
    } as never)

    const first = ctx.plugin({ inject: [...inject], apply })
    await first.await()
    const entries = ctx.slots.entries('conversation.input.left')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.component).toBe(JevRouterModeControl)
    expect(entries[0]?.options).toMatchObject({ id: 'jev-router-mode', order: 35 })
    expect(ctx.slots.entries('conversation.session.header.actions')).toHaveLength(0)
    const injected = (entries[0]?.inject as unknown as (id: SessionId) => {
      setMode: (mode: 'auto' | 'fixed') => Promise<boolean>
    })(sessionId)
    await expect(injected.setMode('auto')).resolves.toBe(true)
    await expect(injected.setMode('fixed')).resolves.toBe(true)
    expect(command.mock.calls.map(([input]) => input)).toEqual(['/jev-auto', '/jev-fixed'])

    await first.dispose()
    expect(ctx.slots.entries('conversation.input.left')).toHaveLength(0)

    const reloaded = ctx.plugin({ inject: [...inject], apply })
    await reloaded.await()
    expect(ctx.slots.entries('conversation.input.left')).toHaveLength(1)
    await reloaded.dispose()
    removeSurfaces()
    await ctx.fiber.dispose()
  })
})
