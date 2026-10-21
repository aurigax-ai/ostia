import { IconContext } from '@phosphor-icons/react'
import { clampZoom } from '@shared/app/zoom'
import { useEffect } from 'react'
import { AgentOfferDialog } from '@/components/agents/AgentOfferDialog'
import { CmuxImportDialog } from '@/components/app/CmuxImportDialog'
import { DetachedTitleBar } from '@/components/app/DetachedTitleBar'
import { RightPanel } from '@/components/app/RightPanel'
import { TopBar } from '@/components/app/TopBar'
import { UpdateConfirmDialog } from '@/components/app/UpdateConfirmDialog'
import { WindowControls } from '@/components/app/WindowControls'
import { WorkZone } from '@/components/app/WorkZone'
import { ExtensionApprovalDialog } from '@/components/extensions/ExtensionApprovalDialog'
import { FilesPanel } from '@/components/files/FilesPanel'
import { RemoteFolderDialog } from '@/components/files/RemoteFolderDialog'
import { CommandPalette } from '@/components/palette/CommandPalette'
import { HistorySearch } from '@/components/palette/HistorySearch'
import { SaveSnippetDialog } from '@/components/palette/SaveSnippetDialog'
import { SnippetPicker } from '@/components/palette/SnippetPicker'
import { SandboxFolderDialog } from '@/components/sandbox/SandboxFolderDialog'
import { SandboxRequirementsDialog } from '@/components/sandbox/SandboxRequirementsDialog'
import { ActionConfirmDialog } from '@/components/settings/ActionConfirmDialog'
import { TelemetryConsentDialog } from '@/components/settings/TelemetryConsentDialog'
import { CloseConfirmDialog } from '@/components/sidebar/CloseConfirmDialog'
import { DeckRail } from '@/components/sidebar/DeckRail'
import { HibernateSkippedDialog } from '@/components/sidebar/HibernateSkippedDialog'
import { MergeConfirmDialog } from '@/components/sidebar/MergeConfirmDialog'
import { TabSleepNoticeDialog } from '@/components/sidebar/TabSleepNoticeDialog'
import { useMotionAttribute } from '@/lib/app/motion'
import { wireLinkTabs } from '@/lib/browser/linkTabs'
import { installDoubleShift, runAppChord } from '@/lib/keyboard/chords'
import {
  handleDocumentBeforeCopy,
  handleDocumentClipboardChord,
  handleDocumentCopyEvent,
  syncClipboardChords,
} from '@/lib/keyboard/documentClipboard'
import { wireGuestChords } from '@/lib/keyboard/guestChordBridge'
import { useModifierHint } from '@/lib/keyboard/useModifierHint'
import { startLanguageServices } from '@/lib/lsp/client'
import { loadEditorLanguages } from '@/lib/monaco/contributedLanguages'
import { useMonacoTheme } from '@/lib/monaco/useMonacoTheme'
import { registerSettingsSchema } from '@/lib/settings/registerSettingsSchema'
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
import { commands } from './commands/registry'
import { TooltipProvider } from './components/ui/tooltip'
import { isMac } from './platform'

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
  useEffect(() => wireLinkTabs(), [])
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
      window.ostia.window.onConfirmClose(({ groups, keptShells }) =>
        confirmQuit(groups, keptShells),
      ),
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
    document.addEventListener('copy', handleDocumentCopyEvent, true)
    document.addEventListener('beforecopy', handleDocumentBeforeCopy, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('copy', handleDocumentCopyEvent, true)
      document.removeEventListener('beforecopy', handleDocumentBeforeCopy, true)
    }
  }, [])

  return (
    <IconContext.Provider value={iconStyle}>
      <TooltipProvider delay={350}>
        <div className={`app${isMac ? ' is-mac' : ''}${detached ? ' is-detached' : ''}`}>
          {detached ? <DetachedTitleBar /> : <TopBar />}
          {detached ? null : <DeckRail />}
          {filesOpen ? <FilesPanel /> : null}
          <WorkZone />
          <RightPanel />
          <WindowControls />
          <CommandPalette />
          <ExtensionApprovalDialog />
          <CloseConfirmDialog />
          <MergeConfirmDialog />
          <HibernateSkippedDialog />
          <TabSleepNoticeDialog />
          <CmuxImportDialog />
          <ActionConfirmDialog />
          <UpdateConfirmDialog />
          <RemoteFolderDialog />
          <AgentOfferDialog />
          <SandboxRequirementsDialog />
          <SandboxFolderDialog />
          <HistorySearch />
          <SnippetPicker />
          <SaveSnippetDialog />
          {detached ? null : <TelemetryConsentDialog />}
        </div>
      </TooltipProvider>
    </IconContext.Provider>
  )
}
