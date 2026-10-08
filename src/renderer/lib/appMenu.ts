import {
  APP_MENU_SECTIONS,
  type AppMenuEntry,
  type AppMenuSection,
  type AppMenuSpec,
  electronAccelerator,
} from '@shared/appMenu'
import type { Dict } from '@shared/dict'
import { type CommandDef, commandWording, commands } from '../commands/registry'
import { currentDict } from '../i18n/useDict'
import { usePluginsStore } from '../stores/pluginsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { chordOf, onBindingsChange } from './chords'

export const SSH_CONNECT_ITEM = 'menu.sshConnect'
const SSH_CONNECT_COMMAND = 'ssh.connect'
const SEPARATOR = '-'

type Layout = Record<AppMenuSection, string[]>

const LAYOUT: Layout = {
  file: [
    'workspace.new',
    'workspace.newScratch',
    'window.new',
    SEPARATOR,
    'tab.new',
    'tab.newBrowser',
    SEPARATOR,
    SSH_CONNECT_ITEM,
    SEPARATOR,
    'workspace.save',
  ],
  view: [
    'palette.toggle',
    SEPARATOR,
    'view.toggleRail',
    'view.searchFiles',
    'dashboard.toggle',
    SEPARATOR,
    'pane.splitRight',
    'pane.splitDown',
    'pane.zoom',
    SEPARATOR,
    'view.zoomIn',
    'view.zoomOut',
    'view.zoomReset',
    SEPARATOR,
    'browser.find',
  ],
  go: [
    'workspace.next',
    'workspace.previous',
    'tab.next',
    'tab.previous',
    SEPARATOR,
    'attention.jumpToLatest',
    SEPARATOR,
    'history.search',
    'workflows.search',
  ],
  help: ['developer.openLogFolder'],
}

const CHORD_OF: Record<string, string> = { 'browser.find': 'find' }

function tidy(entries: AppMenuEntry[]): AppMenuEntry[] {
  const out: AppMenuEntry[] = []
  for (const entry of entries) {
    const last = out.at(-1)
    if ('separator' in entry && (!last || 'separator' in last)) continue
    out.push(entry)
  }
  if (out.length > 0 && 'separator' in (out.at(-1) as AppMenuEntry)) out.pop()
  return out
}

export function buildAppMenuSpec(
  d: Dict,
  find: (id: string) => CommandDef<unknown, unknown> | undefined,
  accelerator: (id: string) => string | null,
): AppMenuSpec {
  const entryOf = (id: string): AppMenuEntry | null => {
    if (id === SEPARATOR) return { separator: true }
    if (id === SSH_CONNECT_ITEM) {
      return find(SSH_CONNECT_COMMAND) ? { command: id, label: d.appMenu.sshConnect } : null
    }
    const command = find(id)
    if (!command || command.hidden) return null
    const keys = accelerator(CHORD_OF[id] ?? id)
    return {
      command: id,
      label: commandWording(command, d).title,
      ...(keys ? { accelerator: keys } : {}),
    }
  }
  const spec = {} as AppMenuSpec
  for (const section of APP_MENU_SECTIONS) {
    const entries = LAYOUT[section]
      .map(entryOf)
      .filter((entry): entry is AppMenuEntry => entry !== null)
    spec[section] = { label: d.appMenu[section], items: tidy(entries) }
  }
  return spec
}

function macAccelerator(id: string): string | null {
  const spec = chordOf(id, true)
  return spec ? electronAccelerator(spec) : null
}

function findCommand(id: string): CommandDef<unknown, unknown> | undefined {
  return commands.list().find((command) => command.id === id)
}

export function runAppMenuItem(command: string): void {
  if (command === SSH_CONNECT_ITEM) {
    const ssh = findCommand(SSH_CONNECT_COMMAND)
    if (ssh) useUIStore.getState().openPalette('search', commandWording(ssh, currentDict()).title)
    return
  }
  if (commands.has(command)) void commands.exec(command)
}

export function startAppMenu(): () => void {
  const api = window.ostia?.appMenu
  if (!api) return () => {}
  let scheduled = false
  const publish = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      api.set(buildAppMenuSpec(currentDict(), findCommand, macAccelerator))
    })
  }
  publish()
  const offs = [
    commands.subscribe(publish),
    onBindingsChange(publish),
    useSettingsStore.subscribe((s, prev) => {
      if (s.locale !== prev.locale) publish()
    }),
    usePluginsStore.subscribe((s, prev) => {
      if (s.languages !== prev.languages) publish()
    }),
    api.onRun(runAppMenuItem),
  ]
  return () => {
    for (const off of offs) off()
  }
}
