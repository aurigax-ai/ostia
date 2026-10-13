import { Hint } from '@/components/common/Hint'
import { IconButton } from '@/components/common/IconButton'
import { ControlRow, SettingsGroup, WarningNote } from '@/components/settings/SettingsPanel'
import { Highlight, useSearchGroup } from '@/components/settings/SettingsSearch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item'
import { Switch } from '@/components/ui/switch'
import { fmt, useDict } from '@/i18n/useDict'
import { skillsInFolder } from '@/lib/assist/mcpServerForm'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/app/settingsStore'
import {
  refreshMcp,
  refreshSkills,
  removeAlwaysGrant,
  useChatToolsStore,
} from '@/stores/assist/chatToolsStore'
import {
  CaretRightIcon,
  FolderSimpleIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react'
import { isSkillPath } from '@shared/agents/managerSettings'
import {
  type McpAuthState,
  type McpServerSettings,
  type McpServerState,
  type McpServerStatus,
  type McpSignInResult,
  type McpTestResult,
  READ_OUTSIDE_GRANT,
  mcpTransportOf,
} from '@shared/assist/chatTools'
import { quoteArgv } from '@shared/terminal/shellQuote'
import { useEffect, useState } from 'react'
import { toolTitle } from './ChatToolPart'
import { McpServerDialog, saveMcpServers } from './McpServerDialog'

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
    await window.ostia.chatTools.setMcpSecret(server.name, key, null)
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
    { title: t.accessWriteTitle, desc: t.accessWriteDesc, access: t.access.write },
    { title: t.accessCommandTitle, desc: t.accessCommandDesc, access: t.access.command },
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

function AlwaysAllowedTools(): JSX.Element {
  const d = useDict()
  const t = d.chatTools.always
  const keys = useChatToolsStore((s) => s.standing)
  useChatToolsStore((s) => s.mcp)
  return (
    <SettingsGroup title={t.title} desc={t.desc}>
      {keys.length === 0 ? (
        <p className="py-1.5 text-fg-muted text-ui-sm">{t.none}</p>
      ) : (
        keys.map((key) => (
          <ControlRow
            key={key}
            label={key === READ_OUTSIDE_GRANT ? t.readOutside : toolTitle(d, key)}
          >
            <Button variant="outline" size="xs" onClick={() => void removeAlwaysGrant(key)}>
              {t.remove}
            </Button>
          </ControlRow>
        ))
      )}
    </SettingsGroup>
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

const AUTH_DOT: Record<McpAuthState, string> = {
  required: 'bg-attn',
  'signing-in': 'bg-fg-muted',
  'signed-in': 'bg-ok',
  expired: 'bg-attn',
}

function ServerAuth({
  server,
  auth,
}: {
  server: McpServerSettings
  auth: McpAuthState
}): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  const [failure, setFailure] = useState<Extract<McpSignInResult, { ok: false }> | null>(null)
  const signIn = async (): Promise<void> => {
    setFailure(null)
    const result = await window.ostia.chatTools
      .mcpSignIn(server.name)
      .catch((): McpSignInResult => ({ ok: false, error: 'failed' }))
    setFailure(result.ok || result.error === 'cancelled' ? null : result)
  }
  return (
    <div data-mcp-auth={auth} className="flex basis-full flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex min-w-0 flex-1 items-center gap-1.5 text-fg-muted text-ui-xs">
          <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', AUTH_DOT[auth])} />
          <output>{t.authStates[auth]}</output>
        </p>
        {auth === 'required' || auth === 'expired' ? (
          <Button
            variant="outline"
            size="sm"
            aria-label={fmt(t.signInTo, { name: server.name })}
            onClick={() => void signIn()}
          >
            {t.signIn}
          </Button>
        ) : null}
        {auth === 'signing-in' ? (
          <Button
            variant="outline"
            size="sm"
            aria-label={fmt(t.cancelSignInTo, { name: server.name })}
            onClick={() => window.ostia.chatTools.mcpCancelSignIn(server.name)}
          >
            {t.cancelSignIn}
          </Button>
        ) : null}
        {auth === 'signed-in' || auth === 'expired' ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={fmt(t.signOutOf, { name: server.name })}
            onClick={() => {
              setFailure(null)
              void window.ostia.chatTools.mcpSignOut(server.name)
            }}
          >
            {t.signOut}
          </Button>
        ) : null}
      </div>
      {failure ? (
        <p role="alert" className="break-words text-attn-fg text-ui-xs">
          {t.signInErrors[failure.error]}
          {failure.detail ? ` ${failure.detail}` : ''}
        </p>
      ) : null}
    </div>
  )
}

type TestState = { phase: 'running' } | { phase: 'done'; result: McpTestResult }

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
  const [test, setTest] = useState<TestState | null>(null)
  const auth = status?.auth
  useEffect(() => {
    if (state || auth) setTest((shown) => (shown?.phase === 'done' ? null : shown))
  }, [state, auth])
  const runTest = async (): Promise<void> => {
    setTest({ phase: 'running' })
    const result = await window.ostia.chatTools
      .mcpTest(server.name)
      .catch((): McpTestResult => ({ ok: false, error: '' }))
    setTest({ phase: 'done', result })
  }
  const search = useSearchGroup([server.name])
  return (
    <Item
      variant="outline"
      size="sm"
      render={<li />}
      hidden={search.hidden}
      data-search-hit={search.hit || undefined}
      className={ROW}
      data-mcp={server.name}
    >
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="text-fg text-ui-base">
          <Highlight text={server.name} />
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
        {test?.phase === 'running' ? (
          <output className="text-fg-muted text-ui-xs">{t.testing}</output>
        ) : null}
        {test?.phase === 'done' && test.result.ok ? (
          <output className="text-fg-muted text-ui-xs">
            {fmt(t.testPassed, { count: test.result.tools })}
          </output>
        ) : null}
        {test?.phase === 'done' && !test.result.ok ? (
          <p role="alert" className="break-words text-attn-fg text-ui-xs">
            {[t.testFailed, test.result.error].filter(Boolean).join(': ')}
          </p>
        ) : null}
      </ItemContent>
      <ItemActions className="self-start">
        <Button
          variant="outline"
          size="sm"
          aria-label={fmt(t.testServerNamed, { name: server.name })}
          disabled={test?.phase === 'running'}
          onClick={() => void runTest()}
        >
          {t.testServer}
        </Button>
        {server.enabled && (state === 'error' || state === 'idle') ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void window.ostia.chatTools.mcpReconnect(server.name)}
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
      {status?.auth ? <ServerAuth server={server} auth={status.auth} /> : null}
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
    const picked = await window.ostia.sync.pickFolder()
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
      <AlwaysAllowedTools />
      <McpServers />
      <SkillFolders />
    </>
  )
}
