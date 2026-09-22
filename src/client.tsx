/** Browser half: a small configuration card over the Host-owned settings scope. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { useSyncExternalStore, useState } from 'react'
import type { JevRouterSettings } from './config.ts'

export const inject = ['locale', 'settingsScope', 'slots']
const NS = 'jev-router'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'jev-router': 'title' | 'summary' | 'enabled' | 'apiKeyEnv' | 'save' | 'saved' | 'unavailable'
  }
}

const en = {
  title: 'Jev automatic routing',
  summary: 'Choose a model per user turn with TypeSafe Jev.',
  enabled: 'Enable automatic routing',
  apiKeyEnv: 'TypeSafe credential reference',
  save: 'Save',
  saved: 'Saved',
  unavailable: 'Settings are unavailable in this profile.',
} as const

const zh = {
  title: 'Jev 自动路由',
  summary: '使用 TypeSafe Jev 为每个用户回合选择模型。',
  enabled: '开启自动路由',
  apiKeyEnv: 'TypeSafe 凭据引用',
  save: '保存',
  saved: '已保存',
  unavailable: '此 profile 暂无设置服务。',
} as const

interface JevRouterFace {
  settings: SettingsScope<JevRouterSettings>
}

type CardProps = PropsRuntime<'plugins.item'> & PropsLocale<'jev-router'> & InjectFace<JevRouterFace>

/** Settings card with no secret readback: only the credential reference is edited. */
export function JevRouterCard(props: CardProps) {
  const state = useSyncExternalStore(
    listener => props.settings.subscribe(listener),
    () => props.settings.getSnapshot(),
  )
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [message, setMessage] = useState('')
  if (props.view === 'summary') return props.t('summary')
  const value = state.value
  if (value === undefined) return props.t('unavailable')
  const apiKeyEnv = draft ?? value.apiKeyEnv
  return (
    <form onSubmit={event => {
      event.preventDefault()
      void props.settings.mutate([
        { op: 'set', path: ['enabled'], value: value.enabled },
        { op: 'set', path: ['apiKeyEnv'], value: apiKeyEnv },
      ]).then(() => setMessage(props.t('saved')), error => setMessage(String(error)))
    }}>
      <label>
        <input
          type="checkbox"
          checked={value.enabled}
          disabled={!state.writable}
          onChange={event => {
            void props.settings.set('enabled', event.currentTarget.checked)
          }}
        />
        {props.t('enabled')}
      </label>
      <label>
        {props.t('apiKeyEnv')}
        <input
          value={apiKeyEnv}
          disabled={!state.writable}
          onChange={event => setDraft(event.currentTarget.value)}
        />
      </label>
      <button type="submit" disabled={!state.writable}>{props.t('save')}</button>
      {message ? <span role="status">{message}</span> : null}
    </form>
  )
}

/** Client plugin entry; the host settings scope remains the source of truth. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'jev-router: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.inject(['slots', 'settingsScope'], scope => {
    const settings = scope.settingsScope.bind<JevRouterSettings>({ namespace: NS })
    scope.slots.inject('plugins.item', () => scope.slots.register({
      name: 'plugins.item',
      id: NS,
      order: 45,
      label: () => t('title'),
      locale: NS,
      inject: () => ({ settings }),
    }, JevRouterCard))
  })
}

export default apply
