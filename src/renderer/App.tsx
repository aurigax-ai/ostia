import { IconContext } from '@phosphor-icons/react'
import { clampZoom } from '@shared/zoom'
import { useEffect } from 'react'
import { commands } from './commands/registry'
import { ActionConfirmDialog } from './components/ActionConfirmDialog'
import { AgentOfferDialog } from './components/AgentOfferDialog'
import { CloseConfirmDialog } from './components/CloseConfirmDialog'
import { CmuxImportDialog } from './components/CmuxImportDialog'
import { CommandPalette } from './components/CommandPalette'
import { DeckRail } from './components/DeckRail'
import { DetachedTitleBar } from './components/DetachedTitleBar'
import { ExtensionApprovalDialog } from './components/ExtensionApprovalDialog'
import { FilesPanel } from './components/FilesPanel'
import { HistorySearch } from './components/HistorySearch'
import { MergeConfirmDialog } from './components/MergeConfirmDialog'
import { RemoteFolderDialog } from './components/RemoteFolderDialog'
import { SandboxFolderDialog } from './components/SandboxFolderDialog'
import { SandboxRequirementsDialog } from './components/SandboxRequirementsDialog'
import { SaveWorkflowDialog } from './components/SaveWorkflowDialog'
import { TopBar } from './components/TopBar'
import { WindowControls } from './components/WindowControls'
import { WorkZone } from './components/WorkZone'
import { WorkflowPicker } from './components/WorkflowPicker'
import { TooltipProvider } from './components/ui/tooltip'
import { runAppChord } from './lib/chords'
import { collectQuitGroups, confirmQuit } from './lib/closeConfirm'
import { handleDocumentClipboardChord, syncClipboardChords } from './lib/documentClipboard'
import { wireGuestChords } from './lib/guestChordBridge'
import { installMiddlePasteGuard } from './lib/middlePaste'
import { useMotionAttribute } from './lib/motion'
import { applyTheme, useEffectiveTheme } from './lib/theme'
import { applyUiFonts } from './lib/uiFonts'
import { useModifierHint } from './lib/useModifierHint'
import { useWindowTitle } from './lib/useWindowTitle'
import { startLanguageServices } from './lsp/client'
import { loadEditorLanguages } from './monaco/contributedLanguages'
import { useMonacoTheme } from './monaco/useMonacoTheme'
import { isMac } from './platform'
import { registerSettingsSchema } from './settings/registerSettingsSchema'
import { useExtensionsStore } from './stores/extensionsStore'
import { freezeSnapshots } from './stores/persistence'

const ICON_STYLE = { weight: 'regular' } as const
import { useSettingsStore } from './stores/settingsStore'
import { useUIStore } from './stores/uiStore'
import { useWindowsStore } from './stores/windowsStore'

export function App(): JSX.Element {
  const locale = useSettingsStore((s) => s.locale)
  const uiFont = useSettingsStore((s) => s.appearance.ui)
  const editorFont = useSettingsStore((s) => s.appearance.editor)
  const filesOpen = useUIStore((s) => s.filesOpen)
  const accent = useSettingsStore((s) => s.appearance.accent)
  const zoom = useSettingsStore((s) => s.appearance.zoom)
  const detached = useWindowsStore((s) => s.detached)
  const theme = useEffectiveTheme()
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
    <IconContext.Provider value={ICON_STYLE}>
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
          <CmuxImportDialog />
          <ActionConfirmDialog />
          <RemoteFolderDialog />
          <AgentOfferDialog />
          <SandboxRequirementsDialog />
          <SandboxFolderDialog />
          <HistorySearch />
          <WorkflowPicker />
          <SaveWorkflowDialog />
        </div>
      </TooltipProvider>
    </IconContext.Provider>
  )
}
