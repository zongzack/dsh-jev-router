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

/** Client services required by the settings card. */
export const inject = ['locale', 'settingsScope', 'slots']
const NS = 'jev-router'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'jev-router': 'title' | 'summary' | 'enabled' | 'apiKeyEnv' | 'candidates' | 'defaultModel' | 'dataNotice' | 'save' | 'saved' | 'unavailable'
  }
}

const en = {
  title: 'Jev automatic routing',
  summary: 'Choose a model per user turn with TypeSafe Jev.',
  enabled: 'Enable automatic routing',
  apiKeyEnv: 'TypeSafe credential reference',
  candidates: 'Candidate models (provider/model JSON)',
  defaultModel: 'Default fallback (provider/model JSON)',
  dataNotice: 'Limited routing material is sent to TypeSafe for classification; conversation history remains in dsh.',
  save: 'Save',
  saved: 'Saved',
  unavailable: 'Settings are unavailable in this profile.',
} as const

const zh = {
  title: 'Jev 自动路由',
  summary: '使用 TypeSafe Jev 为每个用户回合选择模型。',
  enabled: '开启自动路由',
  apiKeyEnv: 'TypeSafe 凭据引用',
  candidates: '候选模型（provider/model JSON）',
  defaultModel: '默认回退模型（provider/model JSON）',
  dataNotice: '有限的分类材料会发送到 TypeSafe；完整会话历史仍由 dsh 执行模型接收。',
  save: '保存',
  saved: '已保存',
  unavailable: '此 profile 暂无设置服务。',
} as const

interface JevRouterFace {
  settings: SettingsScope<JevRouterSettings>
}

type CardProps = PropsRuntime<'plugins.item'> & PropsLocale<'jev-router'> & InjectFace<JevRouterFace>

/** Settings card with no secret readback: only the credential reference is edited. */
/**
 * @param props - slot, locale, and settings scope supplied by the client host.
 * @returns the rendered settings card or a slot summary.
 */
export function JevRouterCard(props: CardProps) {
  const state = useSyncExternalStore(
    listener => props.settings.subscribe(listener),
    () => props.settings.getSnapshot(),
  )
  const [draft, setDraft] = useState<Partial<JevRouterSettings>>({})
  const [candidateDraft, setCandidateDraft] = useState<string | undefined>(undefined)
  const [defaultDraft, setDefaultDraft] = useState<string | undefined>(undefined)
  const [message, setMessage] = useState('')
  if (props.view === 'summary') return props.t('summary')
  const value = state.value
  if (value === undefined) return props.t('unavailable')
  const apiKeyEnv = draft.apiKeyEnv ?? value.apiKeyEnv
  const candidateText = candidateDraft ?? JSON.stringify(value.candidateModels, null, 2)
  const defaultText = defaultDraft ?? JSON.stringify(value.defaultModel, null, 2)
  return (
    <form onSubmit={event => {
      event.preventDefault()
      let candidateModels = value.candidateModels
      let defaultModel = value.defaultModel
      try {
        candidateModels = candidateDraft === undefined ? value.candidateModels : JSON.parse(candidateDraft) as JevRouterSettings['candidateModels']
        defaultModel = defaultDraft === undefined ? value.defaultModel : JSON.parse(defaultDraft) as JevRouterSettings['defaultModel']
      } catch (error: unknown) {
        setMessage(error instanceof Error ? error.message : String(error))
        return
      }
      void props.settings.mutate([
        { op: 'set', path: ['enabled'], value: value.enabled },
        { op: 'set', path: ['apiKeyEnv'], value: apiKeyEnv },
        { op: 'set', path: ['candidateModels'], value: JSON.parse(JSON.stringify(candidateModels)) },
        { op: 'set', path: ['defaultModel'], value: JSON.parse(JSON.stringify(defaultModel)) },
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
          onChange={event => setDraft(previous => ({ ...previous, apiKeyEnv: event.currentTarget.value }))}
        />
      </label>
      <label>{props.t('candidates')}<textarea value={candidateText} onChange={event => {
        const text = event.currentTarget.value
        setCandidateDraft(text)
        try { setDraft(previous => ({ ...previous, candidateModels: JSON.parse(text) as JevRouterSettings['candidateModels'] })) } catch (error: unknown) { void error /* validation reports malformed JSON on save */ }
      }} /></label>
      <label>{props.t('defaultModel')}<input value={defaultText} onChange={event => {
        const text = event.currentTarget.value
        setDefaultDraft(text)
        try { setDraft(previous => ({ ...previous, defaultModel: JSON.parse(text) as JevRouterSettings['defaultModel'] })) } catch (error: unknown) { void error /* validation reports malformed JSON on save */ }
      }} /></label>
      <p>{props.t('dataNotice')}</p>
      <button type="submit" disabled={!state.writable}>{props.t('save')}</button>
      {message ? <span role="status">{message}</span> : null}
    </form>
  )
}

/** Client plugin entry; the host settings scope remains the source of truth. */
/**
 * @param ctx - client Cordis context.
 */
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
