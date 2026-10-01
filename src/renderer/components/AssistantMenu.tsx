import {
  CaretDownIcon,
  ChatCircleDotsIcon,
  GearSixIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import type { AssistExtensionState, AssistFeatureState } from '@shared/assist'
import { useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { toggleAssistFeature, useChatAvailable } from '../lib/assistFeatures'
import { openChatPane } from '../lib/chatPane'
import { useChordLabel } from '../lib/chords'
import { isMac } from '../platform'
import { useAssistStore } from '../stores/assistStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useUIStore } from '../stores/uiStore'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { Button } from './ui/button'
import { ButtonGroup } from './ui/button-group'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Separator } from './ui/separator'
import { Switch } from './ui/switch'

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
  const chatReady = useChatAvailable()
  const chatKeys = useChordLabel('assist.chat', isMac)
  const [open, setOpen] = useState(false)
  if (!visible) return null
  const chatLabel = chatKeys ? `${d.assistMenu.openChat} (${chatKeys})` : d.assistMenu.openChat
  const close = (): void => setOpen(false)
  return (
    <ButtonGroup aria-label={d.assistMenu.title} className="topbar-split rounded-sm">
      <IconButton
        size="bar"
        icon={ChatCircleDotsIcon}
        label={chatLabel}
        className="rounded-r-none"
        onClick={() => {
          if (chatReady) openChatPane()
          else setOpen(true)
        }}
      />
      <Popover open={open} onOpenChange={setOpen}>
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
          {overview.length === 0 ? (
            <SetupPanel reason={null} onDone={close} />
          ) : (
            overview.map((ext) =>
              ext.setup ? (
                <SetupPanel
                  key={ext.extId}
                  reason={d.assistMenu.setup[ext.setup] ?? null}
                  onDone={close}
                />
              ) : (
                <ExtensionPanel key={ext.extId} ext={ext} />
              ),
            )
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

function ExtensionPanel({ ext }: { ext: AssistExtensionState }): JSX.Element {
  const d = useDict()
  const anyReady = ext.features.some((f) => f.on && f.ready)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 px-1.5 pt-0.5">
        <span className="font-medium text-fg text-ui-sm">{ext.name}</span>
        <span className="text-fg-muted text-ui-xs">
          {anyReady ? d.assistMenu.ready : d.assistMenu.notReady}
        </span>
      </div>
      {ext.label ? (
        <Hint label={ext.label}>
          <div className="truncate px-1.5 font-mono text-fg-muted text-ui-xs">{ext.label}</div>
        </Hint>
      ) : null}
      {ext.lastError ? (
        <p className="flex items-start gap-1 px-1.5 text-attn-fg text-ui-xs">
          <WarningCircleIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 break-words">
            {fmt(d.assistMenu.lastError, { error: ext.lastError })}
          </span>
        </p>
      ) : null}
      <Separator className="my-1" />
      <div className="px-1.5 text-fg-muted text-ui-xs">{d.assistMenu.features}</div>
      <ul aria-label={d.assistMenu.features} className="flex flex-col">
        {ext.features.map((feature) => (
          <FeatureRow key={feature.id} extId={ext.extId} feature={feature} />
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
