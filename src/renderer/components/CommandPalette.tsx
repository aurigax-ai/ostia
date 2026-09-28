import { useState, useSyncExternalStore } from 'react'
import { commands } from '../commands/registry'
import { useDict } from '../i18n/useDict'
import { allPanes } from '../layout/tree'
import { PALETTE_MODES, type PaletteMode, paletteMode } from '../lib/paletteModes'
import { revealPane } from '../lib/workspaceActivity'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from './ui/command'

const subscribeCommands = (cb: () => void): (() => void) => commands.subscribe(cb)
const commandsVersion = (): number => commands.version()

export function CommandPalette(): JSX.Element {
  const d = useDict()
  const open = useUIStore((s) => s.paletteOpen)
  const close = useUIStore((s) => s.closePalette)
  const [search, setSearch] = useState('')
  const mode = paletteMode(search)

  useSyncExternalStore(subscribeCommands, commandsVersion)

  const finish = (): void => {
    setSearch('')
    close()
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) finish()
      }}
      title={d.palette.title}
      description={d.palette.placeholder}
    >
      <CommandInput placeholder={d.palette.placeholder} value={search} onValueChange={setSearch} />
      <CommandList>
        <CommandEmpty>{d.palette.empty}</CommandEmpty>
        {mode === 'help' ? <HelpItems onPick={(symbol) => setSearch(symbol)} /> : null}
        {mode === 'all' || mode === 'workspaces' ? <WorkspaceItems onDone={finish} /> : null}
        {mode === 'all' || mode === 'tabs' ? <TabItems onDone={finish} /> : null}
        {mode === 'all' || mode === 'commands' ? <CommandItems onDone={finish} /> : null}
      </CommandList>
    </CommandDialog>
  )
}

function symbolOf(mode: PaletteMode): string {
  return PALETTE_MODES.find((m) => m.mode === mode)?.symbol ?? ''
}

function HelpItems({ onPick }: { onPick: (symbol: string) => void }): JSX.Element {
  const d = useDict()
  return (
    <CommandGroup heading={d.palette.helpHeading}>
      {PALETTE_MODES.map((m) => (
        <CommandItem
          key={m.mode}
          value={`? ${m.symbol} ${d.palette.modes[m.mode]}`}
          onSelect={() => onPick(m.symbol)}
        >
          <kbd className="palette-prefix">{m.symbol}</kbd>
          <span>{d.palette.modes[m.mode]}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  )
}

function WorkspaceItems({ onDone }: { onDone: () => void }): JSX.Element | null {
  const d = useDict()
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  if (workspaces.length === 0) return null
  const symbol = symbolOf('workspaces')
  return (
    <CommandGroup heading={d.palette.modes.workspaces}>
      {workspaces.map((w) => {
        const name = w.customName ?? w.name
        return (
          <CommandItem
            key={w.id}
            value={`${symbol} ${name} ${w.workDir} ${w.id}`}
            onSelect={() => {
              useUIStore.getState().leaveSettings()
              useWorkspacesStore.getState().setActive(w.id)
              onDone()
            }}
          >
            <span>{name}</span>
            <CommandShortcut>{w.workDir}</CommandShortcut>
          </CommandItem>
        )
      })}
    </CommandGroup>
  )
}

function TabItems({ onDone }: { onDone: () => void }): JSX.Element | null {
  const d = useDict()
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const byWorkspace = useLayoutStore((s) => s.byWorkspace)
  const tabs = workspaces.flatMap((w) => {
    const layout = byWorkspace[w.id]
    return layout ? allPanes(layout.root).map((pane) => ({ pane, workspace: w })) : []
  })
  if (tabs.length === 0) return null
  const symbol = symbolOf('tabs')
  return (
    <CommandGroup heading={d.palette.modes.tabs}>
      {tabs.map(({ pane, workspace }) => {
        const where = workspace.customName ?? workspace.name
        return (
          <CommandItem
            key={pane.id}
            value={`${symbol} ${pane.title} ${where} ${pane.kind} ${pane.id}`}
            onSelect={() => {
              revealPane(pane.id)
              onDone()
            }}
          >
            <span>{pane.title}</span>
            <CommandShortcut>{where}</CommandShortcut>
          </CommandItem>
        )
      })}
    </CommandGroup>
  )
}

function CommandItems({ onDone }: { onDone: () => void }): JSX.Element {
  const byCat = new Map<string, ReturnType<typeof commands.list>>()
  for (const c of commands.list()) {
    if (c.hidden) continue
    const cat = c.category ?? 'General'
    byCat.set(cat, [...(byCat.get(cat) ?? []), c])
  }
  const symbol = symbolOf('commands')
  return (
    <>
      {[...byCat.entries()].map(([category, items]) => (
        <CommandGroup key={category} heading={category}>
          {items.map((c) => (
            <CommandItem
              key={c.id}
              value={`${symbol} ${c.title} ${c.id} ${c.category ?? ''}`}
              onSelect={() => {
                void commands.exec(c.id)
                onDone()
              }}
            >
              <span>{c.title}</span>
              <CommandShortcut>{c.id}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
      ))}
    </>
  )
}
