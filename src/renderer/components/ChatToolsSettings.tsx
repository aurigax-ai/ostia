import { cn } from '@/lib/utils'
import {
  CaretRightIcon,
  FolderSimpleIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react'
import {
  type McpServerSettings,
  type McpServerState,
  type McpServerStatus,
  mcpTransportOf,
} from '@shared/chatTools'
import { isSkillPath } from '@shared/managerSettings'
import { quoteArgv } from '@shared/shellQuote'
import { useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { skillsInFolder } from '../lib/mcpServerForm'
import { refreshMcp, refreshSkills, useChatToolsStore } from '../stores/chatToolsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { McpServerDialog, saveMcpServers } from './McpServerDialog'
import { ControlRow, SettingsGroup, WarningNote } from './SettingsPanel'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from './ui/item'
import { Switch } from './ui/switch'

const STATE_DOT: Record<McpServerState, string> = {
  off: 'bg-fg-dim',
  idle: 'bg-fg-dim',
  connecting: 'bg-fg-muted',
  ready: 'bg-ok',
  error: 'bg-attn',
}

const ROW = 'rounded-md border-line px-3 py-2'

function updateServer(name: string, patch: Partial<McpServerSettings>): Promise<void> {
  const servers = useSettingsStore.getState().assistant.mcpServers
  return saveMcpServers(servers.map((s) => (s.name === name ? { ...s, ...patch } : s)))
}

async function removeServer(server: McpServerSettings): Promise<void> {
  for (const key of server.secrets) {
    await window.pine.chatTools.setMcpSecret(server.name, key, null)
  }
  await saveMcpServers(
    useSettingsStore.getState().assistant.mcpServers.filter((s) => s.name !== server.name),
  )
}

function EmptyList({
  title,
  desc,
  action,
}: {
  title: string
  desc: string
  action: React.ReactNode
}): JSX.Element {
  return (
    <Empty className="gap-3 rounded-md border border-line border-dashed p-5">
      <EmptyHeader className="gap-1">
        <EmptyTitle className="text-fg text-ui-base">{title}</EmptyTitle>
        <EmptyDescription className="text-fg-muted text-ui-sm">{desc}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>{action}</EmptyContent>
    </Empty>
  )
}

function AccessRows(): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  const rows = [
    { title: t.accessReadTitle, desc: t.accessReadDesc, access: t.access.read },
    { title: t.accessActTitle, desc: t.accessActDesc, access: t.access.act },
    { title: t.accessConfirmTitle, desc: t.accessConfirmDesc, access: t.access.confirm },
  ]
  return (
    <div className="flex flex-col">
      {rows.map((row) => (
        <ControlRow key={row.title} label={row.title} desc={row.desc}>
          <span className="text-fg-muted text-ui-sm">{row.access}</span>
        </ControlRow>
      ))}
    </div>
  )
}

function statusText(
  t: ReturnType<typeof useDict>['chatTools'],
  state: McpServerState,
  status: McpServerStatus | undefined,
): string {
  if (state === 'ready' && status) {
    return `${t.mcpStates.ready} · ${fmt(t.toolCount, { count: status.tools.length })}`
  }
  return t.mcpStates[state]
}

function ServerTools({
  server,
  status,
}: {
  server: McpServerSettings
  status: McpServerStatus
}): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  const [open, setOpen] = useState(false)
  const on = status.tools.filter((tool) => !server.disabledTools.includes(tool.name)).length
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="basis-full">
      <CollapsibleTrigger
        render={
          <Button variant="ghost" size="xs" className="-ml-2 text-fg-muted hover:text-fg">
            <CaretRightIcon className={cn('transition-transform', open && 'rotate-90')} />
            {t.toolsTitle}
            <span className="tabular-nums">
              {on}/{status.tools.length}
            </span>
          </Button>
        }
      />
      <CollapsibleContent>
        <ul aria-label={fmt(t.enableServer, { name: server.name })} className="mt-1 flex flex-col">
          {status.tools.map((tool) => {
            const checked = !server.disabledTools.includes(tool.name)
            return (
              <li key={tool.name} className="flex items-center gap-3 py-1">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-fg text-ui-sm">{tool.name}</p>
                  {tool.description ? (
                    <Hint label={tool.description}>
                      <p className="truncate text-fg-muted text-ui-xs">{tool.description}</p>
                    </Hint>
                  ) : null}
                </div>
                <Switch
                  size="sm"
                  checked={checked}
                  aria-label={fmt(t.enableTool, { tool: tool.name })}
                  onCheckedChange={(next) =>
                    void updateServer(server.name, {
                      disabledTools: next
                        ? server.disabledTools.filter((n) => n !== tool.name)
                        : [...server.disabledTools, tool.name],
                    })
                  }
                />
              </li>
            )
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ServerItem({
  server,
  onEdit,
  onRemove,
}: {
  server: McpServerSettings
  onEdit: () => void
  onRemove: () => void
}): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  const status = useChatToolsStore((s) => s.mcp.find((m) => m.name === server.name))
  const state: McpServerState = server.enabled ? (status?.state ?? 'idle') : 'off'
  const http = mcpTransportOf(server) === 'http'
  const target = server.url ?? quoteArgv(server.command ?? [])
  return (
    <Item variant="outline" size="sm" render={<li />} className={ROW} data-mcp={server.name}>
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="text-fg text-ui-base">
          {server.name}
          <Badge variant="outline" className="font-normal text-fg-muted text-ui-xs">
            {http ? t.typeUrl : t.typeCommand}
          </Badge>
        </ItemTitle>
        <Hint label={target}>
          <ItemDescription className="truncate font-mono text-fg-muted text-ui-xs">
            {target}
          </ItemDescription>
        </Hint>
        <p className="flex items-center gap-1.5 text-fg-muted text-ui-xs">
          <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', STATE_DOT[state])} />
          <output>{statusText(t, state, status)}</output>
        </p>
        {server.enabled && status?.error ? (
          <p role="alert" className="break-words text-attn-fg text-ui-xs">
            {status.error}
          </p>
        ) : null}
      </ItemContent>
      <ItemActions className="self-start">
        {server.enabled && (state === 'error' || state === 'idle') ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void window.pine.chatTools.mcpReconnect(server.name)}
          >
            {state === 'idle' ? t.connect : t.reconnect}
          </Button>
        ) : null}
        <Switch
          checked={server.enabled}
          aria-label={fmt(t.enableServer, { name: server.name })}
          onCheckedChange={(enabled) => void updateServer(server.name, { enabled })}
        />
        <IconButton
          icon={PencilSimpleIcon}
          label={fmt(t.editServer, { name: server.name })}
          onClick={onEdit}
        />
        <IconButton
          icon={TrashIcon}
          label={fmt(t.removeServer, { name: server.name })}
          className="hover:text-attn-fg"
          onClick={onRemove}
        />
      </ItemActions>
      {server.enabled && status && status.tools.length > 0 ? (
        <ServerTools server={server} status={status} />
      ) : null}
    </Item>
  )
}

function McpServers(): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  const servers = useSettingsStore((s) => s.assistant.mcpServers)
  const [editing, setEditing] = useState<{ server: McpServerSettings | null } | null>(null)
  const [removing, setRemoving] = useState<McpServerSettings | null>(null)
  const add = (): void => setEditing({ server: null })
  const addButton = (
    <Button variant="outline" size="sm" onClick={add}>
      <PlusIcon />
      {t.addServer}
    </Button>
  )
  return (
    <SettingsGroup
      title={t.mcpTitle}
      desc={t.mcpDesc}
      action={servers.length > 0 ? addButton : null}
    >
      {servers.length === 0 ? (
        <EmptyList title={t.noServers} desc={t.noServersDesc} action={addButton} />
      ) : (
        <ul aria-label={t.mcpTitle} className="flex flex-col gap-2">
          {servers.map((server) => (
            <ServerItem
              key={server.name}
              server={server}
              onEdit={() => setEditing({ server })}
              onRemove={() => setRemoving(server)}
            />
          ))}
        </ul>
      )}
      <McpServerDialog
        open={editing !== null}
        server={editing?.server ?? null}
        onClose={() => setEditing(null)}
      />
      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{fmt(t.removeServerTitle, { name: removing?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t.removeServerBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRemoving(null)}>
              {t.cancel}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                const target = removing
                setRemoving(null)
                if (target) void removeServer(target)
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

function SkillFolders(): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  const folders = useSettingsStore((s) => s.assistant.skillFolders)
  const skills = useChatToolsStore((s) => s.skills)
  const [invalid, setInvalid] = useState(false)
  const save = async (next: string[]): Promise<void> => {
    await useSettingsStore.getState().setChatTools({ skillFolders: next })
    await refreshSkills()
  }
  const add = async (): Promise<void> => {
    const picked = await window.pine.sync.pickFolder()
    if (picked === null) return
    const path = picked.replace(/\/+$/, '')
    if (!isSkillPath(path)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    if (!folders.includes(path)) await save([...folders, path])
  }
  const addButton = (
    <Button variant="outline" size="sm" onClick={() => void add()}>
      <FolderSimpleIcon />
      {t.addSkillFolder}
    </Button>
  )
  return (
    <SettingsGroup
      title={t.skillsTitle}
      desc={t.skillsDesc}
      action={folders.length > 0 ? addButton : null}
    >
      {folders.length === 0 ? (
        <EmptyList title={t.noFolders} desc={t.noFoldersDesc} action={addButton} />
      ) : (
        <ul aria-label={t.skillsTitle} className="flex flex-col gap-2">
          {folders.map((path) => {
            const found = skillsInFolder(skills, path)
            return (
              <Item key={path} variant="outline" size="sm" render={<li />} className={ROW}>
                <ItemContent className="min-w-0 gap-0.5">
                  <Hint label={path}>
                    <ItemTitle className="block w-full truncate font-mono font-normal text-fg text-ui-sm">
                      {path}
                    </ItemTitle>
                  </Hint>
                  <ItemDescription className="truncate text-fg-muted text-ui-xs">
                    {found.length > 0
                      ? fmt(t.foundSkills, { names: found.map((s) => s.name).join(', ') })
                      : t.noSkillsInFolder}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconButton
                    icon={XIcon}
                    label={fmt(t.removeSkillFolder, { path })}
                    onClick={() => void save(folders.filter((f) => f !== path))}
                  />
                </ItemActions>
              </Item>
            )
          })}
        </ul>
      )}
      {invalid ? <WarningNote>{t.badSkillFolder}</WarningNote> : null}
    </SettingsGroup>
  )
}

export function ChatToolsSettings(): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  useEffect(() => {
    void refreshMcp()
    void refreshSkills()
  }, [])
  return (
    <>
      <SettingsGroup title={t.settingsTitle} desc={t.settingsDesc}>
        <AccessRows />
      </SettingsGroup>
      <McpServers />
      <SkillFolders />
    </>
  )
}
