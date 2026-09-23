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
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { useSyncExternalStore, useState } from 'react'
import type { JevRouterHistoryView } from './router-history.ts'
import { DEFAULT_SWITCH_CONTEXT_LIMIT_TOKENS } from './client-defaults.ts'
import type { JevRouterSettings } from './config.ts'

/** Client services required by the settings card. */
export const inject = ['locale', 'sessions', 'settingsScope', 'slots']
const NS = 'jev-router'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'jev-router': 'title' | 'summary' | 'enabled' | 'apiKeyEnv' | 'candidates' | 'defaultModel'
      | 'contextLimit' | 'contextLimitDisabled' | 'overLimitPolicy' | 'overLimitKeep'
      | 'overLimitUpgradeOnly' | 'cacheAware' | 'advanced' | 'minHoldUserTurns'
      | 'routeReasoning' | 'jevTimeoutMs' | 'jevMaxStateChars' | 'reasoningNotice'
      | 'showDecision' | 'recordMetrics' | 'metricsNotice' | 'usageUnknown'
      | 'decisionPolicy' | 'decisionJevVersion' | 'decisionJevLatency' | 'decisionUsage'
      | 'decisionClassificationUsage'
      | 'usageInput' | 'usageOutput' | 'usageCacheRead' | 'usageCacheWrite'
      | 'guardNotice' | 'dataNotice' | 'save' | 'saved' | 'unavailable'
      | 'decisionSuggested' | 'decisionActual' | 'decisionInput' | 'decisionReason'
      | 'decisionReasoning' | 'reasoningUnavailable' | 'reasoningDefault' | 'decisionFallback'
      | 'modeAuto' | 'modeFixed' | 'modeSwitchError'
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
  routeReasoning: 'Route reasoning effort when the selected model advertises support',
  jevTimeoutMs: 'Jev timeout (milliseconds)',
  jevMaxStateChars: 'Maximum classification state (Unicode characters)',
  showDecision: 'Show route decisions in the conversation',
  recordMetrics: 'Record structured routing metrics',
  metricsNotice: 'Metrics contain routes, timing, and reported token/cache usage only; prompts, tools, credentials, and costs are not recorded.',
  usageUnknown: 'unknown',
  decisionPolicy: 'Policy version', decisionJevVersion: 'Jev version', decisionJevLatency: 'Jev latency', decisionUsage: 'Execution usage',
  decisionClassificationUsage: 'Classification usage',
  usageInput: 'input', usageOutput: 'output', usageCacheRead: 'cache read', usageCacheWrite: 'cache write',
  reasoningNotice: 'Reasoning choices come from the live adapter catalog. Unsupported models keep their adapter default.',
  guardNotice: 'Input size covers the full request and is marked as an estimate. Missing cache fields remain unknown, not zero.',
  dataNotice: 'Limited routing material is sent to TypeSafe for classification; conversation history remains in dsh.',
  save: 'Save',
  saved: 'Saved',
  unavailable: 'Settings are unavailable in this profile.',
  decisionSuggested: 'Suggested model', decisionActual: 'Actual model', decisionInput: 'Input size', decisionReason: 'Routing rule',
  decisionReasoning: 'Reasoning effort', reasoningUnavailable: 'Unavailable for this model', reasoningDefault: 'Adapter default', decisionFallback: 'Fallback',
  modeAuto: 'Auto', modeFixed: 'Fixed', modeSwitchError: 'Could not change the routing mode',
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
  routeReasoning: '目标模型明确支持时自动调整思考档位',
  jevTimeoutMs: 'Jev 超时（毫秒）',
  jevMaxStateChars: '分类材料上限（Unicode 字符）',
  showDecision: '在会话中展示路由决定',
  recordMetrics: '记录结构化路由指标',
  metricsNotice: '指标仅包含路线、耗时和已报告的 token/缓存用量；不会记录提示词、工具、凭据或费用。',
  usageUnknown: '未知',
  decisionPolicy: '策略版本', decisionJevVersion: 'Jev 版本', decisionJevLatency: 'Jev 耗时', decisionUsage: '执行用量',
  decisionClassificationUsage: '分类用量',
  usageInput: '输入', usageOutput: '输出', usageCacheRead: '缓存读取', usageCacheWrite: '缓存写入',
  reasoningNotice: '思考档位来自实时适配器目录；模型未声明支持时保留适配器默认行为。',
  guardNotice: '输入规模覆盖完整请求并明确标为估算；缺失的缓存字段保持“未知”，不会当作零命中。',
  dataNotice: '有限的分类材料会发送到 TypeSafe；完整会话历史仍由 dsh 执行模型接收。',
  save: '保存',
  saved: '已保存',
  unavailable: '此 profile 暂无设置服务。',
  decisionSuggested: '建议模型', decisionActual: '实际模型', decisionInput: '输入规模', decisionReason: '路由规则',
  decisionReasoning: '思考档位', reasoningUnavailable: '该模型不支持调整', reasoningDefault: '适配器默认', decisionFallback: '回退原因',
  modeAuto: '自动', modeFixed: '固定', modeSwitchError: '无法切换路由模式',
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
  const routeReasoning = draft.routeReasoning ?? value.routeReasoning
  const jevTimeoutMs = draft.jevTimeoutMs ?? value.jevTimeoutMs
  const jevMaxStateChars = draft.jevMaxStateChars ?? value.jevMaxStateChars
  const showDecision = draft.showDecision ?? value.showDecision
  const recordMetrics = draft.recordMetrics ?? value.recordMetrics
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
        { op: 'set', path: ['routeReasoning'], value: routeReasoning },
        { op: 'set', path: ['jevTimeoutMs'], value: jevTimeoutMs },
        { op: 'set', path: ['jevMaxStateChars'], value: jevMaxStateChars },
        { op: 'set', path: ['showDecision'], value: showDecision },
        { op: 'set', path: ['recordMetrics'], value: recordMetrics },
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
      <label>
        <input
          name="showDecision"
          type="checkbox"
          checked={showDecision}
          disabled={!state.writable}
          onChange={event => setDraft(previous => ({ ...previous, showDecision: event.currentTarget.checked }))}
        />
        {props.t('showDecision')}
      </label>
      <label>
        <input
          name="recordMetrics"
          type="checkbox"
          checked={recordMetrics}
          disabled={!state.writable}
          onChange={event => setDraft(previous => ({ ...previous, recordMetrics: event.currentTarget.checked }))}
        />
        {props.t('recordMetrics')}
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
        <label>
          <input
            name="routeReasoning"
            type="checkbox"
            checked={routeReasoning}
            disabled={!state.writable}
            onChange={event => setDraft(previous => ({ ...previous, routeReasoning: event.currentTarget.checked }))}
          />
          {props.t('routeReasoning')}
        </label>
        <label>
          {props.t('jevTimeoutMs')}
          <input
            name="jevTimeoutMs"
            type="number"
            min={1}
            step={1}
            value={jevTimeoutMs}
            disabled={!state.writable}
            onChange={event => setDraft(previous => ({ ...previous, jevTimeoutMs: Number(event.currentTarget.value) }))}
          />
        </label>
        <label>
          {props.t('jevMaxStateChars')}
          <input
            name="jevMaxStateChars"
            type="number"
            min={1}
            step={1}
            value={jevMaxStateChars}
            disabled={!state.writable}
            onChange={event => setDraft(previous => ({ ...previous, jevMaxStateChars: Number(event.currentTarget.value) }))}
          />
        </label>
        <p>{props.t('reasoningNotice')}</p>
      </details>
      <p>{props.t('guardNotice')}</p>
      <p>{props.t('dataNotice')}</p>
      <p>{props.t('metricsNotice')}</p>
      <button type="submit" disabled={!state.writable}>{props.t('save')}</button>
      {message ? <span role="status">{message}</span> : null}
    </form>
  )
}

/** Render the latest durable route outcome below a completed chat turn. */
export function JevRouterDecisionTail(
  props: PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<'jev-router'>,
) {
  const history = props.useProjection('jevRouterHistory') as JevRouterHistoryView | undefined
  const decision = history?.decision
  if (decision === undefined || decision.turn !== props.turn.turn) return null
  const model = (route: { provider: string; model: string }) => `${route.provider}/${route.model}`
  return <aside data-jev-router-decision>
    <span>{props.t('decisionSuggested')}: {model(decision.suggested)}</span>
    <span>{props.t('decisionActual')}: {model(decision.actual)}</span>
    <span>{props.t('decisionInput')}: {decision.inputTokens === null ? '?' : decision.inputTokens}{decision.estimated ? ' (estimated)' : ''}</span>
    <span>{props.t('decisionReason')}: {decision.reason}</span>
    {decision.policyVersion === undefined ? null : <span>{props.t('decisionPolicy')}: {decision.policyVersion}</span>}
    {decision.jevVersion === undefined ? null : <span>{props.t('decisionJevVersion')}: {decision.jevVersion}</span>}
    {decision.classificationMs === undefined ? null : <span>{props.t('decisionJevLatency')}: {decision.classificationMs} ms</span>}
    {decision.classificationUsage === undefined ? null : <span>{props.t('decisionClassificationUsage')}: {props.t('usageInput')} {decision.classificationUsage.inputTokens ?? props.t('usageUnknown')}, {props.t('usageOutput')} {decision.classificationUsage.outputTokens ?? props.t('usageUnknown')}, {props.t('usageCacheRead')} {decision.classificationUsage.cacheReadTokens ?? props.t('usageUnknown')}, {props.t('usageCacheWrite')} {decision.classificationUsage.cacheWriteTokens ?? props.t('usageUnknown')}</span>}
    <span>{props.t('decisionReasoning')}: {decision.reasoningSupported === false
      ? props.t('reasoningUnavailable')
      : decision.reasoningEffort ?? (decision.reasoningSupported === true
        ? props.t('reasoningDefault')
        : props.t('reasoningUnavailable'))}</span>
    {decision.fallback === undefined ? null : <span>{props.t('decisionFallback')}: {decision.fallback}</span>}
    {decision.usage === undefined ? null : <span>{props.t('decisionUsage')}: {props.t('usageInput')} {decision.usage.inputTokens ?? props.t('usageUnknown')}, {props.t('usageOutput')} {decision.usage.outputTokens ?? props.t('usageUnknown')}, {props.t('usageCacheRead')} {decision.usage.cacheReadTokens ?? props.t('usageUnknown')}, {props.t('usageCacheWrite')} {decision.usage.cacheWriteTokens ?? props.t('usageUnknown')}</span>}
  </aside>
}

interface JevRouterModeInjected {
  setMode: (mode: 'auto' | 'fixed') => Promise<boolean>
}

/** Show and toggle the durable Auto/Fixed routing mode for one session.
 * @param props - session projection and command face supplied by the conversation header slot.
 * @returns a button reflecting and toggling the session routing mode.
 */
export function JevRouterModeControl(
  props: PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'jev-router'> & InjectFace<JevRouterModeInjected>,
) {
  const projection = props.useProjection('jevRouterHistory') as JevRouterHistoryView | undefined
  const mode = projection?.mode ?? 'fixed'
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return <button
    type="button"
    disabled={busy}
    aria-pressed={mode === 'auto'}
    title={failed ? props.t('modeSwitchError') : undefined}
    onClick={() => {
      setBusy(true)
      setFailed(false)
      void props.setMode(mode === 'auto' ? 'fixed' : 'auto')
        .then(ok => { setFailed(!ok) }, () => { setFailed(true) })
        .finally(() => { setBusy(false) })
    }}
  >{mode === 'auto' ? props.t('modeAuto') : props.t('modeFixed')}</button>
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
    scope.slots.inject('conversation.session.header.actions', () => scope.slots.register({
      name: 'conversation.session.header.actions', id: `${NS}-mode`, order: 35, locale: NS,
      inject: sessionId => ({
        setMode: async (mode: 'auto' | 'fixed') => {
          const sessions = scope.get('sessions') as unknown as ISessions
          const actx = sessions.scope(sessionId)
          const session = actx === undefined ? undefined : sessions.sessionOf(actx)
          const result = await session?.command(mode === 'auto' ? '/jev-auto' : '/jev-fixed')
          return result?.ok === true && result.value.matched
        },
      }),
    }, JevRouterModeControl))
  })
}
