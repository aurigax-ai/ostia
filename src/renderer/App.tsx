import { useEffect } from 'react'
import { commands } from './commands/registry'
import { CommandPalette } from './components/CommandPalette'
import { DeckRail } from './components/DeckRail'
import { TopBar } from './components/TopBar'
import { WindowControls } from './components/WindowControls'
import { WorkZone } from './components/WorkZone'
import { TooltipProvider } from './components/ui/tooltip'
import { isMac } from './platform'
import { registerSettingsSchema } from './settings/schema'
import { usePluginsStore } from './stores/pluginsStore'
import { useSettingsStore } from './stores/settingsStore'

/** CJK-safe fallback chain appended after the user's chosen UI font family. */
const SANS_FALLBACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang TC", "Microsoft JhengHei", "Hiragino Sans", "Noto Sans CJK TC", "Noto Sans TC", sans-serif'

export function App(): JSX.Element {
  const locale = useSettingsStore((s) => s.locale)
  const uiFont = useSettingsStore((s) => s.appearance.ui)
  const theme = useSettingsStore((s) => s.appearance.theme)

  // Apply the active theme's palette (a contribution from the Themes plugin): set the
  // --color-* primitives on <html>; index.css's semantic tokens reference them, so the
  // whole app re-themes. Falls back to the first theme if the id is unknown.
  useEffect(() => {
    const themes = usePluginsStore.getState().themes
    const t = themes.find((x) => x.id === theme) ?? themes[0]
    const root = document.documentElement
    if (t) {
      for (const [k, v] of Object.entries(t.tokens)) root.style.setProperty(`--color-${k}`, v)
    }
    root.dataset.theme = theme
  }, [theme])

  // Apply the UI font live (appearance system). Terminal/editor fonts apply when those exist.
  useEffect(() => {
    document.documentElement.style.setProperty('--font-ui', `"${uiFont.family}", ${SANS_FALLBACK}`)
    document.body.style.fontSize = `${uiFont.size}px`
  }, [uiFont.family, uiFont.size])

  // Reflect locale on <html lang> (a11y + font selection).
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // Load the plugin registry (language servers) once at startup for live status.
  useEffect(() => {
    void usePluginsStore.getState().load()
  }, [])

  // Load settings.json and register its JSON Schema with Monaco (for editing the file).
  useEffect(() => {
    void useSettingsStore.getState().init()
    void registerSettingsSchema()
  }, [])

  // Global shortcuts → registry commands (⌘K palette · ⌘\ sidebar · ⌘, settings).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const id =
        e.key.toLowerCase() === 'k'
          ? 'palette.toggle'
          : e.key === '\\'
            ? 'view.toggleRail'
            : e.key === ','
              ? 'app.openSettings'
              : null
      if (id) {
        e.preventDefault()
        void commands.exec(id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <TooltipProvider delay={350}>
      <div className={`app${isMac ? ' is-mac' : ''}`}>
        <TopBar />
        <DeckRail />
        <WorkZone />
        <WindowControls />
        <CommandPalette />
      </div>
    </TooltipProvider>
  )
}
