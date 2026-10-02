import { ArrowClockwiseIcon } from '@phosphor-icons/react'
import {
  type AssistFeatureId,
  type AssistFeatureState,
  type AssistModel,
  type AssistModelChoice,
  type AssistModelClass,
  type AssistModelRef,
  type AssistModelsResult,
  type AssistUi,
  choiceLabel,
  modelClassOf,
  modelRefKey,
  sameModelRef,
} from '@shared/assist'
import type { ExtensionInfo } from '@shared/extensions'
import { useCallback, useEffect, useState } from 'react'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import { featuresInUse, toggleAssistFeature } from '../lib/assistFeatures'
import { openAssistUi } from '../lib/assistUi'
import { useChordLabel } from '../lib/chords'
import { isMac } from '../platform'
import { useAssistStore } from '../stores/assistStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { AssistantProviders } from './AssistantProviders'
import { ChatToolsSettings } from './ChatToolsSettings'
import { ExtensionSettingsForm } from './ExtensionSettingsForm'
import { IconButton } from './IconButton'
import { ControlRow, SectionHead, SettingsGroup, ToggleRow } from './SettingsPanel'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from './ui/item'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from './ui/select'
import { Switch } from './ui/switch'

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

function offersClass(ext: ExtensionInfo | undefined, modelClass: AssistModelClass): boolean {
  return ext?.assist.some((point) => modelClassOf(point) === modelClass) ?? false
}

function groupedChoices(
  choices: AssistModelChoice[],
): { group: string; items: AssistModelChoice[] }[] {
  const out: { group: string; items: AssistModelChoice[] }[] = []
  for (const choice of choices) {
    const last = out.find((g) => g.group === choice.group)
    if (last) last.items.push(choice)
    else out.push({ group: choice.group, items: [choice] })
  }
  return out
}

function ModelField({
  modelClass,
  label,
}: {
  modelClass: AssistModelClass
  label: string
}): JSX.Element {
  const d = useDict()
  const catalog = useAssistStore((s) => s.catalog)
  const list = useExtensionsStore((s) => s.list)
  const choices = catalog.models.filter((choice) =>
    offersClass(
      list.find((e) => e.id === choice.ref.extId),
      modelClass,
    ),
  )
  const selected = catalog[modelClass]
  const wanted = useSettingsStore((s) =>
    modelClass === 'chat' ? s.assistant.chatModel : s.assistant.fastModel,
  )
  const current = choices.find((c) => sameModelRef(c.ref, selected))
  if (choices.length === 0) {
    return <span className="text-fg-muted text-ui-sm">{d.assistantSettings.noModelYet}</span>
  }
  const shown = current
    ? choiceLabel(current)
    : fmt(d.assistantSettings.modelGone, { model: wanted?.model ?? wanted?.extId ?? '' })
  const pick = (key: string): void => {
    const ref: AssistModelRef | undefined = choices.find((c) => modelRefKey(c.ref) === key)?.ref
    if (!ref) return
    void useSettingsStore
      .getState()
      .setAssistModels(modelClass === 'chat' ? { chatModel: ref } : { fastModel: ref })
  }
  return (
    <Select
      value={current ? modelRefKey(current.ref) : null}
      onValueChange={(v) => pick(v as string)}
    >
      <SelectTrigger
        size="sm"
        aria-label={label}
        aria-invalid={current ? undefined : true}
        className="w-fit min-w-44 max-w-80"
      >
        <span className="min-w-0 truncate">{shown}</span>
      </SelectTrigger>
      <SelectContent>
        {groupedChoices(choices).map(({ group, items }) => (
          <SelectGroup key={group}>
            <SelectLabel>{group}</SelectLabel>
            {items.map((choice) => (
              <SelectItem key={modelRefKey(choice.ref)} value={modelRefKey(choice.ref)}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

function ModelsInUse(): JSX.Element {
  const d = useDict()
  const t = d.assistantSettings
  return (
    <SettingsGroup title={t.inUseTitle} desc={t.inUseDesc}>
      <ControlRow label={t.chatModel} desc={t.chatModelDesc}>
        <ModelField modelClass="chat" label={t.chatModel} />
      </ControlRow>
      <ControlRow label={t.fastModel} desc={t.fastModelDesc}>
        <ModelField modelClass="fast" label={t.fastModel} />
      </ControlRow>
    </SettingsGroup>
  )
}

function FeatureRow({
  extId,
  feature,
  model,
  keys,
}: {
  extId: string
  feature: AssistFeatureState
  model: string
  keys: Chords
}): JSX.Element {
  const d = useDict()
  const name = d.assistMenu.feature[feature.id] ?? feature.id
  const hints = [
    fmt(d.assistantSettings.featureModel, { model }),
    ...featureHints(d, feature.id, keys),
  ]
  const ui = TRY_UI[feature.id]
  return (
    <div className="flex items-start justify-between gap-6 py-1.5" data-feature={feature.id}>
      <div className="min-w-0">
        <div className="text-fg text-ui-base">{name}</div>
        <p className="mt-0.5 text-fg-muted text-ui-sm">
          {d.assistantSettings.featureDesc[feature.id]}
        </p>
        <p className="mt-0.5 text-fg-muted text-ui-xs">{hints.join(' · ')}</p>
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
              useUIStore.getState().showWorkspaces()
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

function Features({ chat }: { chat: boolean }): JSX.Element {
  const d = useDict()
  const overview = useAssistStore((s) => s.overview)
  const catalog = useAssistStore((s) => s.catalog)
  const history = useSettingsStore((s) => s.assistant.chatHistory)
  const keys: Chords = {
    chat: useChordLabel('assist.chat', isMac),
    ask: useChordLabel('palette.toggle', isMac),
    compose: useChordLabel('assist.compose', isMac),
  }
  const rows = featuresInUse({ overview, catalog })
  return (
    <SettingsGroup title={d.assistantSettings.features}>
      {rows.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{d.assistantSettings.featuresNeedModel}</p>
      ) : (
        rows.map((row) => (
          <FeatureRow
            key={row.feature.id}
            extId={row.extId}
            feature={row.feature}
            model={row.model}
            keys={keys}
          />
        ))
      )}
      {chat ? (
        <ToggleRow
          label={d.chat.saveHistory}
          desc={d.assistantSettings.saveHistoryDesc}
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
  inUse,
  pending,
  onLifecycle,
}: {
  model: AssistModel
  inUse: boolean
  pending: string | null
  onLifecycle: () => void
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
        <ItemDescription className="text-fg-muted text-ui-xs">
          {[model.name, modelState(d, model)].filter(Boolean).join(' · ')}
        </ItemDescription>
        {model.description ? (
          <ItemDescription className="text-fg-muted text-ui-xs">
            {model.description}
          </ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions>
        <Button
          variant="outline"
          size="sm"
          disabled={pending !== null || model.installed === false || model.busy === true}
          aria-busy={pending === model.id || undefined}
          onClick={onLifecycle}
        >
          {pending === model.id ? t.working : model.loaded ? t.unload : t.load}
        </Button>
      </ItemActions>
    </Item>
  )
}

function LifecycleModels({
  extId,
  providerId,
  name,
}: {
  extId: string
  providerId: string
  name: string
}): JSX.Element {
  const d = useDict()
  const t = d.assistantSettings
  const catalog = useAssistStore((s) => s.catalog)
  const [result, setResult] = useState<AssistModelsResult | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    setResult(await window.pine.assist.models(extId, providerId))
  }, [extId, providerId])
  useEffect(() => {
    void refresh()
  }, [refresh])
  const inUse = new Set(
    [catalog.chat, catalog.fast]
      .filter((ref) => ref?.extId === extId && ref.provider === providerId)
      .map((ref) => ref?.model),
  )
  const listError = !result ? null : result.ok ? (result.error ?? null) : result.error
  const change = async (model: AssistModel): Promise<void> => {
    setPending(model.id)
    const res = await window.pine.assist.setModelLoaded(extId, model.id, !model.loaded, providerId)
    setPending(null)
    setError(res.ok ? null : res.error)
    await refresh()
  }
  return (
    <SettingsGroup
      title={fmt(t.modelsFor, { name })}
      desc={t.modelsLifecycleDesc}
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
        <ul aria-label={fmt(t.modelsFor, { name })} className="flex flex-col gap-2">
          {result.models.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              inUse={inUse.has(model.id)}
              pending={pending}
              onLifecycle={() => void change(model)}
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
  const hasOwn = ext.settings.some((s) => !omit.includes(s.key)) || ext.secrets.length > 0
  return (
    <>
      {hasOwn ? (
        <SettingsGroup title={fmt(d.assistantSettings.fromExtension, { name: ext.name })}>
          <ExtensionSettingsForm ext={ext} omit={omit} bare />
        </SettingsGroup>
      ) : null}
      {state?.providers
        .filter((provider) => provider.lifecycle)
        .map((provider) => (
          <LifecycleModels
            key={`${provider.id}:${provider.setup ?? ''}`}
            extId={ext.id}
            providerId={provider.id}
            name={provider.name}
          />
        ))}
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
          <ModelsInUse />
          <Features chat={chat} />
          <AssistantProviders />
          {exts.map((ext) => (
            <ExtensionGroups key={ext.id} ext={ext} />
          ))}
          {chat ? <ChatToolsSettings /> : null}
        </>
      )}
    </div>
  )
}
