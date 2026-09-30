import { IconContext } from '@phosphor-icons/react'
import { useEffect } from 'react'
import { commands } from './commands/registry'
import { CommandPalette } from './components/CommandPalette'
import { DeckRail } from './components/DeckRail'
import { ExtensionApprovalDialog } from './components/ExtensionApprovalDialog'
import { FilesPanel } from './components/FilesPanel'
import { HistorySearch } from './components/HistorySearch'
import { TopBar } from './components/TopBar'
import { WindowControls } from './components/WindowControls'
import { WorkZone } from './components/WorkZone'
import { TooltipProvider } from './components/ui/tooltip'
import { isAppChord, matchChord, workspaceDigit } from './lib/chords'
import { useMotionAttribute } from './lib/motion'
import { useModifierHint } from './lib/useModifierHint'
import { isMac } from './platform'
import { registerSettingsSchema } from './settings/schema'
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
  const theme = useSettingsStore((s) => s.appearance.theme)
  useMotionAttribute()

  useEffect(() => {
    const themes = usePluginsStore.getState().themes
    const t = themes.find((x) => x.id === theme) ?? themes[0]
    const root = document.documentElement
    if (t) {
      for (const [k, v] of Object.entries(t.tokens)) root.style.setProperty(`--color-${k}`, v)
    }
    root.dataset.theme = theme
  }, [theme])

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
  }, [])

  useModifierHint(isMac)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const chord = matchChord(e, isMac)
      if (!isAppChord(chord)) return
      e.preventDefault()
      if (chord === 'workspace.goto') {
        void commands.exec(chord, { index: workspaceDigit(e.key.toLowerCase()) })
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
          <HistorySearch />
        </div>
      </TooltipProvider>
    </IconContext.Provider>
  )
}
