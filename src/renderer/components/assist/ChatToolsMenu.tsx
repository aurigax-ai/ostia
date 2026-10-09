import { TextLink } from '@/components/common/TextLink'
import { buttonVariants } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { fmt, useDict } from '@/i18n/useDict'
import { SKILLS_GROUP, builtinAvailable, groupOf, mcpGroup } from '@/lib/chatTools'
import { cn } from '@/lib/utils'
import { refreshMcp, refreshSkills, useChatToolsStore } from '@/stores/chatToolsStore'
import { useExtensionsStore } from '@/stores/extensionsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { WrenchIcon } from '@phosphor-icons/react'
import type { ChatToolMode } from '@shared/assist'
import {
  BUILTIN_TOOL_ACCESS,
  type BuiltinChatTool,
  type McpServerState,
  type McpServerStatus,
} from '@shared/chatTools'
import { type ReactNode, useEffect, useId } from 'react'

const STATE_DOT: Record<McpServerState, string> = {
  off: 'bg-fg-dim',
  idle: 'bg-fg-dim',
  connecting: 'bg-fg-muted',
  ready: 'bg-ok',
  error: 'bg-attn',
}

function ToolRow({
  label,
  hint,
  on,
  onChange,
  children,
}: {
  label: string
  hint?: string
  on: boolean
  onChange: (on: boolean) => void
  children?: ReactNode
}): JSX.Element {
  const id = useId()
  return (
    <li className="flex flex-col gap-0.5 py-1">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="min-w-0 flex-1 truncate text-fg text-ui-sm">
          {label}
        </label>
        {hint ? <span className="shrink-0 text-fg-muted text-ui-xs">{hint}</span> : null}
        <Switch id={id} size="sm" checked={on} onCheckedChange={onChange} aria-label={label} />
      </div>
      {children}
    </li>
  )
}

function McpRow({ server, sessionId }: { server: McpServerStatus; sessionId: string }) {
  const d = useDict()
  const t = d.chatTools
  const off = useChatToolsStore((s) => s.off[sessionId] ?? [])
  const toggle = useChatToolsStore((s) => s.toggle)
  const group = mcpGroup(server.name)
  const hint =
    server.state === 'ready'
      ? fmt(t.toolCount, { count: server.tools.length })
      : t.mcpStates[server.state]
  return (
    <ToolRow
      label={server.name}
      hint={hint}
      on={!off.includes(group)}
      onChange={(on) => toggle(sessionId, group, on)}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn('size-1.5 shrink-0 rounded-full', STATE_DOT[server.state])}
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-ui-xs',
            server.state === 'error' ? 'text-attn-fg' : 'text-fg-muted',
          )}
          title={server.error}
        >
          {server.error ?? t.mcpStates[server.state]}
        </span>
        {server.state === 'error' || server.state === 'idle' ? (
          <TextLink
            size="xs"
            className="h-5 px-1 text-ui-xs"
            onClick={() => void window.ostia.chatTools.mcpReconnect(server.name)}
          >
            {server.state === 'idle' ? t.connect : t.reconnect}
          </TextLink>
        ) : null}
      </div>
    </ToolRow>
  )
}

export function ChatToolsMenu({
  sessionId,
  mode,
  open,
  onOpenChange,
}: {
  sessionId: string
  mode: ChatToolMode
  open: boolean
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  const off = useChatToolsStore((s) => s.off[sessionId] ?? [])
  const toggle = useChatToolsStore((s) => s.toggle)
  const mcp = useChatToolsStore((s) => s.mcp)
  const skills = useChatToolsStore((s) => s.skills)
  const folders = useSettingsStore((s) => s.assistant.skillFolders)
  useExtensionsStore((s) => s.list)
  useEffect(() => {
    void refreshMcp()
    void refreshSkills()
  }, [])
  useEffect(() => {
    if (!open) return
    void refreshMcp()
    void refreshSkills()
  }, [open])
  const builtins = (Object.keys(BUILTIN_TOOL_ACCESS) as BuiltinChatTool[]).filter(
    (name) => name !== 'load_skill' && builtinAvailable(name, skills),
  )
  const servers = mcp.filter((s) => s.state !== 'off')
  const onCount =
    builtins.filter((n) => !off.includes(groupOf(n))).length +
    servers.filter((s) => s.state === 'ready' && !off.includes(mcpGroup(s.name))).length
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        type="button"
        aria-label={t.menuTitle}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'xs' }),
          'chat-tools-trigger shrink-0 gap-1 text-fg-muted',
        )}
      >
        <WrenchIcon />
        <span className="@max-xs:hidden">{t.menu}</span>
        <span className="tabular-nums">{onCount}</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80">
        <PopoverTitle className="text-fg text-ui-sm">{t.menuTitle}</PopoverTitle>
        <PopoverDescription className="text-fg-muted text-ui-xs">{t.menuDesc}</PopoverDescription>
        {mode === 'prompted' ? <p className="text-fg-muted text-ui-xs">{t.prompted}</p> : null}
        <section aria-label={t.builtin} className="flex flex-col">
          <h3 className="pt-1 text-fg-muted text-ui-xs">{t.builtin}</h3>
          <ul className="flex flex-col">
            {builtins.map((name) => (
              <ToolRow
                key={name}
                label={t.names[name]}
                hint={t.access[BUILTIN_TOOL_ACCESS[name]]}
                on={!off.includes(groupOf(name))}
                onChange={(on) => toggle(sessionId, groupOf(name), on)}
              />
            ))}
          </ul>
        </section>
        <section aria-label={t.mcp} className="flex flex-col">
          <h3 className="pt-1 text-fg-muted text-ui-xs">{t.mcp}</h3>
          {servers.length === 0 ? (
            <p className="py-1 text-fg-muted text-ui-xs">{t.noMcp}</p>
          ) : (
            <ul className="flex flex-col">
              {servers.map((server) => (
                <McpRow key={server.name} server={server} sessionId={sessionId} />
              ))}
            </ul>
          )}
        </section>
        <section aria-label={t.skills} className="flex flex-col">
          <h3 className="pt-1 text-fg-muted text-ui-xs">{t.skills}</h3>
          {skills.length === 0 ? (
            <p className="py-1 text-fg-muted text-ui-xs">
              {folders.length > 0 ? t.noFoundSkills : t.noSkills}
            </p>
          ) : (
            <ul className="flex flex-col">
              <ToolRow
                label={t.skills}
                hint={fmt(t.skillsCount, { count: skills.length })}
                on={!off.includes(SKILLS_GROUP)}
                onChange={(on) => toggle(sessionId, SKILLS_GROUP, on)}
              >
                <p
                  className="truncate text-fg-muted text-ui-xs"
                  title={skills.map((s) => s.name).join(', ')}
                >
                  {skills.map((s) => s.name).join(', ')}
                </p>
              </ToolRow>
            </ul>
          )}
        </section>
      </PopoverContent>
    </Popover>
  )
}
