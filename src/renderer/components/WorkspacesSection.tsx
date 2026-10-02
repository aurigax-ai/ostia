import { toAccelerator } from '@shared/globalHotkey'
import { useEffect, useState } from 'react'
import { useDict } from '../i18n/useDict'
import {
  NEW_WORKSPACE_PLACEMENTS,
  type NewWorkspacePlacement,
  useSettingsStore,
} from '../stores/settingsStore'
import { ControlRow, SectionHead, SettingsGroup, ToggleRow, WarningNote } from './SettingsPanel'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from './ui/select'

const FOLDER_CHECK_DELAY_MS = 300

function useFolderExists(folder: string): boolean {
  const [exists, setExists] = useState(true)
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      void window.pine.fs.stat(folder).then((kind) => {
        if (live) setExists(kind === 'dir')
      })
    }, FOLDER_CHECK_DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [folder])
  return exists
}

export function WorkspacesSection(): JSX.Element {
  const d = useDict()
  const settings = useSettingsStore((s) => s.workspaces)
  const set = useSettingsStore((s) => s.setWorkspaces)
  const folderExists = useFolderExists(settings.defaultFolder)
  const [folderDraft, setFolderDraft] = useState(settings.defaultFolder)

  const placementLabel: Record<NewWorkspacePlacement, string> = {
    end: d.workspaceSettings.placementEnd,
    top: d.workspaceSettings.placementTop,
    afterCurrent: d.workspaceSettings.placementAfterCurrent,
  }

  return (
    <div>
      <SectionHead title={d.workspaceSettings.title} />
      <SettingsGroup title={d.workspaceSettings.groupNew}>
        <ControlRow label={d.workspaceSettings.placement} desc={d.workspaceSettings.placementDesc}>
          <Select
            value={settings.placement}
            onValueChange={(v) => set({ placement: v as NewWorkspacePlacement })}
          >
            <SelectTrigger
              size="sm"
              aria-label={d.workspaceSettings.placement}
              className="w-fit min-w-52 max-w-80"
            >
              <span className="min-w-0 truncate">{placementLabel[settings.placement]}</span>
            </SelectTrigger>
            <SelectContent>
              {NEW_WORKSPACE_PLACEMENTS.map((p) => (
                <SelectItem key={p} value={p}>
                  {placementLabel[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ControlRow>
        <ToggleRow
          label={d.workspaceSettings.inherit}
          desc={d.workspaceSettings.inheritDesc}
          checked={settings.inheritFolder}
          onChange={(v) => set({ inheritFolder: v })}
        />
        <ControlRow
          label={d.workspaceSettings.defaultFolder}
          desc={d.workspaceSettings.defaultFolderDesc}
        >
          <Input
            value={folderDraft}
            spellCheck={false}
            aria-label={d.workspaceSettings.defaultFolder}
            aria-invalid={!folderExists}
            onChange={(e) => {
              setFolderDraft(e.target.value)
              set({ defaultFolder: e.target.value.trim() || '~' })
            }}
            className="h-7 w-56 font-mono"
          />
        </ControlRow>
        {folderExists ? null : <WarningNote>{d.workspaceSettings.folderInvalid}</WarningNote>}
      </SettingsGroup>
      <SettingsGroup title={d.workspaceSettings.groupClosing}>
        <ToggleRow
          label={d.workspaceSettings.confirmClose}
          desc={d.workspaceSettings.confirmCloseDesc}
          checked={settings.confirmClose}
          onChange={(v) => set({ confirmClose: v })}
        />
        <ToggleRow
          label={d.workspaceSettings.confirmQuit}
          desc={d.workspaceSettings.confirmQuitDesc}
          checked={settings.confirmQuit}
          onChange={(v) => set({ confirmQuit: v })}
        />
        <ToggleRow
          label={d.workspaceSettings.closeToTray}
          desc={d.workspaceSettings.closeToTrayDesc}
          checked={settings.closeToTray}
          onChange={(v) => set({ closeToTray: v })}
        />
        <ControlRow
          label={d.workspaceSettings.globalHotkey}
          desc={d.workspaceSettings.globalHotkeyDesc}
        >
          <Input
            value={settings.globalHotkey}
            spellCheck={false}
            placeholder="Ctrl+Alt+Space"
            aria-label={d.workspaceSettings.globalHotkey}
            onChange={(e) => set({ globalHotkey: e.target.value })}
            className="h-7 w-48 font-mono"
          />
        </ControlRow>
        {settings.globalHotkey.trim() && !toAccelerator(settings.globalHotkey) ? (
          <WarningNote>{d.workspaceSettings.globalHotkeyInvalid}</WarningNote>
        ) : null}
      </SettingsGroup>
      <SettingsGroup title={d.workspaceSettings.groupSidebar}>
        <ToggleRow
          label={d.workspaceSettings.wrapTitles}
          desc={d.workspaceSettings.wrapTitlesDesc}
          checked={settings.wrapTitles}
          onChange={(v) => set({ wrapTitles: v })}
        />
      </SettingsGroup>
    </div>
  )
}
