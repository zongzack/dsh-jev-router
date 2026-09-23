/** Browser half: a small configuration card over the Host-owned settings scope. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { useSyncExternalStore, useState } from 'react'
import type { JevRouterDecisionView } from './router-history.ts'
import { DEFAULT_SWITCH_CONTEXT_LIMIT_TOKENS, type JevRouterSettings } from './config.ts'

/** Client services required by the settings card. */
export const inject = ['locale', 'settingsScope', 'slots']
const NS = 'jev-router'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'jev-router': 'title' | 'summary' | 'enabled' | 'apiKeyEnv' | 'candidates' | 'defaultModel'
      | 'contextLimit' | 'contextLimitDisabled' | 'overLimitPolicy' | 'overLimitKeep'
      | 'overLimitUpgradeOnly' | 'cacheAware' | 'advanced' | 'minHoldUserTurns'
      | 'guardNotice' | 'dataNotice' | 'save' | 'saved' | 'unavailable'
      | 'decisionSuggested' | 'decisionActual' | 'decisionInput' | 'decisionReason'
  }
}

const en = {
  title: 'Jev automatic routing',
  summary: 'Choose a model per user turn with TypeSafe Jev.',
  enabled: 'Enable automatic routing',
  apiKeyEnv: 'TypeSafe credential reference',
  candidates: 'Candidate models (provider/model JSON)',
  defaultModel: 'Default fallback (provider/model JSON)',
  contextLimit: 'Free-switch input limit (estimated tokens)',
  contextLimitDisabled: 'Disable context limit',
  overLimitPolicy: 'Above-limit behavior',
  overLimitKeep: 'Keep the current model',
  overLimitUpgradeOnly: 'Allow necessary upgrades only',
  cacheAware: 'Use reported cache evidence as a routing preference',
  advanced: 'Advanced settings',
  minHoldUserTurns: 'Completed user turns to hold after switching',
  guardNotice: 'Input size covers the full request and is marked as an estimate. Missing cache fields remain unknown, not zero.',
  dataNotice: 'Limited routing material is sent to TypeSafe for classification; conversation history remains in dsh.',
  save: 'Save',
  saved: 'Saved',
  unavailable: 'Settings are unavailable in this profile.',
  decisionSuggested: 'Suggested model', decisionActual: 'Actual model', decisionInput: 'Input size', decisionReason: 'Routing rule',
} as const

const zh = {
  title: 'Jev 自动路由',
  summary: '使用 TypeSafe Jev 为每个用户回合选择模型。',
  enabled: '开启自动路由',
  apiKeyEnv: 'TypeSafe 凭据引用',
  candidates: '候选模型（provider/model JSON）',
  defaultModel: '默认回退模型（provider/model JSON）',
  contextLimit: '自由切换输入上限（估算 token）',
  contextLimitDisabled: '禁用上下文阈值',
  overLimitPolicy: '超限行为',
  overLimitKeep: '保持当前模型',
  overLimitUpgradeOnly: '仅允许必要升级',
  cacheAware: '使用已报告的缓存证据作为路由偏好',
  advanced: '高级设置',
  minHoldUserTurns: '切换后保持的已完成用户回合数',
  guardNotice: '输入规模覆盖完整请求并明确标为估算；缺失的缓存字段保持“未知”，不会当作零命中。',
  dataNotice: '有限的分类材料会发送到 TypeSafe；完整会话历史仍由 dsh 执行模型接收。',
  save: '保存',
  saved: '已保存',
  unavailable: '此 profile 暂无设置服务。',
  decisionSuggested: '建议模型', decisionActual: '实际模型', decisionInput: '输入规模', decisionReason: '路由规则',
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
  const switchContextLimitTokens = draft.switchContextLimitTokens !== undefined
    ? draft.switchContextLimitTokens
    : value.switchContextLimitTokens
  const overLimitPolicy = draft.overLimitPolicy ?? value.overLimitPolicy
  const minHoldUserTurns = draft.minHoldUserTurns ?? value.minHoldUserTurns
  const cacheAware = draft.cacheAware ?? value.cacheAware
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
        { op: 'set', path: ['switchContextLimitTokens'], value: switchContextLimitTokens },
        { op: 'set', path: ['overLimitPolicy'], value: overLimitPolicy },
        { op: 'set', path: ['minHoldUserTurns'], value: minHoldUserTurns },
        { op: 'set', path: ['cacheAware'], value: cacheAware },
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
      <label>
        {props.t('contextLimit')}
        <input
          name="switchContextLimitTokens"
          type="number"
          min={1}
          step={1}
          value={switchContextLimitTokens ?? value.switchContextLimitTokens ?? DEFAULT_SWITCH_CONTEXT_LIMIT_TOKENS}
          disabled={!state.writable || switchContextLimitTokens === null}
          onChange={event => setDraft(previous => ({
            ...previous,
            switchContextLimitTokens: Number(event.currentTarget.value),
          }))}
        />
      </label>
      <label>
        <input
          name="disableSwitchContextLimit"
          type="checkbox"
          checked={switchContextLimitTokens === null}
          disabled={!state.writable}
          onChange={event => setDraft(previous => ({
            ...previous,
            switchContextLimitTokens: event.currentTarget.checked
              ? null
              : value.switchContextLimitTokens ?? DEFAULT_SWITCH_CONTEXT_LIMIT_TOKENS,
          }))}
        />
        {props.t('contextLimitDisabled')}
      </label>
      <label>
        {props.t('overLimitPolicy')}
        <select
          name="overLimitPolicy"
          value={overLimitPolicy}
          disabled={!state.writable}
          onChange={event => setDraft(previous => ({
            ...previous,
            overLimitPolicy: event.currentTarget.value as JevRouterSettings['overLimitPolicy'],
          }))}
        >
          <option value="upgrade_only">{props.t('overLimitUpgradeOnly')}</option>
          <option value="keep">{props.t('overLimitKeep')}</option>
        </select>
      </label>
      <label>
        <input
          name="cacheAware"
          type="checkbox"
          checked={cacheAware}
          disabled={!state.writable}
          onChange={event => setDraft(previous => ({ ...previous, cacheAware: event.currentTarget.checked }))}
        />
        {props.t('cacheAware')}
      </label>
      <details>
        <summary>{props.t('advanced')}</summary>
        <label>
          {props.t('minHoldUserTurns')}
          <input
            name="minHoldUserTurns"
            type="number"
            min={0}
            step={1}
            value={minHoldUserTurns}
            disabled={!state.writable}
            onChange={event => setDraft(previous => ({
              ...previous,
              minHoldUserTurns: Number(event.currentTarget.value),
            }))}
          />
        </label>
      </details>
      <p>{props.t('guardNotice')}</p>
      <p>{props.t('dataNotice')}</p>
      <button type="submit" disabled={!state.writable}>{props.t('save')}</button>
      {message ? <span role="status">{message}</span> : null}
    </form>
  )
}

/** Render the latest durable route outcome below a completed chat turn. */
export function JevRouterDecisionTail(
  props: PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<'jev-router'>,
) {
  const decision = props.useProjection('jevRouterHistory') as JevRouterDecisionView | undefined
  if (decision === undefined || decision.turn !== props.turn.turn) return null
  const model = (route: { provider: string; model: string }) => `${route.provider}/${route.model}`
  return <aside data-jev-router-decision>
    <span>{props.t('decisionSuggested')}: {model(decision.suggested)}</span>
    <span>{props.t('decisionActual')}: {model(decision.actual)}</span>
    <span>{props.t('decisionInput')}: {decision.inputTokens === null ? '?' : decision.inputTokens}{decision.estimated ? ' (estimated)' : ''}</span>
    <span>{props.t('decisionReason')}: {decision.reason}</span>
  </aside>
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
    scope.slots.inject('conversation.chat.turnTail', () => scope.slots.register({
      name: 'conversation.chat.turnTail', id: NS, locale: NS,
    }, JevRouterDecisionTail))
  })
}

export default apply
