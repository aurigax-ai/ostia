import { IconButton } from '@/components/common/IconButton'
import { DropdownMenu, MenuItem } from '@/components/common/Menu'
import { ControlRow, SettingsGroup } from '@/components/settings/SettingsPanel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemTitle } from '@/components/ui/item'
import { Switch } from '@/components/ui/switch'
import { fmt, useDict } from '@/i18n/useDict'
import { patchProvider, withModel, withProvider } from '@/lib/assist/assistProviders'
import { cn } from '@/lib/utils'
import { useAssistStore } from '@/stores/assistStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { PlusIcon, TrashIcon, XIcon } from '@phosphor-icons/react'
import type { AssistProviderConfig, AssistProviderKind, AssistProviderState } from '@shared/assist'
import { useEffect, useState } from 'react'

const CARD = 'rounded-md border-line px-3 py-2'

type KindOption = AssistProviderKind & { extId: string }

function saveProviders(providers: AssistProviderConfig[]): void {
  void useSettingsStore.getState().setAssistModels({ providers })
}

function currentProviders(): AssistProviderConfig[] {
  return useSettingsStore.getState().assistant.providers
}

export function providerStateKey(enabled: boolean, state: AssistProviderState | undefined): string {
  if (!enabled) return 'off'
  if (!state) return 'checking'
  return state.setup ?? 'ready'
}

function StateLine({
  stateKey,
  error,
}: {
  stateKey: string
  error?: string
}): JSX.Element {
  const d = useDict()
  const t = d.assistantSettings
  const dot =
    stateKey === 'ready'
      ? 'bg-ok'
      : stateKey === 'off' || stateKey === 'checking'
        ? 'bg-fg-dim'
        : 'bg-attn'
  return (
    <>
      <p className="flex items-center gap-1.5 text-fg-muted text-ui-xs">
        <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', dot)} />
        <output>{t.providerStates[stateKey] ?? stateKey}</output>
      </p>
      {error && stateKey !== 'ready' && stateKey !== 'off' ? (
        <p role="alert" className="break-words text-attn-fg text-ui-xs">
          {error}
        </p>
      ) : null}
    </>
  )
}

function CommittedInput({
  value,
  label,
  placeholder,
  mono,
  onCommit,
}: {
  value: string
  label: string
  placeholder?: string
  mono?: boolean
  onCommit: (value: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    if (draft.trim() !== value) onCommit(draft.trim())
  }
  return (
    <Input
      value={draft}
      aria-label={label}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
      className={cn('h-7 w-64 text-ui-sm', mono && 'font-mono')}
    />
  )
}

function KeyRow({
  config,
  kind,
  saved,
}: {
  config: AssistProviderConfig
  kind: AssistProviderKind | undefined
  saved: boolean
}): JSX.Element {
  const d = useDict()
  const t = d.assistantSettings
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const label = fmt(t.apiKeyFor, { name: config.name })
  const store = (value: string | null): void => {
    void window.ostia.assist.setProviderKey(config.id, value).then((res) => {
      setError(res.ok ? null : res.error)
      if (res.ok) setDraft('')
    })
  }
  return (
    <ControlRow
      label={t.apiKey}
      labelHint={
        <span className={saved ? 'text-fg text-ui-xs' : 'text-fg-muted text-ui-xs'}>
          {saved ? t.keySet : t.keyUnset}
        </span>
      }
      desc={kind?.key === 'required' ? t.keyRequired : t.keyOptional}
      error={error ? fmt(t.keyError, { error }) : null}
    >
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (draft) store(draft)
        }}
      >
        <Input
          type="password"
          value={draft}
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
          placeholder={t.keyPlaceholder}
          onChange={(e) => setDraft(e.target.value)}
          className="h-7 w-44 font-mono text-ui-sm"
        />
        <Button type="submit" variant="outline" size="sm" disabled={!draft}>
          {t.keySave}
        </Button>
        {saved ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => store(null)}>
            {t.keyClear}
          </Button>
        ) : null}
      </form>
    </ControlRow>
  )
}

function AddModel({
  config,
  onAdd,
}: {
  config: AssistProviderConfig
  onAdd: (id: string) => void
}): JSX.Element {
  const d = useDict()
  const t = d.assistantSettings
  const [text, setText] = useState('')
  const [listed, setListed] = useState<string[]>([])
  const load = (): void => {
    void window.ostia.assist.models(config.extId, config.id).then(
      (res) => setListed(res.ok ? res.models.map((m) => m.id) : []),
      () => setListed([]),
    )
  }
  const typed = text.trim()
  const offered = listed.filter((id) => !config.models.includes(id))
  const items = typed && !offered.includes(typed) ? [typed, ...offered] : offered
  return (
    <Combobox
      items={items}
      value={null}
      inputValue={text}
      autoHighlight
      onInputValueChange={(value, details) => {
        if (details.reason === 'input-change' || details.reason === 'input-clear') setText(value)
      }}
      onValueChange={(value) => {
        if (typeof value !== 'string' || !value) return
        onAdd(value)
        setText('')
      }}
      onOpenChange={(open) => {
        if (open) load()
      }}
    >
      <ComboboxInput
        aria-label={fmt(t.modelId, { name: config.name })}
        placeholder={t.modelPlaceholder}
        className="h-7 w-64 font-mono"
      />
      <ComboboxContent>
        <ComboboxEmpty>{t.modelNoMatch}</ComboboxEmpty>
        <ComboboxList>
          {(id: string) => (
            <ComboboxItem key={id} value={id} className="font-mono">
              {id === typed && !offered.includes(id) ? fmt(t.modelUseTyped, { id }) : id}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

function ProviderModels({ config }: { config: AssistProviderConfig }): JSX.Element {
  const d = useDict()
  const t = d.assistantSettings
  const setModels = (models: string[]): void =>
    saveProviders(patchProvider(currentProviders(), config.id, { models }))
  return (
    <ControlRow label={t.providerModels} desc={t.providerModelsDesc}>
      <div className="flex w-64 flex-col items-stretch gap-1.5">
        {config.models.length === 0 ? (
          <p className="text-fg-muted text-ui-xs">{t.noProviderModels}</p>
        ) : (
          <ul aria-label={fmt(t.modelsFor, { name: config.name })} className="flex flex-col">
            {config.models.map((id) => (
              <li key={id} className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate font-mono text-fg text-ui-sm">{id}</span>
                <IconButton
                  icon={XIcon}
                  label={fmt(t.removeModel, { id })}
                  onClick={() => setModels(config.models.filter((m) => m !== id))}
                />
              </li>
            ))}
          </ul>
        )}
        <AddModel
          config={config}
          onAdd={(id) => {
            const next = withModel(config.models, id)
            if (next) setModels(next)
          }}
        />
      </div>
    </ControlRow>
  )
}

function ProviderCard({
  config,
  state,
  kind,
  keySaved,
  onRemove,
}: {
  config: AssistProviderConfig
  state: AssistProviderState | undefined
  kind: AssistProviderKind | undefined
  keySaved: boolean
  onRemove: () => void
}): JSX.Element {
  const d = useDict()
  const t = d.assistantSettings
  const patch = (change: Parameters<typeof patchProvider>[2]): void =>
    saveProviders(patchProvider(currentProviders(), config.id, change))
  return (
    <Item
      variant="outline"
      size="sm"
      render={<li />}
      className={CARD}
      data-provider={config.id}
      aria-label={config.name}
    >
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="text-fg text-ui-base">
          {config.name}
          <Badge variant="outline" className="font-normal text-fg-muted text-ui-xs">
            {kind?.title ?? config.kind}
          </Badge>
        </ItemTitle>
        <StateLine stateKey={providerStateKey(config.enabled, state)} error={state?.lastError} />
      </ItemContent>
      <ItemActions className="self-start">
        <Switch
          checked={config.enabled}
          aria-label={fmt(t.useProvider, { name: config.name })}
          onCheckedChange={(enabled) => patch({ enabled })}
        />
        <IconButton
          icon={TrashIcon}
          label={fmt(t.removeProvider, { name: config.name })}
          className="hover:text-attn-fg"
          onClick={onRemove}
        />
      </ItemActions>
      <div className="flex basis-full flex-col">
        <ControlRow label={t.providerName}>
          <CommittedInput
            value={config.name}
            label={fmt(t.providerNameFor, { name: config.name })}
            onCommit={(name) => {
              if (name) patch({ name })
            }}
          />
        </ControlRow>
        <ControlRow
          label={t.baseUrl}
          desc={kind?.baseUrl ? fmt(t.baseUrlDefault, { url: kind.baseUrl }) : t.baseUrlRequired}
        >
          <CommittedInput
            value={config.baseUrl}
            label={fmt(t.baseUrlFor, { name: config.name })}
            placeholder={kind?.baseUrl}
            mono
            onCommit={(baseUrl) => patch({ baseUrl })}
          />
        </ControlRow>
        <KeyRow config={config} kind={kind} saved={keySaved} />
        <ProviderModels config={config} />
      </div>
    </Item>
  )
}

function FixedProviderCard({
  state,
  extName,
}: {
  state: AssistProviderState
  extName: string
}): JSX.Element {
  const d = useDict()
  const t = d.assistantSettings
  return (
    <Item
      variant="outline"
      size="sm"
      render={<li />}
      className={CARD}
      data-provider={state.id}
      aria-label={state.name}
    >
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="text-fg text-ui-base">
          {state.name}
          <Badge variant="outline" className="font-normal text-fg-muted text-ui-xs">
            {fmt(t.fromExtension, { name: extName })}
          </Badge>
        </ItemTitle>
        <StateLine stateKey={providerStateKey(true, state)} error={state.lastError} />
        {state.models.length > 0 ? (
          <p className="truncate font-mono text-fg-muted text-ui-xs">
            {state.models.map((m) => m.id).join(', ')}
          </p>
        ) : null}
      </ItemContent>
    </Item>
  )
}

export function AssistantProviders(): JSX.Element {
  const d = useDict()
  const t = d.assistantSettings
  const providers = useSettingsStore((s) => s.assistant.providers)
  const overview = useAssistStore((s) => s.overview)
  const [removing, setRemoving] = useState<AssistProviderConfig | null>(null)
  const kinds: KindOption[] = overview.flatMap((ext) =>
    ext.kinds.map((kind) => ({ ...kind, extId: ext.extId })),
  )
  const fixed = overview.flatMap((ext) =>
    ext.providers
      .filter((p) => !providers.some((c) => c.extId === ext.extId && c.id === p.id))
      .map((state) => ({ state, extName: ext.name })),
  )
  const add = (kind: KindOption): void => {
    const next = withProvider(currentProviders(), kind.extId, kind)
    if (next) saveProviders(next)
  }
  const addMenu =
    kinds.length > 0 ? (
      <DropdownMenu
        trigger={
          <Button variant="outline" size="sm">
            <PlusIcon />
            {t.addProvider}
          </Button>
        }
      >
        {kinds.map((kind) => (
          <MenuItem key={`${kind.extId}:${kind.id}`} onClick={() => add(kind)}>
            {kind.title}
          </MenuItem>
        ))}
      </DropdownMenu>
    ) : null
  return (
    <SettingsGroup title={t.providers} desc={t.providersDesc} action={addMenu}>
      {providers.length === 0 && fixed.length === 0 ? (
        <Empty className="gap-3 rounded-md border border-line border-dashed p-5">
          <EmptyHeader className="gap-1">
            <EmptyTitle className="text-fg text-ui-base">{t.noProviders}</EmptyTitle>
            <EmptyDescription className="text-fg-muted text-ui-sm">
              {t.noProvidersDesc}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul aria-label={t.providers} className="flex flex-col gap-2">
          {providers.map((config) => {
            const ext = overview.find((o) => o.extId === config.extId)
            return (
              <ProviderCard
                key={config.id}
                config={config}
                state={ext?.providers.find((p) => p.id === config.id)}
                kind={ext?.kinds.find((k) => k.id === config.kind)}
                keySaved={ext?.keysSet.includes(config.id) ?? false}
                onRemove={() => setRemoving(config)}
              />
            )
          })}
          {fixed.map(({ state, extName }) => (
            <FixedProviderCard key={`${extName}:${state.id}`} state={state} extName={extName} />
          ))}
        </ul>
      )}
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{fmt(t.removeTitle, { name: removing?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t.removeBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRemoving(null)}>
              {t.cancel}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                const id = removing?.id
                setRemoving(null)
                if (id) saveProviders(currentProviders().filter((p) => p.id !== id))
              }}
            >
              {t.remove}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  )
}
