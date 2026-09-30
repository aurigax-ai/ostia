import {
  ChatCircleDotsIcon,
  ChatCircleTextIcon,
  CubeIcon,
  GearSixIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import type { AssistExtensionState, AssistFeatureState } from '@shared/assist'
import { useState, useSyncExternalStore } from 'react'
import { commands } from '../commands/registry'
import { fmt, useDict } from '../i18n/useDict'
import { toggleAssistFeature } from '../lib/assistToggle'
import { openChatPane } from '../lib/chatPane'
import { useChordLabel } from '../lib/chords'
import { isMac } from '../platform'
import { useAssistStore } from '../stores/assistStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useUIStore } from '../stores/uiStore'
import { IconButton } from './IconButton'
import { Button } from './ui/button'
import { Kbd } from './ui/kbd'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Separator } from './ui/separator'
import { Switch } from './ui/switch'

const subscribeCommands = (cb: () => void): (() => void) => commands.subscribe(cb)
const commandsVersion = (): number => commands.version()

export function useAssistMenuVisible(): boolean {
  return useExtensionsStore((s) => s.list.some((e) => e.enabled && e.assist.length > 0))
}

function openPluginSettings(): void {
  useUIStore.getState().openSettingsAt('plugins')
}

export function AssistantMenu(): JSX.Element | null {
  const d = useDict()
  const visible = useAssistMenuVisible()
  const overview = useAssistStore((s) => s.overview)
  const chatReady = useAssistStore((s) => Boolean(s.availability.chat))
  const chatKeys = useChordLabel('assist.chat', isMac)
  const [open, setOpen] = useState(false)
  if (!visible) return null
  const label = chatKeys ? `${d.assistMenu.button} (${chatKeys})` : d.assistMenu.button
  const close = (): void => setOpen(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<IconButton size="bar" icon={ChatCircleDotsIcon} label={label} />} />
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
              <ExtensionPanel
                key={ext.extId}
                ext={ext}
                chatReady={chatReady}
                chatKeys={chatKeys}
                onDone={close}
              />
            ),
          )
        )}
      </PopoverContent>
    </Popover>
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
          openPluginSettings()
          onDone()
        }}
      >
        <GearSixIcon />
        {d.assistMenu.setUp}
      </Button>
    </div>
  )
}

function ExtensionPanel({
  ext,
  chatReady,
  chatKeys,
  onDone,
}: {
  ext: AssistExtensionState
  chatReady: boolean
  chatKeys: string | null
  onDone: () => void
}): JSX.Element {
  const d = useDict()
  useSyncExternalStore(subscribeCommands, commandsVersion)
  const modelsCommand = `${ext.extId}.open`
  const hasModels = commands.has(modelsCommand)
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
        <div className="truncate px-1.5 font-mono text-fg-muted text-ui-xs" title={ext.label}>
          {ext.label}
        </div>
      ) : null}
      {ext.lastError ? (
        <p className="flex items-start gap-1 px-1.5 text-attn-fg text-ui-xs">
          <WarningCircleIcon aria-hidden className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            {fmt(d.assistMenu.lastError, { error: ext.lastError })}
          </span>
        </p>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="mt-1 justify-start"
        disabled={!chatReady}
        title={chatReady ? undefined : d.assistMenu.chatUnavailable}
        onClick={() => {
          openChatPane()
          onDone()
        }}
      >
        <ChatCircleTextIcon />
        <span className="flex-1 text-left">{d.assistMenu.openChat}</span>
        {chatKeys ? <Kbd className="font-mono">{chatKeys}</Kbd> : null}
      </Button>
      {chatReady ? null : (
        <p className="px-1.5 text-fg-muted text-ui-xs">{d.assistMenu.chatUnavailable}</p>
      )}
      <Separator className="my-1" />
      <div className="px-1.5 text-fg-muted text-ui-xs">{d.assistMenu.features}</div>
      <ul aria-label={d.assistMenu.features} className="flex flex-col">
        {ext.features.map((feature) => (
          <FeatureRow key={feature.id} extId={ext.extId} feature={feature} />
        ))}
      </ul>
      <Separator className="my-1" />
      <Button
        variant="ghost"
        size="sm"
        className="justify-start"
        onClick={() => {
          openPluginSettings()
          onDone()
        }}
      >
        <GearSixIcon />
        {d.assistMenu.settings}
      </Button>
      {hasModels ? (
        <Button
          variant="ghost"
          size="sm"
          className="justify-start"
          onClick={() => {
            void commands.exec(modelsCommand)
            onDone()
          }}
        >
          <CubeIcon />
          {d.assistMenu.models}
        </Button>
      ) : null}
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
    <li className="flex h-7 items-center gap-2 rounded-sm px-1.5 hover:bg-fg/6">
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
