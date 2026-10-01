import { XIcon } from '@phosphor-icons/react'
import { type RefObject, useLayoutEffect, useRef } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import type { MenuAnchor } from '../lib/caretPoint'
import { SLASH_COMMANDS, type SlashMenu, type SlashRow } from '../lib/chatSlash'
import { IconButton } from './IconButton'
import { Command, CommandItem, CommandList } from './ui/command'

export const SLASH_MENU_WIDTH = 320
const MENU_MAX_HEIGHT = 288
const MENU_CHROME = 12

export function ChatSlashMenu({
  menu,
  rows,
  activeKey,
  anchor,
  areaRef,
  onActive,
  onPick,
}: {
  menu: SlashMenu
  rows: SlashRow[]
  activeKey: string | undefined
  anchor: MenuAnchor | null
  areaRef: RefObject<HTMLTextAreaElement>
  onActive: (key: string) => void
  onPick: (row: SlashRow) => void
}): JSX.Element {
  const d = useDict()
  const t = d.chatSlash
  const rootRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const root = rootRef.current
    const area = areaRef.current
    if (!root || !area) return
    const sync = (): void => {
      const list = root.querySelector('[role="listbox"]')
      if (list) area.setAttribute('aria-controls', list.id)
      const active = root.querySelector('[cmdk-item][aria-selected="true"]')
      if (!(active instanceof HTMLElement)) {
        area.removeAttribute('aria-activedescendant')
        return
      }
      area.setAttribute('aria-activedescendant', active.id)
      active.scrollIntoView?.({ block: 'nearest' })
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-selected'],
    })
    return () => {
      observer.disconnect()
      area.removeAttribute('aria-activedescendant')
      area.removeAttribute('aria-controls')
    }
  }, [areaRef])

  const label =
    menu.phase === 'command' ? t.menu : fmt(t.choices, { command: `/${menu.command.id}` })

  return (
    <div
      ref={rootRef}
      className="chat-slash-menu motion-enter absolute z-30 max-w-[calc(100%-8px)]"
      style={{
        width: SLASH_MENU_WIDTH,
        left: anchor?.left ?? 8,
        bottom: anchor?.bottom ?? '100%',
      }}
    >
      <Command
        shouldFilter={false}
        value={activeKey ?? ''}
        onValueChange={(value) => {
          if (rows.some((r) => r.key === value)) onActive(value)
        }}
        onMouseDown={(e) => e.preventDefault()}
        className="h-auto rounded-md! border border-line bg-surface-1 shadow-md"
      >
        <CommandList
          label={label}
          className="max-h-72"
          style={
            anchor?.maxHeight
              ? { maxHeight: Math.min(anchor.maxHeight - MENU_CHROME, MENU_MAX_HEIGHT) }
              : undefined
          }
        >
          {rows.map((row) => (
            <SlashItem key={row.key} row={row} onPick={onPick} />
          ))}
        </CommandList>
      </Command>
    </div>
  )
}

function SlashItem({
  row,
  onPick,
}: {
  row: SlashRow
  onPick: (row: SlashRow) => void
}): JSX.Element {
  const d = useDict()
  const t = d.chatSlash
  const { command, choice, reason } = row
  const IconFor = command.icon
  const name = choice ? choice.label : `/${command.id}`
  const args = !choice && command.arg ? t.args[command.arg.kind] : null
  const detail = reason
    ? t.reasons[reason]
    : choice
      ? (choice.detail ?? '')
      : t.commands[command.id].description
  return (
    <CommandItem
      value={row.key}
      disabled={reason !== null}
      onSelect={() => onPick(row)}
      className="chat-slash-item items-start gap-2 py-1 data-[disabled=true]:opacity-100"
    >
      <IconFor
        aria-hidden
        className="mt-0.5 size-3.5 text-fg-muted group-data-[disabled=true]/command-item:opacity-60"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span
            className={
              choice
                ? 'truncate text-fg text-ui-sm group-data-[disabled=true]/command-item:text-fg-muted'
                : 'shrink-0 font-mono text-fg text-ui-sm group-data-[disabled=true]/command-item:text-fg-muted'
            }
          >
            {name}
          </span>
          {args ? (
            <span className="truncate font-mono text-fg-muted text-ui-xs">{args}</span>
          ) : null}
        </span>
        {detail ? (
          <span
            className={reason ? 'text-fg-muted text-ui-xs' : 'truncate text-fg-muted text-ui-xs'}
          >
            {detail}
          </span>
        ) : null}
      </span>
    </CommandItem>
  )
}

export function ChatSlashHelp({ onClose }: { onClose: () => void }): JSX.Element {
  const d = useDict()
  const t = d.chatSlash
  return (
    <section
      aria-label={t.helpTitle}
      className="chat-slash-card motion-enter flex flex-col gap-2 rounded-md border border-line bg-surface-1 p-3"
    >
      <header className="flex items-center gap-2">
        <h3 className="flex-1 font-medium text-fg text-ui-sm">{t.helpTitle}</h3>
        <IconButton icon={XIcon} label={t.close} onClick={onClose} />
      </header>
      <p className="text-fg-muted text-ui-xs">{t.helpBody}</p>
      <ul className="flex flex-col gap-1">
        {SLASH_COMMANDS.map((command) => {
          const IconFor = command.icon
          return (
            <li key={command.id} className="flex items-baseline gap-2 text-ui-sm">
              <IconFor aria-hidden className="size-3.5 shrink-0 self-center text-fg-muted" />
              <span className="shrink-0 font-mono text-fg">
                /{command.id}
                {command.arg ? (
                  <span className="text-fg-muted text-ui-xs"> {t.args[command.arg.kind]}</span>
                ) : null}
              </span>
              <span className="min-w-0 truncate text-fg-muted text-ui-xs">
                {t.commands[command.id].description}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
