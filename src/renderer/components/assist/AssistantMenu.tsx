import { Hint } from '@/components/common/Hint'
import { IconButton } from '@/components/common/IconButton'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { fmt, useDict } from '@/i18n/useDict'
import { featuresInUse, toggleAssistFeature, useChatAvailable } from '@/lib/assistFeatures'
import { openChatPane } from '@/lib/chatPane'
import { useChordLabel } from '@/lib/chords'
import { isMac } from '@/platform'
import { useAssistStore, wakeAssist } from '@/stores/assistStore'
import { useExtensionsStore } from '@/stores/extensionsStore'
import { useUIStore } from '@/stores/uiStore'
import {
  CaretDownIcon,
  ChatCircleDotsIcon,
  GearSixIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import {
  type AssistCatalog,
  type AssistFeatureState,
  type AssistModelClass,
  choiceLabel,
  sameModelRef,
} from '@shared/assist'
import { useState } from 'react'

export function useAssistMenuVisible(): boolean {
  return useExtensionsStore((s) => s.list.some((e) => e.enabled && e.assist.length > 0))
}

function openAssistantSettings(): void {
  useUIStore.getState().openSettings('assistant')
}

export function AssistantMenu(): JSX.Element | null {
  const d = useDict()
  const visible = useAssistMenuVisible()
  const overview = useAssistStore((s) => s.overview)
  const catalog = useAssistStore((s) => s.catalog)
  const chatReady = useChatAvailable()
  const chatKeys = useChordLabel('assist.chat', isMac)
  const [open, setOpen] = useState(false)
  if (!visible) return null
  const chatLabel = chatKeys
    ? fmt(d.assistMenu.openChatKeys, { keys: chatKeys })
    : d.assistMenu.openChat
  const close = (): void => setOpen(false)
  const toggle = (next: boolean): void => {
    if (next) wakeAssist()
    setOpen(next)
  }
  return (
    <ButtonGroup aria-label={d.assistMenu.title} className="topbar-split rounded-sm">
      <IconButton
        size="bar"
        icon={ChatCircleDotsIcon}
        label={chatLabel}
        className="rounded-r-none"
        onClick={() => {
          if (chatReady) openChatPane()
          else toggle(true)
        }}
      />
      <Popover open={open} onOpenChange={toggle}>
        <PopoverTrigger
          render={
            <IconButton
              size="bar"
              icon={CaretDownIcon}
              label={d.assistMenu.button}
              className="topbar-split-caret w-4 rounded-l-none"
            />
          }
        />
        <PopoverContent align="end" className="assist-menu" aria-label={d.assistMenu.title}>
          {catalog.models.length === 0 ? (
            <SetupPanel
              reason={d.assistMenu.setup[overview.find((ext) => ext.setup)?.setup ?? ''] ?? null}
              onDone={close}
            />
          ) : (
            <ModelsPanel />
          )}
        </PopoverContent>
      </Popover>
    </ButtonGroup>
  )
}

function SetupPanel({ reason, onDone }: { reason: string | null; onDone: () => void }) {
  const d = useDict()
  return (
    <div className="flex flex-col gap-2 p-1">
      <div className="font-medium text-fg text-ui-sm">{d.assistMenu.title}</div>
      {reason ? <p className="text-fg-muted text-ui-sm">{reason}</p> : null}
      <Button
        size="sm"
        onClick={() => {
          openAssistantSettings()
          onDone()
        }}
      >
        <GearSixIcon />
        {d.assistMenu.setUp}
      </Button>
    </div>
  )
}

function modelLabel(catalog: AssistCatalog, modelClass: AssistModelClass): string | null {
  const choice = catalog.models.find((c) => sameModelRef(c.ref, catalog[modelClass]))
  return choice ? choiceLabel(choice) : null
}

function ModelLine({ title, label }: { title: string; label: string | null }): JSX.Element {
  const d = useDict()
  const shown = label ?? d.assistMenu.noModel
  return (
    <div className="flex items-baseline gap-2 px-1.5">
      <span className="shrink-0 text-fg-muted text-ui-xs">{title}</span>
      <Hint label={shown}>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-fg text-ui-xs">
          {shown}
        </span>
      </Hint>
    </div>
  )
}

function ModelsPanel(): JSX.Element {
  const d = useDict()
  const overview = useAssistStore((s) => s.overview)
  const catalog = useAssistStore((s) => s.catalog)
  const features = featuresInUse({ overview, catalog })
  const lastError = overview.find((ext) => ext.lastError)?.lastError
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 px-1.5 pt-0.5">
        <span className="font-medium text-fg text-ui-sm">{d.assistMenu.title}</span>
        <span className="text-fg-muted text-ui-xs">
          {features.some((f) => f.feature.on && f.feature.ready)
            ? d.assistMenu.ready
            : d.assistMenu.notReady}
        </span>
      </div>
      <ModelLine title={d.assistMenu.chatModel} label={modelLabel(catalog, 'chat')} />
      <ModelLine title={d.assistMenu.fastModel} label={modelLabel(catalog, 'fast')} />
      {lastError ? (
        <p className="flex items-start gap-1 px-1.5 text-attn-fg text-ui-xs">
          <WarningCircleIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 break-words">
            {fmt(d.assistMenu.lastError, { error: lastError })}
          </span>
        </p>
      ) : null}
      <Separator className="my-1" />
      <div className="px-1.5 text-fg-muted text-ui-xs">{d.assistMenu.features}</div>
      <ul aria-label={d.assistMenu.features} className="flex flex-col">
        {features.map(({ extId, feature }) => (
          <FeatureRow key={feature.id} extId={extId} feature={feature} />
        ))}
      </ul>
    </div>
  )
}

function FeatureRow({
  extId,
  feature,
}: {
  extId: string
  feature: AssistFeatureState
}): JSX.Element {
  const d = useDict()
  const name = d.assistMenu.feature[feature.id] ?? feature.id
  const state = !feature.on
    ? d.assistMenu.off
    : feature.ready
      ? d.assistMenu.ready
      : d.assistMenu.notReady
  return (
    <li className="flex h-7 items-center gap-2 rounded-sm px-1.5">
      <span className="min-w-0 flex-1 truncate text-fg text-ui-sm">{name}</span>
      <span className="text-fg-muted text-ui-xs">{state}</span>
      <Switch
        size="sm"
        checked={feature.on}
        aria-label={name}
        onCheckedChange={() => void toggleAssistFeature(extId, feature)}
      />
    </li>
  )
}
