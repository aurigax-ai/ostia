import { ArrowClockwiseIcon, CopyIcon } from '@phosphor-icons/react'
import type {
  AssistExtensionState,
  AssistFeatureId,
  AssistFeatureState,
  AssistModel,
  AssistModelsResult,
  AssistUi,
} from '@shared/assist'
import type { ExtensionInfo } from '@shared/extensions'
import { PRODUCT_NAME } from '@shared/product'
import { useCallback, useEffect, useState } from 'react'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import { toggleAssistFeature } from '../lib/assistFeatures'
import { openAssistUi } from '../lib/assistUi'
import { useChordLabel } from '../lib/chords'
import { isMac } from '../platform'
import { useAssistStore } from '../stores/assistStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { ChatToolsSettings } from './ChatToolsSettings'
import { ExtensionSettingsForm } from './ExtensionSettingsForm'
import { IconButton } from './IconButton'
import { ControlRow, SectionHead, SettingsGroup, ToggleRow } from './SettingsPanel'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from './ui/item'
import { Switch } from './ui/switch'

const COPIED_MS = 1500

interface Chords {
  chat: string | null
  ask: string | null
  compose: string | null
}

const TRY_UI: Partial<Record<AssistFeatureId, AssistUi>> = {
  chat: 'chat',
  typos: 'compose',
  promptReview: 'compose',
  commandSuggest: 'compose',
}

export function featureHints(d: Dict, id: AssistFeatureId, keys: Chords): string[] {
  const h = d.assistantSettings.hints
  const keyed = (k: string | null, template: string): string[] =>
    k ? [fmt(template, { keys: k })] : []
  switch (id) {
    case 'chat':
      return [...keyed(keys.chat, h.chatPane), ...keyed(keys.ask, h.ask)]
    case 'typos':
      return keyed(keys.compose, h.composer)
    case 'promptReview':
      return [...keyed(keys.compose, h.composer), h.review]
    case 'commandSuggest':
      return [...keyed(keys.compose, h.composer), h.hash]
    case 'terminalCompletions':
      return [h.terminal]
    case 'editorCompletions':
      return [h.editor]
    case 'explainError':
      return [h.explain]
  }
}

export function isAssistExtension(ext: ExtensionInfo): boolean {
  return ext.assist.length > 0
}

function Status({ state }: { state: AssistExtensionState }): JSX.Element {
  const d = useDict()
  const ready = state.features.some((f) => f.on && f.ready)
  const problem = state.setup ? (d.assistMenu.setup[state.setup] ?? null) : null
  const error =
    problem ?? (state.lastError ? fmt(d.assistMenu.lastError, { error: state.lastError }) : null)
  return (
    <ControlRow label={d.assistantSettings.status} desc={state.label} error={error}>
      <output className="text-fg-muted text-ui-sm">
        {ready ? d.assistMenu.ready : d.assistMenu.notReady}
      </output>
    </ControlRow>
  )
}

function FeatureRow({
  extId,
  feature,
  keys,
}: {
  extId: string
  feature: AssistFeatureState
  keys: Chords
}): JSX.Element {
  const d = useDict()
  const name = d.assistMenu.feature[feature.id] ?? feature.id
  const hints = featureHints(d, feature.id, keys)
  const ui = TRY_UI[feature.id]
  return (
    <div className="flex items-start justify-between gap-6 py-1.5">
      <div className="min-w-0">
        <div className="text-fg text-ui-base">{name}</div>
        <p className="mt-0.5 text-fg-muted text-ui-sm">
          {d.assistantSettings.featureDesc[feature.id]}
        </p>
        {hints.length > 0 ? (
          <p className="mt-0.5 text-fg-muted text-ui-xs">{hints.join(' · ')}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {feature.on && !feature.ready ? (
          <span className="text-fg-muted text-ui-sm">{d.assistMenu.notReady}</span>
        ) : null}
        {ui && feature.on && feature.ready ? (
          <Button
            variant="outline"
            size="sm"
            aria-label={fmt(d.assistantSettings.tryLabel, { feature: name })}
            onClick={() => {
              useUIStore.getState().leaveSettings()
              openAssistUi({ extId, ui })
            }}
          >
            {d.assistantSettings.tryIt}
          </Button>
        ) : null}
        <Switch
          checked={feature.on}
          aria-label={name}
          onCheckedChange={() => void toggleAssistFeature(extId, feature)}
        />
      </div>
    </div>
  )
}

function Features({ state, chat }: { state: AssistExtensionState; chat: boolean }): JSX.Element {
  const d = useDict()
  const history = useSettingsStore((s) => s.assistant.chatHistory)
  const keys: Chords = {
    chat: useChordLabel('assist.chat', isMac),
    ask: useChordLabel('palette.toggle', isMac),
    compose: useChordLabel('assist.compose', isMac),
  }
  return (
    <SettingsGroup title={d.assistantSettings.features}>
      <Status state={state} />
      {state.features.map((feature) => (
        <FeatureRow key={feature.id} extId={state.extId} feature={feature} keys={keys} />
      ))}
      {chat ? (
        <ToggleRow
          label={d.chat.saveHistory}
          desc={fmt(d.assistantSettings.saveHistoryDesc, { app: PRODUCT_NAME })}
          checked={history}
          onChange={(on) => useSettingsStore.getState().setChatHistory(on)}
        />
      ) : null}
    </SettingsGroup>
  )
}

function modelState(d: Dict, model: AssistModel): string {
  const t = d.assistantSettings
  if (model.installed === false) return t.notInstalled
  if (model.busy) return t.busy
  if (!model.loaded) return t.notLoaded
  if (model.idleSecs === undefined) return t.loaded
  const idle =
    model.idleSecs < 60
      ? fmt(t.idleSeconds, { n: model.idleSecs })
      : fmt(t.idleMinutes, { n: Math.round(model.idleSecs / 60) })
  return `${t.loaded} · ${idle}`
}

function ModelRow({
  model,
  lifecycle,
  inUse,
  pending,
  copied,
  onLifecycle,
  onCopy,
}: {
  model: AssistModel
  lifecycle: boolean
  inUse: boolean
  pending: string | null
  copied: boolean
  onLifecycle: () => void
  onCopy: () => void
}): JSX.Element {
  const d = useDict()
  const t = d.assistantSettings
  return (
    <Item variant="outline" size="sm" render={<li />} className="rounded-md border-line px-3 py-2">
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="font-mono font-normal text-fg text-ui-sm">
          {model.id}
          {inUse ? (
            <Badge variant="outline" className="font-normal font-sans text-fg-muted text-ui-xs">
              {t.inUse}
            </Badge>
          ) : null}
        </ItemTitle>
        {model.name || lifecycle ? (
          <ItemDescription className="text-fg-muted text-ui-xs">
            {[model.name, lifecycle ? modelState(d, model) : null].filter(Boolean).join(' · ')}
          </ItemDescription>
        ) : null}
        {model.description ? (
          <ItemDescription className="text-fg-muted text-ui-xs">
            {model.description}
          </ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions>
        {lifecycle ? (
          <Button
            variant="outline"
            size="sm"
            disabled={pending !== null || model.installed === false || model.busy === true}
            aria-busy={pending === model.id || undefined}
            onClick={onLifecycle}
          >
            {pending === model.id ? t.working : model.loaded ? t.unload : t.load}
          </Button>
        ) : copied ? (
          <output className="text-fg-muted text-ui-xs">{t.copied}</output>
        ) : (
          <IconButton icon={CopyIcon} label={fmt(t.copy, { id: model.id })} onClick={onCopy} />
        )}
      </ItemActions>
    </Item>
  )
}

function Models({ ext }: { ext: ExtensionInfo }): JSX.Element {
  const d = useDict()
  const t = d.assistantSettings
  const [result, setResult] = useState<AssistModelsResult | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    setResult(await window.pine.assist.models(ext.id))
  }, [ext.id])
  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(null), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])
  const inUse = new Set(
    [ext.settingValues.fastModel, ext.settingValues.chatModel].filter(
      (v): v is string => typeof v === 'string' && v !== '',
    ),
  )
  const lifecycle = result?.ok === true && result.lifecycle
  const listError = !result ? null : result.ok ? (result.error ?? null) : result.error
  const change = async (model: AssistModel): Promise<void> => {
    setPending(model.id)
    const res = await window.pine.assist.setModelLoaded(ext.id, model.id, !model.loaded)
    setPending(null)
    setError(res.ok ? null : res.error)
    await refresh()
  }
  return (
    <SettingsGroup
      title={t.models}
      desc={lifecycle ? t.modelsLifecycleDesc : t.modelsCopyDesc}
      action={
        <IconButton icon={ArrowClockwiseIcon} label={t.refresh} onClick={() => void refresh()} />
      }
    >
      {listError ? (
        <p role="alert" className="text-attn-fg text-ui-sm">
          {fmt(t.modelsFailed, { error: listError })}
        </p>
      ) : result?.ok && result.models.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{t.noModels}</p>
      ) : null}
      {result?.ok && result.models.length > 0 ? (
        <ul aria-label={t.models} className="flex flex-col gap-2">
          {result.models.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              lifecycle={result.lifecycle}
              inUse={inUse.has(model.id)}
              pending={pending}
              copied={copied === model.id}
              onLifecycle={() => void change(model)}
              onCopy={() =>
                void navigator.clipboard
                  ?.writeText(model.id)
                  .then(() => setCopied(model.id))
                  .catch(() => undefined)
              }
            />
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-attn-fg text-ui-sm">
          {error}
        </p>
      ) : null}
    </SettingsGroup>
  )
}

function ExtensionGroups({ ext }: { ext: ExtensionInfo }): JSX.Element {
  const d = useDict()
  const state = useAssistStore((s) => s.overview.find((o) => o.extId === ext.id))
  const omit = state?.features.map((f) => f.setting) ?? []
  const hasProvider = ext.settings.some((s) => !omit.includes(s.key)) || ext.secrets.length > 0
  return (
    <>
      {state ? <Features state={state} chat={ext.assist.includes('chat')} /> : null}
      {hasProvider ? (
        <SettingsGroup title={d.assistantSettings.provider}>
          <ExtensionSettingsForm ext={ext} omit={omit} bare />
        </SettingsGroup>
      ) : null}
      {state?.models ? (
        <Models key={`${state.label ?? ''}:${state.setup ?? ''}`} ext={ext} />
      ) : null}
    </>
  )
}

export function AssistantSection(): JSX.Element {
  const d = useDict()
  const list = useExtensionsStore((s) => s.list)
  const exts = list.filter((e) => e.enabled && isAssistExtension(e))
  const chat = exts.some((e) => e.assist.includes('chat'))
  return (
    <div>
      <SectionHead title={d.assistantSettings.title} desc={d.assistantSettings.desc} />
      {exts.length === 0 ? (
        <Empty className="mt-3 gap-3 rounded-md border border-line border-dashed p-6">
          <EmptyHeader className="gap-1">
            <EmptyTitle className="text-fg text-ui-base">{d.assistantSettings.offTitle}</EmptyTitle>
            <EmptyDescription className="text-fg-muted text-ui-sm">
              {d.assistantSettings.offDesc}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              size="sm"
              onClick={() =>
                useUIStore
                  .getState()
                  .openSettings('extensions', { extension: list.find(isAssistExtension)?.id })
              }
            >
              {d.assistantSettings.openExtensions}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          {exts.map((ext) => (
            <ExtensionGroups key={ext.id} ext={ext} />
          ))}
          {chat ? <ChatToolsSettings /> : null}
        </>
      )}
    </div>
  )
}
