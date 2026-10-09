import { AgentOfferDialog } from '@/components/agents/AgentOfferDialog'
import { ExtensionApprovalDialog } from '@/components/extensions/ExtensionApprovalDialog'
import { FilesPanel } from '@/components/files/FilesPanel'
import { RemoteFolderDialog } from '@/components/files/RemoteFolderDialog'
import { HistorySearch } from '@/components/palette/HistorySearch'
import { SaveWorkflowDialog } from '@/components/palette/SaveWorkflowDialog'
import { WorkflowPicker } from '@/components/palette/WorkflowPicker'
import { CloseConfirmDialog } from '@/components/rail/CloseConfirmDialog'
import { DeckRail } from '@/components/rail/DeckRail'
import { HibernateSkippedDialog } from '@/components/rail/HibernateSkippedDialog'
import { MergeConfirmDialog } from '@/components/rail/MergeConfirmDialog'
import { SandboxFolderDialog } from '@/components/sandbox/SandboxFolderDialog'
import { SandboxRequirementsDialog } from '@/components/sandbox/SandboxRequirementsDialog'
import { ActionConfirmDialog } from '@/components/settings/ActionConfirmDialog'
import { TelemetryConsentDialog } from '@/components/settings/TelemetryConsentDialog'
import { CmuxImportDialog } from '@/components/shell/CmuxImportDialog'
import { DetachedTitleBar } from '@/components/shell/DetachedTitleBar'
import { TopBar } from '@/components/shell/TopBar'
import { UpdateConfirmDialog } from '@/components/shell/UpdateConfirmDialog'
import { WindowControls } from '@/components/shell/WindowControls'
import { WorkZone } from '@/components/shell/WorkZone'
import { useMotionAttribute } from '@/lib/app/motion'
import { installDoubleShift, runAppChord } from '@/lib/keys/chords'
import { handleDocumentClipboardChord, syncClipboardChords } from '@/lib/keys/documentClipboard'
import { wireGuestChords } from '@/lib/keys/guestChordBridge'
import { useModifierHint } from '@/lib/keys/useModifierHint'
import { installMiddlePasteGuard } from '@/lib/terminal/middlePaste'
import { useIconStyle } from '@/lib/theme/iconWeight'
import { applyTheme, useEffectiveTheme } from '@/lib/theme/theme'
import { applyUiFonts } from '@/lib/theme/uiFonts'
import { collectQuitGroups, confirmQuit } from '@/lib/workspaces/closeConfirm'
import { useWindowTitle } from '@/lib/workspaces/useWindowTitle'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { freezeSnapshots } from '@/stores/workspaces/persistence'
import { useWindowsStore } from '@/stores/workspaces/windowsStore'
import { IconContext } from '@phosphor-icons/react'
import { clampZoom } from '@shared/app/zoom'
import { useEffect } from 'react'
import { commands } from './commands/registry'
import { CommandPalette } from './components/CommandPalette'
import { TooltipProvider } from './components/ui/tooltip'
import { startLanguageServices } from './lsp/client'
import { loadEditorLanguages } from './monaco/contributedLanguages'
import { useMonacoTheme } from './monaco/useMonacoTheme'
import { isMac } from './platform'
import { registerSettingsSchema } from './settings/registerSettingsSchema'

export function App(): JSX.Element {
  const locale = useSettingsStore((s) => s.locale)
  const uiFont = useSettingsStore((s) => s.appearance.ui)
  const editorFont = useSettingsStore((s) => s.appearance.editor)
  const filesOpen = useUIStore((s) => s.filesOpen)
  const accent = useSettingsStore((s) => s.appearance.accent)
  const zoom = useSettingsStore((s) => s.appearance.zoom)
  const detached = useWindowsStore((s) => s.detached)
  const theme = useEffectiveTheme()
  const iconStyle = useIconStyle()
  useMotionAttribute()
  useMonacoTheme()

  useEffect(() => {
    applyTheme(document.documentElement, theme, accent)
  }, [theme, accent])

  useEffect(() => {
    void window.ostia.window.setZoom(clampZoom(zoom))
  }, [zoom])

  useEffect(() => {
    applyUiFonts(document.documentElement, { ui: uiFont, editor: editorFont })
  }, [uiFont, editorFont])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  useEffect(() => {
    void startLanguageServices()
  }, [])

  useEffect(() => syncClipboardChords(isMac), [])
  useEffect(() => wireGuestChords(isMac), [])
  useEffect(() => installDoubleShift(window, isMac), [])

  useEffect(() => installMiddlePasteGuard(window), [])

  const extensionList = useExtensionsStore((s) => s.list)
  useEffect(() => {
    void extensionList
    void loadEditorLanguages()
  }, [extensionList])

  useEffect(() => {
    void registerSettingsSchema()
    return commands.subscribe(() => void registerSettingsSchema())
  }, [])

  useModifierHint(isMac)
  useWindowTitle()

  useEffect(() => {
    const offs = [
      window.ostia.window.onRunningQuery((kept) => collectQuitGroups(new Set(kept))),
      window.ostia.window.onConfirmClose(confirmQuit),
      window.ostia.window.onFreeze(freezeSnapshots),
    ]
    return () => {
      for (const off of offs) off()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (handleDocumentClipboardChord(e, isMac)) return
      runAppChord(e, isMac)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <IconContext.Provider value={iconStyle}>
      <TooltipProvider delay={350}>
        <div className={`app${isMac ? ' is-mac' : ''}${detached ? ' is-detached' : ''}`}>
          {detached ? <DetachedTitleBar /> : <TopBar />}
          {detached ? null : <DeckRail />}
          {filesOpen ? <FilesPanel /> : null}
          <WorkZone />
          <WindowControls />
          <CommandPalette />
          <ExtensionApprovalDialog />
          <CloseConfirmDialog />
          <MergeConfirmDialog />
          <HibernateSkippedDialog />
          <CmuxImportDialog />
          <ActionConfirmDialog />
          <UpdateConfirmDialog />
          <RemoteFolderDialog />
          <AgentOfferDialog />
          <SandboxRequirementsDialog />
          <SandboxFolderDialog />
          <HistorySearch />
          <WorkflowPicker />
          <SaveWorkflowDialog />
          {detached ? null : <TelemetryConsentDialog />}
        </div>
      </TooltipProvider>
    </IconContext.Provider>
  )
}
