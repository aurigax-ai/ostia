import { IconContext } from '@phosphor-icons/react'
import { clampZoom } from '@shared/zoom'
import { useEffect } from 'react'
import { commands } from './commands/registry'
import { ActionConfirmDialog } from './components/ActionConfirmDialog'
import { CloseConfirmDialog } from './components/CloseConfirmDialog'
import { CommandPalette } from './components/CommandPalette'
import { DeckRail } from './components/DeckRail'
import { ExtensionApprovalDialog } from './components/ExtensionApprovalDialog'
import { FilesPanel } from './components/FilesPanel'
import { HistorySearch } from './components/HistorySearch'
import { PromptEditorDialog } from './components/PromptEditorDialog'
import { SaveWorkflowDialog } from './components/SaveWorkflowDialog'
import { TopBar } from './components/TopBar'
import { WindowControls } from './components/WindowControls'
import { WorkZone } from './components/WorkZone'
import { WorkflowPicker } from './components/WorkflowPicker'
import { TooltipProvider } from './components/ui/tooltip'
import { WORKSPACE_GOTO, isAppChord, matchChord, workspaceIndex } from './lib/chords'
import { confirmQuit } from './lib/closeConfirm'
import { useMotionAttribute } from './lib/motion'
import { applyTheme, useEffectiveTheme } from './lib/theme'
import { useModifierHint } from './lib/useModifierHint'
import { useWindowTitle } from './lib/useWindowTitle'
import { isMac } from './platform'
import { registerSettingsSchema } from './settings/registerSettingsSchema'
import { freezeSnapshots } from './stores/persistence'
import { usePluginsStore } from './stores/pluginsStore'

const ICON_STYLE = { weight: 'regular' } as const
import { useSettingsStore } from './stores/settingsStore'
import { useUIStore } from './stores/uiStore'

const SANS_FALLBACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang TC", "Microsoft JhengHei", "Hiragino Sans", "Noto Sans CJK TC", "Noto Sans TC", sans-serif'

export function App(): JSX.Element {
  const locale = useSettingsStore((s) => s.locale)
  const uiFont = useSettingsStore((s) => s.appearance.ui)
  const filesOpen = useUIStore((s) => s.filesOpen)
  const accent = useSettingsStore((s) => s.appearance.accent)
  const zoom = useSettingsStore((s) => s.appearance.zoom)
  const theme = useEffectiveTheme()
  useMotionAttribute()

  useEffect(() => {
    applyTheme(document.documentElement, theme, accent)
  }, [theme, accent])

  useEffect(() => {
    void window.pine.window.setZoom(clampZoom(zoom))
  }, [zoom])

  useEffect(() => {
    document.documentElement.style.setProperty('--font-ui', `"${uiFont.family}", ${SANS_FALLBACK}`)
    document.body.style.fontSize = `${uiFont.size}px`
    document.documentElement.style.setProperty('--font-ui-weight', String(uiFont.weight))
  }, [uiFont.family, uiFont.size, uiFont.weight])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  useEffect(() => {
    void usePluginsStore.getState().load()
  }, [])

  useEffect(() => {
    void registerSettingsSchema()
    return commands.subscribe(() => void registerSettingsSchema())
  }, [])

  useModifierHint(isMac)
  useWindowTitle()

  useEffect(
    () =>
      window.pine.window.onConfirmClose(async () => {
        const approved = await confirmQuit()
        if (approved) freezeSnapshots()
        return approved
      }),
    [],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const chord = matchChord(e, isMac)
      if (!isAppChord(chord)) return
      e.preventDefault()
      if (chord === WORKSPACE_GOTO) {
        void commands.exec(chord, { index: workspaceIndex(e) })
        return
      }
      void commands.exec(chord)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <IconContext.Provider value={ICON_STYLE}>
      <TooltipProvider delay={350}>
        <div className={`app${isMac ? ' is-mac' : ''}`}>
          <TopBar />
          <DeckRail />
          {filesOpen ? <FilesPanel /> : null}
          <WorkZone />
          <WindowControls />
          <CommandPalette />
          <ExtensionApprovalDialog />
          <CloseConfirmDialog />
          <ActionConfirmDialog />
          <PromptEditorDialog />
          <HistorySearch />
          <WorkflowPicker />
          <SaveWorkflowDialog />
        </div>
      </TooltipProvider>
    </IconContext.Provider>
  )
}
