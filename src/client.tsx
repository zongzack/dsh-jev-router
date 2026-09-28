/** Browser half: a small configuration card over the Host-owned settings scope. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
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
import type { ModelCatalog, ModelCatalogModel, ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import { useEffect, useSyncExternalStore, useState } from 'react'
import type { JevRouterHistoryView } from './router-history.ts'
import { DEFAULT_SWITCH_CONTEXT_LIMIT_TOKENS } from './client-defaults.ts'
import type { JevRouterSettings } from './config.ts'

/** Client services required by the settings card. */
export const inject = ['locale', 'remote', 'remote.session', 'sessions', 'settingsScope', 'slots']
const NS = 'jev-router'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'jev-router': 'title' | 'summary' | 'enabled' | 'apiKey' | 'candidates' | 'defaultModel'
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
      | 'modeAuto' | 'modeFixed' | 'modeSwitchError' | 'catalogLoading' | 'catalogEmpty'
      | 'catalogError' | 'catalogRetry' | 'catalogPartial' | 'candidateHint'
      | 'candidateTier' | 'candidateDescription' | 'tierEconomy' | 'tierCapability'
      | 'modelMissing' | 'removeCandidate' | 'addCandidate'
  }
}

const en = {
  title: 'Jev automatic routing',
  summary: 'Choose a model per user turn with TypeSafe Jev.',
  enabled: 'Enable automatic routing',
  apiKey: 'TypeSafe Jev API key',
  candidates: 'Candidate models',
  defaultModel: 'Default fallback model',
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
  modeAuto: 'Auto model', modeFixed: 'Fixed model', modeSwitchError: 'Could not change the routing mode',
  catalogLoading: 'Loading configured models…', catalogEmpty: 'No configured models are available. Add a model under Models settings, then retry.',
  catalogError: 'Could not load configured models', catalogRetry: 'Retry', catalogPartial: 'Some model providers could not be loaded.',
  candidateHint: 'Models come from Models settings. Tier and description tell Jev when each model should be used.',
  candidateTier: 'Routing tier', candidateDescription: 'Routing description',
  tierEconomy: 'Economy', tierCapability: 'Capability', modelMissing: 'Not present in Models settings',
  removeCandidate: 'Remove candidate', addCandidate: 'Add candidate',
} as const

const zh = {
  title: 'Jev 自动路由',
  summary: '使用 TypeSafe Jev 为每个用户回合选择模型。',
  enabled: '开启自动路由',
  apiKey: 'TypeSafe Jev API Key',
  candidates: '候选模型',
  defaultModel: '默认回退模型',
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
  modeAuto: '自动模型', modeFixed: '固定模型', modeSwitchError: '无法切换路由模式',
  catalogLoading: '正在读取已配置模型…', catalogEmpty: '当前没有可用的已配置模型。请先在“模型”设置中添加模型，然后重试。',
  catalogError: '无法读取已配置模型', catalogRetry: '重试', catalogPartial: '部分模型提供方加载失败。',
  candidateHint: '模型来自“模型”设置；档位和说明用于告诉 Jev 何时选择该模型。',
  candidateTier: '路由档位', candidateDescription: '路由说明',
  tierEconomy: '经济档', tierCapability: '能力档', modelMissing: '未在模型设置中配置',
  removeCandidate: '移除候选', addCandidate: '添加候选',
} as const

interface JevRouterFace {
  settings: SettingsScope<JevRouterSettings>
  loadModelCatalog: () => Promise<ModelCatalog>
}

type CardProps = PropsRuntime<'plugins.item'> & PropsLocale<'jev-router'> & InjectFace<JevRouterFace>

interface CatalogRoute {
  provider: ModelProviderGroup
  model: ModelCatalogModel
}

function catalogRoutes(catalog: ModelCatalog | null): CatalogRoute[] {
  return catalog?.groups.flatMap(provider => provider.models.map(model => ({ provider, model }))) ?? []
}

function routeId(route: { provider: string; model: string }): string {
  return `${route.provider}/${route.model}`
}

function splitRouteId(id: string, routes: readonly CatalogRoute[]): { provider: string; model: string } | undefined {
  const route = routes.find(candidate => routeId({ provider: candidate.provider.id, model: candidate.model.id }) === id)
  return route === undefined ? undefined : { provider: route.provider.id, model: route.model.id }
}

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
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [catalogError, setCatalogError] = useState('')
  const [message, setMessage] = useState('')
  const loadCatalog = () => {
    setCatalogStatus('loading')
    setCatalogError('')
    void props.loadModelCatalog().then(value => {
      setCatalog(value)
      setCatalogStatus('ready')
    }, error => {
      setCatalogError(error instanceof Error ? error.message : String(error))
      setCatalogStatus('error')
    })
  }
  useEffect(() => {
    if (props.view !== 'summary') loadCatalog()
    // The injected loader is bound to the current Host generation. Settings
    // cards are remounted on generation replacement, so one load is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (props.view === 'summary') return props.t('summary')
  const value = state.value
  if (value === undefined) return props.t('unavailable')
  const apiKey = draft.apiKey ?? value.apiKey
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
  const candidateModels = draft.candidateModels ?? value.candidateModels
  const defaultModel = draft.defaultModel ?? value.defaultModel
  const routes = catalogRoutes(catalog)
  const configuredRouteIds = new Set(routes.map(route => routeId({ provider: route.provider.id, model: route.model.id })))
  const fieldStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '14px 0',
    borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
  } as const
  const labelStyle = {
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 13,
    fontWeight: 500,
    lineHeight: 1.5,
  } as const
  const hintStyle = {
    margin: 0,
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: 12,
    lineHeight: 1.5,
  } as const
  const inputStyle = {
    boxSizing: 'border-box',
    width: '100%',
    minHeight: 34,
    padding: '7px 12px',
    border: '0.5px solid var(--dsw-alias-border-l4)',
    borderRadius: 8,
    background: 'var(--dsw-alias-bg-layer-3)',
    color: 'var(--dsw-alias-label-primary)',
    font: 'inherit',
    fontSize: 13,
    lineHeight: 1.5,
  } as const
  const checkRowStyle = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '12px 0',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 13,
    lineHeight: 1.5,
  } as const
  const sectionStyle = {
    margin: 0,
    padding: 0,
    border: 0,
  } as const
  const buttonStyle = (enabled: boolean, prominence: 'primary' | 'secondary') => ({
    alignSelf: 'flex-start',
    border: prominence === 'primary'
      ? '1px solid transparent'
      : '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 8,
    padding: '5px 14px',
    font: 'inherit',
    fontSize: 13,
    lineHeight: 1.5,
    cursor: enabled ? 'pointer' : 'default',
    background: prominence === 'primary'
      ? 'var(--dsw-alias-button-primary-fill)'
      : 'var(--dsw-alias-bg-module-platform)',
    color: prominence === 'primary'
      ? 'var(--dsw-alias-label-primary-inverted)'
      : 'var(--dsw-alias-label-secondary)',
    opacity: enabled ? 1 : 0.4,
  } as const)
  return (
    <form style={{ display: 'flex', flexDirection: 'column' }} onSubmit={event => {
      event.preventDefault()
      const missing = candidateModels.find(candidate => !configuredRouteIds.has(routeId(candidate)))
      if (catalogStatus !== 'ready' || routes.length === 0) {
        setMessage(catalogStatus === 'error' ? `${props.t('catalogError')}: ${catalogError}` : props.t('catalogEmpty'))
        return
      }
      if (missing !== undefined || !configuredRouteIds.has(routeId(defaultModel))) {
        setMessage(`${props.t('modelMissing')}: ${routeId(missing ?? defaultModel)}`)
        return
      }
      if (candidateModels.length === 0) {
        setMessage(props.t('candidateHint'))
        return
      }
      void props.settings.mutate([
        { op: 'set', path: ['enabled'], value: value.enabled },
        { op: 'set', path: ['apiKey'], value: apiKey },
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
      <fieldset style={sectionStyle}>
        <legend style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}>{props.t('title')}</legend>
        <label style={{ ...checkRowStyle, paddingTop: 0 }}>
          <input
            type="checkbox"
            checked={value.enabled}
            disabled={!state.writable}
            onChange={event => {
              void props.settings.set('enabled', event.currentTarget.checked)
            }}
          />
          <span>{props.t('enabled')}</span>
        </label>
        <div style={fieldStyle}>
          <label htmlFor="jev-api-key" style={labelStyle}>{props.t('apiKey')}</label>
          <input
            id="jev-api-key"
            type="password"
            autoComplete="off"
            style={inputStyle}
            value={apiKey}
            disabled={!state.writable}
            onChange={event => setDraft(previous => ({ ...previous, apiKey: event.currentTarget.value }))}
          />
          <p style={hintStyle}>直接填写 Jev API Key；该值会保存到插件设置中，不再从环境变量读取。</p>
        </div>
        <div style={fieldStyle}>
          <span id="jev-candidates-label" style={labelStyle}>{props.t('candidates')}</span>
          <p id="jev-candidates-hint" style={hintStyle}>{props.t('candidateHint')}</p>
          {catalogStatus === 'loading'
            ? <p role="status" style={hintStyle}>{props.t('catalogLoading')}</p>
            : catalogStatus === 'error'
              ? <div role="alert" style={{ ...hintStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>{props.t('catalogError')}: {catalogError}</span>
                  <button type="button" style={buttonStyle(true, 'secondary')} onClick={loadCatalog}>{props.t('catalogRetry')}</button>
                </div>
              : routes.length === 0
                ? <div role="status" style={{ ...hintStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>{props.t('catalogEmpty')}</span>
                    <button type="button" style={buttonStyle(true, 'secondary')} onClick={loadCatalog}>{props.t('catalogRetry')}</button>
                  </div>
                : <div role="group" aria-labelledby="jev-candidates-label" aria-describedby="jev-candidates-hint" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {catalog?.failures.length ? <p role="status" style={hintStyle}>{props.t('catalogPartial')}</p> : null}
                    {candidateModels.map((candidate, index) => {
                      const id = routeId(candidate)
                      const missing = !configuredRouteIds.has(id)
                      return <div key={`${id}:${String(index)}`} style={{ padding: 10, border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'center' }}>
                          <label htmlFor={`jev-candidate-model-${String(index)}`} style={labelStyle}>{props.t('candidates')} {index + 1}</label>
                          <button type="button" disabled={!state.writable || candidateModels.length <= 1} style={buttonStyle(state.writable && candidateModels.length > 1, 'secondary')} aria-label={`${props.t('removeCandidate')} ${id}`} onClick={() => setDraft(previous => ({
                            ...previous,
                            candidateModels: candidateModels.filter((_, candidateIndex) => candidateIndex !== index),
                          }))}>{props.t('removeCandidate')}</button>
                        </div>
                        <select id={`jev-candidate-model-${String(index)}`} name="candidateModel" style={inputStyle} value={id} disabled={!state.writable} onChange={event => {
                          const selected = splitRouteId(event.currentTarget.value, routes)
                          if (selected === undefined) return
                          const catalogModel = routes.find(route => route.provider.id === selected.provider && route.model.id === selected.model)?.model
                          setDraft(previous => ({
                            ...previous,
                            candidateModels: candidateModels.map((entry, candidateIndex) => candidateIndex === index ? {
                              ...entry,
                              ...selected,
                              description: catalogModel?.description ?? entry.description,
                            } : entry),
                          }))
                        }}>
                          {missing ? <option value={id}>{id} — {props.t('modelMissing')}</option> : null}
                          {routes.map(route => <option key={routeId({ provider: route.provider.id, model: route.model.id })} value={routeId({ provider: route.provider.id, model: route.model.id })}>
                            {route.provider.name} · {route.model.name} ({route.provider.id}/{route.model.id})
                          </option>)}
                        </select>
                        <label htmlFor={`jev-candidate-tier-${String(index)}`} style={labelStyle}>{props.t('candidateTier')}</label>
                        <select id={`jev-candidate-tier-${String(index)}`} name="candidateTier" style={inputStyle} value={candidate.tier} disabled={!state.writable} onChange={event => setDraft(previous => ({
                          ...previous,
                          candidateModels: candidateModels.map((entry, candidateIndex) => candidateIndex === index ? {
                            ...entry,
                            tier: event.currentTarget.value as JevRouterSettings['candidateModels'][number]['tier'],
                          } : entry),
                        }))}>
                          <option value="economy">{props.t('tierEconomy')}</option>
                          <option value="capability">{props.t('tierCapability')}</option>
                        </select>
                        <label htmlFor={`jev-candidate-description-${String(index)}`} style={labelStyle}>{props.t('candidateDescription')}</label>
                        <input id={`jev-candidate-description-${String(index)}`} name="candidateDescription" style={inputStyle} value={candidate.description} disabled={!state.writable} onChange={event => setDraft(previous => ({
                          ...previous,
                          candidateModels: candidateModels.map((entry, candidateIndex) => candidateIndex === index ? {
                            ...entry,
                            description: event.currentTarget.value,
                          } : entry),
                        }))} />
                      </div>
                    })}
                    <button type="button" disabled={!state.writable || candidateModels.length >= routes.length} style={buttonStyle(state.writable && candidateModels.length < routes.length, 'secondary')} onClick={() => {
                      const existing = new Set(candidateModels.map(routeId))
                      const next = routes.find(route => !existing.has(routeId({ provider: route.provider.id, model: route.model.id })))
                      if (next === undefined) return
                      setDraft(previous => ({
                        ...previous,
                        candidateModels: [...candidateModels, {
                          provider: next.provider.id,
                          model: next.model.id,
                          description: next.model.description ?? `${next.model.name} routing candidate`,
                          tier: 'economy',
                        }],
                      }))
                    }}>{props.t('addCandidate')}</button>
                  </div>}
        </div>
        <div style={fieldStyle}>
          <label htmlFor="jev-default-model" style={labelStyle}>{props.t('defaultModel')}</label>
          <select id="jev-default-model" style={inputStyle} value={routeId(defaultModel)} disabled={!state.writable || catalogStatus !== 'ready' || routes.length === 0} onChange={event => {
            const selected = splitRouteId(event.currentTarget.value, routes)
            if (selected !== undefined) setDraft(previous => ({ ...previous, defaultModel: selected }))
          }}>
            {!configuredRouteIds.has(routeId(defaultModel)) ? <option value={routeId(defaultModel)}>{routeId(defaultModel)} — {props.t('modelMissing')}</option> : null}
            {routes.map(route => <option key={routeId({ provider: route.provider.id, model: route.model.id })} value={routeId({ provider: route.provider.id, model: route.model.id })}>
              {route.provider.name} · {route.model.name} ({route.provider.id}/{route.model.id})
            </option>)}
          </select>
          <p style={hintStyle}>分类服务不可用或超时时，沿用当前路线；没有当前路线时使用这里的模型。</p>
        </div>
      </fieldset>
      <fieldset style={sectionStyle}>
        <legend style={{ ...labelStyle, padding: '20px 0 0' }}>路由约束</legend>
        <div style={fieldStyle}>
          <label htmlFor="switchContextLimitTokens" style={labelStyle}>{props.t('contextLimit')}</label>
          <input
            id="switchContextLimitTokens"
            name="switchContextLimitTokens"
            style={inputStyle}
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
          <label style={checkRowStyle}>
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
            <span>{props.t('contextLimitDisabled')}</span>
          </label>
          <p style={hintStyle}>{props.t('guardNotice')}</p>
        </div>
        <div style={fieldStyle}>
          <label htmlFor="overLimitPolicy" style={labelStyle}>{props.t('overLimitPolicy')}</label>
          <select
            id="overLimitPolicy"
            name="overLimitPolicy"
            style={inputStyle}
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
        </div>
        <label style={checkRowStyle}>
          <input name="cacheAware" type="checkbox" checked={cacheAware} disabled={!state.writable} onChange={event => setDraft(previous => ({ ...previous, cacheAware: event.currentTarget.checked }))} />
          <span>{props.t('cacheAware')}</span>
        </label>
      </fieldset>
      <fieldset style={sectionStyle}>
        <legend style={{ ...labelStyle, padding: '20px 0 0' }}>诊断与展示</legend>
        <label style={checkRowStyle}>
          <input name="showDecision" type="checkbox" checked={showDecision} disabled={!state.writable} onChange={event => setDraft(previous => ({ ...previous, showDecision: event.currentTarget.checked }))} />
          <span>{props.t('showDecision')}</span>
        </label>
        <label style={checkRowStyle}>
          <input name="recordMetrics" type="checkbox" checked={recordMetrics} disabled={!state.writable} onChange={event => setDraft(previous => ({ ...previous, recordMetrics: event.currentTarget.checked }))} />
          <span>{props.t('recordMetrics')}</span>
        </label>
        <p style={{ ...hintStyle, padding: '0 0 14px' }}>{props.t('metricsNotice')}</p>
      </fieldset>
      <details style={{ borderTop: '0.5px solid var(--dsw-alias-border-l2)', padding: '14px 0' }}>
        <summary style={{ cursor: 'pointer', color: 'var(--dsw-alias-label-primary)', fontSize: 13, fontWeight: 500 }}>{props.t('advanced')}</summary>
        <div style={{ paddingTop: 4 }}>
          <div style={fieldStyle}>
            <label htmlFor="minHoldUserTurns" style={labelStyle}>{props.t('minHoldUserTurns')}</label>
            <input id="minHoldUserTurns" name="minHoldUserTurns" style={inputStyle} type="number" min={0} step={1} value={minHoldUserTurns} disabled={!state.writable} onChange={event => setDraft(previous => ({ ...previous, minHoldUserTurns: Number(event.currentTarget.value) }))} />
          </div>
          <label style={checkRowStyle}>
            <input name="routeReasoning" type="checkbox" checked={routeReasoning} disabled={!state.writable} onChange={event => setDraft(previous => ({ ...previous, routeReasoning: event.currentTarget.checked }))} />
            <span>{props.t('routeReasoning')}</span>
          </label>
          <div style={fieldStyle}>
            <label htmlFor="jevTimeoutMs" style={labelStyle}>{props.t('jevTimeoutMs')}</label>
            <input id="jevTimeoutMs" name="jevTimeoutMs" style={inputStyle} type="number" min={1} step={1} value={jevTimeoutMs} disabled={!state.writable} onChange={event => setDraft(previous => ({ ...previous, jevTimeoutMs: Number(event.currentTarget.value) }))} />
          </div>
          <div style={fieldStyle}>
            <label htmlFor="jevMaxStateChars" style={labelStyle}>{props.t('jevMaxStateChars')}</label>
            <input id="jevMaxStateChars" name="jevMaxStateChars" style={inputStyle} type="number" min={1} step={1} value={jevMaxStateChars} disabled={!state.writable} onChange={event => setDraft(previous => ({ ...previous, jevMaxStateChars: Number(event.currentTarget.value) }))} />
            <p style={hintStyle}>{props.t('reasoningNotice')}</p>
          </div>
        </div>
      </details>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 16 }}>
        <button type="submit" disabled={!state.writable} style={buttonStyle(state.writable, 'primary')}>{props.t('save')}</button>
        {message ? <span role="status" style={hintStyle}>{message}</span> : null}
      </div>
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

/** Show and toggle the durable automatic/fixed model mode for one session.
 * @param props - session projection and command face supplied by the input toolbar slot.
 * @returns a button reflecting and toggling the session routing mode.
 */
export function JevRouterModeControl(
  props: PropsRuntime<'conversation.input.left'> & PropsLocale<'jev-router'> & InjectFace<JevRouterModeInjected>,
) {
  const projection = props.useProjection('jevRouterHistory') as JevRouterHistoryView | undefined
  const mode = projection?.mode ?? 'fixed'
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const label = mode === 'auto' ? props.t('modeAuto') : props.t('modeFixed')
  return <button
    type="button"
    disabled={busy}
    aria-pressed={mode === 'auto'}
    aria-label={label}
    title={failed ? props.t('modeSwitchError') : label}
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      minWidth: 0,
      maxWidth: 'min(220px, 45cqw)',
      height: 28,
      padding: '0 4px 0 8px',
      border: 'none',
      borderRadius: 24,
      outline: 'none',
      background: hovered ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
      color: busy ? 'var(--dsw-alias-label-dimmed)' : 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      fontWeight: 500,
      cursor: busy ? 'default' : 'pointer',
      boxShadow: focused ? '0 0 0 2px var(--dsw-alias-border-l3)' : 'none',
      whiteSpace: 'nowrap',
    }}
    onMouseEnter={() => setHovered(true)}
    onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)}
    onBlur={() => setFocused(false)}
    onClick={() => {
      setBusy(true)
      setFailed(false)
      void props.setMode(mode === 'auto' ? 'fixed' : 'auto')
        .then(ok => { setFailed(!ok) }, () => { setFailed(true) })
        .finally(() => { setBusy(false) })
    }}
  >{label}</button>
}

/** Client plugin entry; the host settings scope remains the source of truth. */
/**
 * @param ctx - client Cordis context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'jev-router: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.inject(['remote', 'remote.session', 'slots', 'settingsScope'], scope => {
    const settings = scope.settingsScope.bind<JevRouterSettings>({ namespace: NS })
    scope.slots.inject('plugins.item', () => scope.slots.register({
      name: 'plugins.item',
      id: NS,
      order: 45,
      label: () => t('title'),
      locale: NS,
      inject: () => ({
        settings,
        loadModelCatalog: async () => {
          const response = await scope.remote.session.modelCatalog()
          if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
          return response.value
        },
      }),
    }, JevRouterCard))
    scope.slots.inject('conversation.chat.turnTail', () => scope.slots.register({
      name: 'conversation.chat.turnTail', id: NS, locale: NS,
    }, JevRouterDecisionTail))
    scope.slots.inject('conversation.input.left', () => scope.slots.register({
      name: 'conversation.input.left', id: `${NS}-mode`, order: 35, locale: NS,
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
