import { Hint } from '@/components/common/Hint'
import { DropdownMenu, MenuItem, MenuLabel, MenuRadioItem } from '@/components/common/Menu'
import { Button } from '@/components/ui/button'
import {
  ContextMenuGroup,
  ContextMenuRadioGroup,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { fmt, useDict } from '@/i18n/useDict'
import { CHAT_MODES, type ChatMode } from '@/lib/assist/chatToolPermissions'
import { cn } from '@/lib/utils'
import { chatChoices, useAssistStore, useChatModel } from '@/stores/assistStore'
import { setSessionModel, useChatStore } from '@/stores/chatStore'
import { useChatMode, useChatToolsStore } from '@/stores/chatToolsStore'
import { useUIStore } from '@/stores/uiStore'
import {
  CaretDownIcon,
  ChatCircleIcon,
  CubeIcon,
  GearSixIcon,
  type Icon,
  PencilSimpleIcon,
} from '@phosphor-icons/react'
import { type AssistModelChoice, type AssistModelRef, modelRefKey } from '@shared/assist'
import { useMemo } from 'react'

const TRIGGER = 'h-6 gap-1 px-1.5 text-ui-xs'

const MODE_ICONS: Record<ChatMode, Icon> = { ask: ChatCircleIcon, write: PencilSimpleIcon }

export function openAssistantSettings(): void {
  useUIStore.getState().closePalette()
  useUIStore.getState().openSettings('assistant')
}

export function ChatModeSelect({ sessionId }: { sessionId: string }): JSX.Element {
  const d = useDict()
  const mode = useChatMode(sessionId)
  const ModeIcon = MODE_ICONS[mode]
  const name = d.chat.modes[mode].name
  return (
    <DropdownMenu
      side="top"
      className="w-72"
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={fmt(d.chat.modeNow, { mode: name })}
          data-mode={mode}
          className={cn(
            TRIGGER,
            'chat-mode-trigger shrink-0',
            mode === 'write' ? 'font-medium text-fg' : 'text-fg-muted',
          )}
        >
          <ModeIcon aria-hidden />
          <span className="@max-3xs:hidden">{name}</span>
          <CaretDownIcon aria-hidden className="size-3 @max-3xs:hidden" />
        </Button>
      }
    >
      <ContextMenuGroup>
        <MenuLabel>{d.chat.mode}</MenuLabel>
      </ContextMenuGroup>
      <ContextMenuRadioGroup
        value={mode}
        onValueChange={(value) =>
          useChatToolsStore.getState().setMode(sessionId, value as ChatMode)
        }
      >
        {CHAT_MODES.map((value) => (
          <MenuRadioItem
            key={value}
            value={value}
            closeOnClick
            leading={<ModeLeading mode={value} />}
            className="h-auto items-start py-1.5"
          >
            <span className="flex flex-col gap-0.5">
              <span className="text-fg">{d.chat.modes[value].name}</span>
              <span className="whitespace-normal text-fg-muted text-ui-xs">
                {d.chat.modes[value].desc}
              </span>
            </span>
          </MenuRadioItem>
        ))}
      </ContextMenuRadioGroup>
    </DropdownMenu>
  )
}

function ModeLeading({ mode }: { mode: ChatMode }): JSX.Element {
  const ModeIcon = MODE_ICONS[mode]
  return <ModeIcon className="size-3.5 text-fg-muted" />
}

function grouped(choices: AssistModelChoice[]): { group: string; items: AssistModelChoice[] }[] {
  const out: { group: string; items: AssistModelChoice[] }[] = []
  for (const choice of choices) {
    const last = out.find((g) => g.group === choice.group)
    if (last) last.items.push(choice)
    else out.push({ group: choice.group, items: [choice] })
  }
  return out
}

export function ChatModelSelect({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const d = useDict()
  const wanted = useChatStore((s) => s.meta[sessionId]?.modelRef)
  const current = useChatModel(wanted)
  const catalog = useAssistStore((s) => s.catalog)
  const groups = useMemo(() => grouped(chatChoices(catalog)), [catalog])
  const refs = useMemo(() => {
    const byKey = new Map<string, AssistModelRef>()
    for (const choice of chatChoices(catalog)) byKey.set(modelRefKey(choice.ref), choice.ref)
    return byKey
  }, [catalog])
  const label = current ? (current.label ?? current.name) : d.chat.noModel
  const short = current?.ref.model ?? label
  return (
    <DropdownMenu
      side="top"
      className="max-w-96"
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={fmt(d.chat.modelNow, { model: label })}
          className={cn(TRIGGER, 'chat-model-trigger min-w-0 max-w-48 shrink text-fg-muted')}
        >
          <CubeIcon aria-hidden />
          <Hint label={label}>
            <span className="min-w-0 truncate">{short}</span>
          </Hint>
          <CaretDownIcon aria-hidden className="size-3 @max-3xs:hidden" />
        </Button>
      }
    >
      <ContextMenuRadioGroup
        value={current ? modelRefKey(current.ref) : ''}
        onValueChange={(value) => {
          const ref = refs.get(value as string)
          if (ref) setSessionModel(sessionId, ref)
        }}
      >
        {groups.map(({ group, items }) => (
          <ContextMenuGroup key={group}>
            <MenuLabel>{group}</MenuLabel>
            {items.map((choice) => (
              <MenuRadioItem
                key={modelRefKey(choice.ref)}
                value={modelRefKey(choice.ref)}
                closeOnClick
                className="font-mono text-ui-sm"
              >
                {choice.label}
              </MenuRadioItem>
            ))}
          </ContextMenuGroup>
        ))}
      </ContextMenuRadioGroup>
      {groups.length > 0 ? <ContextMenuSeparator /> : null}
      <MenuItem icon={GearSixIcon} onClick={openAssistantSettings}>
        {d.chat.manageModels}
      </MenuItem>
    </DropdownMenu>
  )
}
