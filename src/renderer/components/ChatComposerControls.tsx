import { cn } from '@/lib/utils'
import { CaretDownIcon, CubeIcon, GearSixIcon } from '@phosphor-icons/react'
import { type AssistModelChoice, type AssistModelRef, modelRefKey } from '@shared/assist'
import { useMemo } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { chatChoices, useAssistStore, useChatModel } from '../stores/assistStore'
import { setSessionModel, useChatStore } from '../stores/chatStore'
import { useUIStore } from '../stores/uiStore'
import { Hint } from './Hint'
import { DropdownMenu, MenuItem, MenuLabel, MenuRadioItem } from './Menu'
import { Button } from './ui/button'
import { ContextMenuGroup, ContextMenuRadioGroup, ContextMenuSeparator } from './ui/context-menu'

const TRIGGER = 'h-6 gap-1 px-1.5 text-ui-xs'

export function openAssistantSettings(): void {
  useUIStore.getState().closePalette()
  useUIStore.getState().openSettings('assistant')
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
          <CaretDownIcon aria-hidden className="size-3" />
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
