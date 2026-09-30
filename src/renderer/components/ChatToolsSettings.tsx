import { cn } from '@/lib/utils'
import { XIcon } from '@phosphor-icons/react'
import { splitArgs } from '@shared/argv'
import {
  MCP_ENV_KEY,
  MCP_SERVER_NAME,
  type McpServerSettings,
  type McpServerState,
  type McpServerStatus,
  isMcpArgv,
  isMcpSecretKey,
  isMcpUrl,
  mcpTransportOf,
} from '@shared/chatTools'
import { isSkillPath } from '@shared/managerSettings'
import { quoteArgv } from '@shared/shellQuote'
import { useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { refreshMcp, refreshSkills, useChatToolsStore } from '../stores/chatToolsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { IconButton } from './IconButton'
import { SubHead, WarningNote } from './SettingsPanel'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'

const STATE_DOT: Record<McpServerState, string> = {
  off: 'bg-fg-dim',
  idle: 'bg-fg-dim',
  connecting: 'bg-fg-muted',
  ready: 'bg-ok',
  error: 'bg-attn',
}

async function saveServers(servers: McpServerSettings[]): Promise<void> {
  await useSettingsStore.getState().setChatTools({ mcpServers: servers })
  await refreshMcp()
}

function updateServer(name: string, patch: Partial<McpServerSettings>): Promise<void> {
  const servers = useSettingsStore.getState().assistant.mcpServers
  return saveServers(servers.map((s) => (s.name === name ? { ...s, ...patch } : s)))
}

export function envText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

export function parseEnvText(text: string): Record<string, string> | null {
  const env: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const at = line.indexOf('=')
    const key = at > 0 ? line.slice(0, at) : ''
    if (!MCP_ENV_KEY.test(key)) return null
    env[key] = line.slice(at + 1)
  }
  return env
}

export function parseServerTarget(text: string): Pick<McpServerSettings, 'command' | 'url'> | null {
  const value = text.trim()
  if (isMcpUrl(value)) return { url: value }
  const argv = splitArgs(value)
  return argv && isMcpArgv(argv) ? { command: argv } : null
}

function EnvEditor({ server }: { server: McpServerSettings }): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  const [draft, setDraft] = useState(envText(server.env))
  const [invalid, setInvalid] = useState(false)
  useEffect(() => setDraft(envText(server.env)), [server.env])
  return (
    <div className="flex flex-col gap-1">
      <span className="text-fg-muted text-ui-xs">{t.envTitle}</span>
      <Textarea
        value={draft}
        spellCheck={false}
        aria-label={`${server.name} ${t.envTitle}`}
        aria-invalid={invalid}
        placeholder={t.envHint}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const env = parseEnvText(draft)
          setInvalid(env === null)
          if (env && envText(env) !== envText(server.env)) void updateServer(server.name, { env })
        }}
        className="min-h-12 font-mono text-ui-sm"
      />
      {invalid ? <WarningNote>{t.badEnv}</WarningNote> : null}
    </div>
  )
}

function SecretsEditor({
  server,
  status,
}: {
  server: McpServerSettings
  status: McpServerStatus | undefined
}): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const transport = mcpTransportOf(server)
  const set = new Set(status?.secretsSet ?? [])
  const add = async (): Promise<void> => {
    const name = key.trim()
    if (!isMcpSecretKey(transport, name) || !value) {
      setError(t.badSecretKey)
      return
    }
    if (!server.secrets.includes(name)) {
      await useSettingsStore.getState().setChatTools({
        mcpServers: useSettingsStore
          .getState()
          .assistant.mcpServers.map((s) =>
            s.name === server.name ? { ...s, secrets: [...s.secrets, name] } : s,
          ),
      })
    }
    const res = await window.pine.chatTools.setMcpSecret(server.name, name, value)
    setError(res.ok ? null : t.secretFailed)
    if (res.ok) {
      setKey('')
      setValue('')
    }
    await refreshMcp()
  }
  const remove = async (name: string): Promise<void> => {
    await window.pine.chatTools.setMcpSecret(server.name, name, null)
    await updateServer(server.name, { secrets: server.secrets.filter((k) => k !== name) })
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-fg-muted text-ui-xs">{t.secretsTitle}</span>
      <p className="text-fg-muted text-ui-xs">{t.secretsHint}</p>
      {server.secrets.length > 0 ? (
        <ul className="flex flex-col">
          {server.secrets.map((name) => (
            <li key={name} className="flex items-center gap-2 py-0.5">
              <span className="min-w-0 flex-1 truncate font-mono text-fg text-ui-sm">{name}</span>
              <span className="text-fg-muted text-ui-xs">
                {set.has(name) ? t.secretSet : t.secretNotSet}
              </span>
              <IconButton
                icon={XIcon}
                label={fmt(t.removeSecret, { key: name })}
                onClick={() => void remove(name)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          value={key}
          spellCheck={false}
          placeholder={t.secretKey}
          aria-label={`${server.name} ${t.secretKey}`}
          onChange={(e) => setKey(e.target.value)}
          className="h-7 w-44 shrink-0 font-mono"
        />
        <Input
          type="password"
          value={value}
          placeholder={t.secretValue}
          aria-label={`${server.name} ${t.secretValue}`}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
          className="h-7 flex-1"
        />
        <Button variant="outline" size="sm" onClick={() => void add()}>
          {t.addSecret}
        </Button>
      </div>
      {error ? <WarningNote>{error}</WarningNote> : null}
    </div>
  )
}

function ServerTools({
  server,
  status,
}: {
  server: McpServerSettings
  status: McpServerStatus | undefined
}): JSX.Element | null {
  const d = useDict()
  const t = d.chatTools
  if (!status || status.tools.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <span className="text-fg-muted text-ui-xs">{t.toolsTitle}</span>
      <ul className="flex flex-col">
        {status.tools.map((tool) => {
          const on = !server.disabledTools.includes(tool.name)
          return (
            <li key={tool.name} className="flex items-center gap-2 py-0.5">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-fg text-ui-sm">{tool.name}</p>
                <p className="truncate text-fg-muted text-ui-xs" title={tool.description}>
                  {tool.description}
                </p>
              </div>
              <Switch
                size="sm"
                checked={on}
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
    </div>
  )
}

function ServerRow({ server }: { server: McpServerSettings }): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  const status = useChatToolsStore((s) => s.mcp.find((m) => m.name === server.name))
  const state: McpServerState = status?.state ?? (server.enabled ? 'idle' : 'off')
  const target = server.url ?? quoteArgv(server.command ?? [])
  return (
    <li
      className="flex flex-col gap-2 rounded-sm border border-line px-3 py-2"
      data-mcp={server.name}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', STATE_DOT[state])} />
        <span className="font-mono text-fg text-ui-base">{server.name}</span>
        <span className="text-fg-muted text-ui-xs">{t.mcpStates[state]}</span>
        <span className="ml-auto flex items-center gap-2">
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
            icon={XIcon}
            label={fmt(t.removeServer, { name: server.name })}
            onClick={() =>
              void saveServers(
                useSettingsStore
                  .getState()
                  .assistant.mcpServers.filter((s) => s.name !== server.name),
              )
            }
          />
        </span>
      </div>
      <code className="truncate font-mono text-fg-muted text-ui-sm" title={target}>
        {target}
      </code>
      {status?.error ? (
        <p role="alert" className="text-attn-fg text-ui-xs">
          {status.error}
        </p>
      ) : null}
      {server.command ? <EnvEditor server={server} /> : null}
      <SecretsEditor server={server} status={status} />
      <ServerTools server={server} status={status} />
    </li>
  )
}

function AddServer(): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  const servers = useSettingsStore((s) => s.assistant.mcpServers)
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [error, setError] = useState<string | null>(null)
  const add = (): void => {
    const trimmed = name.trim()
    if (!MCP_SERVER_NAME.test(trimmed) || servers.some((s) => s.name === trimmed)) {
      setError(t.badServerName)
      return
    }
    const parsed = parseServerTarget(target)
    if (!parsed) {
      setError(t.badServerTarget)
      return
    }
    const server: McpServerSettings = {
      name: trimmed,
      enabled: true,
      env: {},
      secrets: [],
      disabledTools: [],
      ...parsed,
    }
    setName('')
    setTarget('')
    setError(null)
    void saveServers([...servers, server])
  }
  return (
    <div className="pt-1">
      <div className="flex items-center gap-2">
        <Input
          value={name}
          spellCheck={false}
          placeholder={t.serverName}
          aria-label={t.serverName}
          onChange={(e) => setName(e.target.value)}
          className="h-7 w-32 shrink-0 font-mono"
        />
        <Input
          value={target}
          spellCheck={false}
          placeholder={t.serverTarget}
          aria-label={t.serverTarget}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          className="h-7 flex-1 font-mono"
        />
        <Button variant="outline" size="sm" onClick={add}>
          {t.addServer}
        </Button>
      </div>
      {error ? <WarningNote>{error}</WarningNote> : null}
    </div>
  )
}

function SkillFolders(): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  const folders = useSettingsStore((s) => s.assistant.skillFolders)
  const skills = useChatToolsStore((s) => s.skills)
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)
  const save = async (next: string[]): Promise<void> => {
    await useSettingsStore.getState().setChatTools({ skillFolders: next })
    await refreshSkills()
  }
  const add = (): void => {
    const path = draft.trim().replace(/\/+$/, '')
    if (!isSkillPath(path)) {
      setInvalid(true)
      return
    }
    setDraft('')
    setInvalid(false)
    if (!folders.includes(path)) void save([...folders, path])
  }
  return (
    <div className="flex flex-col gap-1">
      <SubHead title={t.skillsTitle} desc={t.skillsDesc} />
      {folders.length > 0 ? (
        <ul className="flex flex-col">
          {folders.map((path) => (
            <li key={path} className="flex items-center gap-3 py-1">
              <span className="min-w-0 flex-1 truncate font-mono text-fg text-ui-sm">{path}</span>
              <IconButton
                icon={XIcon}
                label={fmt(t.removeSkillFolder, { path })}
                onClick={() => void save(folders.filter((f) => f !== path))}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {folders.length > 0 ? (
        <p className="text-fg-muted text-ui-xs">
          {skills.length > 0
            ? fmt(t.foundSkills, { names: skills.map((s) => s.name).join(', ') })
            : t.noFoundSkills}
        </p>
      ) : null}
      <div className="flex items-center gap-3 pt-1">
        <Input
          value={draft}
          spellCheck={false}
          placeholder={t.skillPath}
          aria-label={t.skillsTitle}
          aria-invalid={invalid}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          className="h-7 flex-1 font-mono"
        />
        <Button variant="outline" size="sm" onClick={add}>
          {t.addSkillFolder}
        </Button>
      </div>
      {invalid ? <WarningNote>{t.badSkillFolder}</WarningNote> : null}
    </div>
  )
}

export function ChatToolsSettings(): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  const servers = useSettingsStore((s) => s.assistant.mcpServers)
  useEffect(() => {
    void refreshMcp()
    void refreshSkills()
  }, [])
  return (
    <section
      aria-label={t.settingsTitle}
      className="mt-3 flex flex-col gap-4 border-line border-t pt-3"
    >
      <SubHead title={t.settingsTitle} desc={t.settingsDesc} />
      <div className="flex flex-col gap-2">
        <SubHead title={t.mcpTitle} desc={t.mcpDesc} />
        {servers.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {servers.map((server) => (
              <ServerRow key={server.name} server={server} />
            ))}
          </ul>
        ) : null}
        <AddServer />
      </div>
      <SkillFolders />
    </section>
  )
}
