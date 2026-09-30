import { AppWindowIcon } from '@phosphor-icons/react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ASK_COMMAND_ID } from '../commands/askCommand'
import { commands } from '../commands/registry'
import { fmt, useDict } from '../i18n/useDict'
import { allPanes } from '../layout/tree'
import type { PaneNode } from '../layout/types'
import { chordLabel } from '../lib/chords'
import { PALETTE_MODES, type PaletteMode, paletteMode } from '../lib/paletteModes'
import { type RemoteWorkspace, remoteWorkspacesOf } from '../lib/windowWorkspaces'
import { revealPane } from '../lib/workspaceActivity'
import { isMac } from '../platform'
import { useAskStore } from '../stores/askStore'
import { useAssistProvider } from '../stores/assistStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useWindowsStore } from '../stores/windowsStore'
import { type Workspace, useWorkspacesStore } from '../stores/workspacesStore'
import { AskView } from './AskView'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from './ui/command'
import { Kbd } from './ui/kbd'

const subscribeCommands = (cb: () => void): (() => void) => commands.subscribe(cb)
const commandsVersion = (): number => commands.version()

export function CommandPalette(): JSX.Element {
  const d = useDict()
  const open = useUIStore((s) => s.paletteOpen)
  const close = useUIStore((s) => s.closePalette)
  const openMode = useUIStore((s) => s.paletteMode)
  const chat = useAssistProvider('chat')
  const [search, setSearch] = useState('')
  const [asking, setAsking] = useState<ArgumentCommand | null>(null)
  const [askSeed, setAskSeed] = useState('')
  const mode = paletteMode(search)
  const places = useMemo(() => (open ? snapshotPlaces() : EMPTY_PLACES), [open])
  const askMode = openMode === 'ask' && chat !== null

  useSyncExternalStore(subscribeCommands, commandsVersion)

  useEffect(() => {
    if (open) return
    setSearch('')
    setAsking(null)
    setAskSeed('')
    useAskStore.getState().stopAll()
  }, [open])

  const enterAsk = (seed: string): void => {
    setAskSeed(seed)
    setSearch('')
    useUIStore.getState().setPaletteMode('ask')
  }

  const leaveAsk = (): void => {
    setAskSeed('')
    useUIStore.getState().setPaletteMode('search')
  }

  const finish = close

  const ask = (command: ArgumentCommand): void => {
    setAsking(command)
    setSearch('')
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) finish()
      }}
      className={askMode ? 'top-[12vh] sm:max-w-3xl' : 'top-[12vh] sm:max-w-2xl'}
      title={askMode && chat ? fmt(d.ask.tabHint, { name: chat.name }) : d.palette.title}
      description={askMode ? d.ask.placeholder : d.palette.placeholder}
    >
      {askMode && chat ? (
        <AskView provider={chat} seed={askSeed} onBack={leaveAsk} onInserted={finish} />
      ) : asking ? (
        <ArgumentStep command={asking} value={search} onValueChange={setSearch} onDone={finish} />
      ) : (
        <>
          <CommandInput
            placeholder={d.palette.placeholder}
            value={search}
            onValueChange={setSearch}
            onKeyDown={(e) => {
              if (!chat || e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) {
                return
              }
              e.preventDefault()
              enterAsk(mode === 'help' ? '' : search)
            }}
          />
          <CommandList>
            <CommandEmpty>{d.palette.empty}</CommandEmpty>
            {mode === 'help' ? (
              <HelpItems
                onPick={(symbol) => setSearch(symbol)}
                askName={chat?.name ?? null}
                onAsk={() => enterAsk('')}
              />
            ) : null}
            {mode === 'all' || mode === 'workspaces' ? (
              <WorkspaceItems
                workspaces={places.workspaces}
                remote={places.remote}
                onDone={finish}
              />
            ) : null}
            {mode === 'all' || mode === 'tabs' ? (
              <TabItems tabs={places.tabs} onDone={finish} />
            ) : null}
            {mode === 'all' || mode === 'commands' ? (
              <CommandItems onDone={finish} onAsk={ask} onAskAssistant={() => enterAsk('')} />
            ) : null}
          </CommandList>
        </>
      )}
    </CommandDialog>
  )
}

interface ArgumentCommand {
  id: string
  title: string
  argument: string
}

function ArgumentStep({
  command,
  value,
  onValueChange,
  onDone,
}: {
  command: ArgumentCommand
  value: string
  onValueChange: (value: string) => void
  onDone: () => void
}): JSX.Element {
  const d = useDict()
  const argument = value.trim()
  const run = (): void => {
    if (!argument) return
    void commands.exec(command.id, { argument })
    onDone()
  }
  return (
    <>
      <CommandInput
        placeholder={command.argument}
        value={value}
        onValueChange={onValueChange}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          run()
        }}
      />
      <CommandList>
        <CommandEmpty>
          {argument
            ? fmt(d.palette.runWith, { title: command.title, value: argument })
            : d.palette.argumentEmpty}
        </CommandEmpty>
      </CommandList>
    </>
  )
}

function symbolOf(mode: PaletteMode): string {
  return PALETTE_MODES.find((m) => m.mode === mode)?.symbol ?? ''
}

function HelpItems({
  onPick,
  askName,
  onAsk,
}: {
  onPick: (symbol: string) => void
  askName: string | null
  onAsk: () => void
}): JSX.Element {
  const d = useDict()
  return (
    <CommandGroup heading={d.palette.helpHeading}>
      {askName ? (
        <CommandItem value={`? tab ${fmt(d.ask.tabHint, { name: askName })}`} onSelect={onAsk}>
          <Kbd className="font-mono">Tab</Kbd>
          <span>{fmt(d.ask.tabHint, { name: askName })}</span>
        </CommandItem>
      ) : null}
      {PALETTE_MODES.map((m) => (
        <CommandItem
          key={m.mode}
          value={`? ${m.symbol} ${d.palette.modes[m.mode]}`}
          onSelect={() => onPick(m.symbol)}
        >
          <Kbd className="font-mono">{m.symbol}</Kbd>
          <span>{d.palette.modes[m.mode]}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  )
}

interface Places {
  workspaces: Workspace[]
  remote: RemoteWorkspace[]
  tabs: { pane: PaneNode; workspace: Workspace }[]
}

const EMPTY_PLACES: Places = { workspaces: [], remote: [], tabs: [] }

function snapshotPlaces(): Places {
  const { workspaces } = useWorkspacesStore.getState()
  const { byWorkspace } = useLayoutStore.getState()
  const tabs = workspaces.flatMap((workspace) => {
    const layout = byWorkspace[workspace.id]
    return layout ? allPanes(layout.root).map((pane) => ({ pane, workspace })) : []
  })
  const { list, windowId } = useWindowsStore.getState()
  return { workspaces, remote: remoteWorkspacesOf(list, windowId), tabs }
}

function WorkspaceItems({
  workspaces,
  remote,
  onDone,
}: {
  workspaces: Workspace[]
  remote: RemoteWorkspace[]
  onDone: () => void
}): JSX.Element | null {
  const d = useDict()
  if (workspaces.length === 0 && remote.length === 0) return null
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
      {remote.map((w) => (
        <CommandItem
          key={w.id}
          value={`${symbol} ${w.name} ${w.workDir} ${w.id}`}
          onSelect={() => {
            window.pine.windows.focusWorkspace(w.id, false)
            onDone()
          }}
        >
          <AppWindowIcon aria-label={d.window.inOtherWindow} />
          <span>{w.name}</span>
          <CommandShortcut>{w.workDir}</CommandShortcut>
        </CommandItem>
      ))}
    </CommandGroup>
  )
}

function TabItems({
  tabs,
  onDone,
}: {
  tabs: Places['tabs']
  onDone: () => void
}): JSX.Element | null {
  const d = useDict()
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

function CommandItems({
  onDone,
  onAsk,
  onAskAssistant,
}: {
  onDone: () => void
  onAsk: (command: ArgumentCommand) => void
  onAskAssistant: () => void
}): JSX.Element {
  useSettingsStore((s) => s.keybindings)
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
          {items.map((c) => {
            const keys = chordLabel(c.id, isMac)
            return (
              <CommandItem
                key={c.id}
                value={`${symbol} ${c.title} ${c.id} ${c.category ?? ''}`}
                onSelect={() => {
                  if (c.id === ASK_COMMAND_ID) {
                    onAskAssistant()
                    return
                  }
                  if (c.argument) {
                    onAsk({ id: c.id, title: c.title, argument: c.argument })
                    return
                  }
                  void commands.exec(c.id)
                  onDone()
                }}
              >
                <span>{c.title}</span>
                <CommandShortcut>{c.id}</CommandShortcut>
                {keys ? <Kbd className="font-mono">{keys}</Kbd> : null}
              </CommandItem>
            )
          })}
        </CommandGroup>
      ))}
    </>
  )
}
