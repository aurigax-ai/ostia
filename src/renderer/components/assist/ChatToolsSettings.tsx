import { FolderSimpleIcon, PlusIcon, XIcon } from '@phosphor-icons/react'
import { isSkillPath } from '@shared/agents/managerSettings'
import { type McpServerSettings, READ_OUTSIDE_GRANT } from '@shared/assist/chatTools'
import { useEffect, useState } from 'react'
import { toolTitle } from '@/components/chat/ChatToolPart'
import { EmptyState } from '@/components/common/EmptyState'
import { Hint } from '@/components/common/Hint'
import { IconButton } from '@/components/common/IconButton'
import { Notice } from '@/components/common/Notice'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item'
import { fmt, useDict } from '@/lib/app/useDict'
import { skillsInFolder } from '@/lib/assist/mcpServerForm'
import { useSettingsStore } from '@/stores/app/settingsStore'
import {
  refreshMcp,
  refreshSkills,
  removeAlwaysGrant,
  useChatToolsStore,
} from '@/stores/assist/chatToolsStore'
import { McpServerDialog } from './McpServerDialog'
import { ROW, removeServer, ServerItem } from './McpServerItem'

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
        <EmptyState variant="block" title={t.noServers} desc={t.noServersDesc} action={addButton} />
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
        <EmptyState variant="block" title={t.noFolders} desc={t.noFoldersDesc} action={addButton} />
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
      {invalid ? <Notice>{t.badSkillFolder}</Notice> : null}
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
