import { cn } from '@/lib/utils'
import { AppWindowIcon } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ASK_COMMAND_ID } from '../commands/askCommand'
import {
  type CommandChoice,
  type CommandWording,
  commandWording,
  commands,
} from '../commands/registry'
import { fmt, useDict } from '../i18n/useDict'
import { allPanes, firstPaneOfKind } from '../layout/tree'
import type { PaneNode } from '../layout/types'
import { useChatAvailable } from '../lib/assistFeatures'
import { chordLabel, useBindings } from '../lib/chords'
import { openFileAt } from '../lib/openFile'
import { paletteFilter } from '../lib/paletteFilter'
import { PALETTE_MODES, type PaletteMode, paletteMode, paletteQuery } from '../lib/paletteModes'
import { type RemoteWorkspace, remoteWorkspacesOf } from '../lib/windowWorkspaces'
import { revealPane } from '../lib/workspaceActivity'
import {
  SYMBOL_SEARCH_DELAY_MS,
  type WorkspaceSymbolResult,
  findWorkspaceSymbols,
  symbolPlace,
} from '../lib/workspaceSymbolSearch'
import { isMac } from '../platform'
import { useAssistProvider } from '../stores/assistStore'
import { chatFor, currentSessionId } from '../stores/chatStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import { useWindowsStore } from '../stores/windowsStore'
import { type Workspace, useWorkspacesStore } from '../stores/workspacesStore'
import { ChatView } from './ChatView'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Kbd } from './ui/kbd'

const LIST_CLASS = 'max-h-[min(27rem,calc(88vh-5rem))]'

const GROUP_CLASS =
  '**:[[cmdk-group-heading]]:pt-3 **:[[cmdk-group-heading]]:pb-1.5 **:[[cmdk-group-heading]]:text-sm **:[[cmdk-group-heading]]:font-semibold'

const subscribeCommands = (cb: () => void): (() => void) => commands.subscribe(cb)
const commandsVersion = (): number => commands.version()

function stopUnseenAnswer(): void {
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  if (layout && firstPaneOfKind(layout.root, 'chat')) return
  const sessionId = currentSessionId(workspaceId)
  if (sessionId) void chatFor(sessionId).stop()
}

export function CommandPalette(): JSX.Element {
  const d = useDict()
  const open = useUIStore((s) => s.paletteOpen)
  const close = useUIStore((s) => s.closePalette)
  const openMode = useUIStore((s) => s.paletteMode)
  const seed = useUIStore((s) => s.paletteSeed)
  const provider = useAssistProvider('chat')
  const chat = useChatAvailable() ? provider : null
  const [search, setSearch] = useState('')
  const [asking, setAsking] = useState<ArgumentCommand | null>(null)
  const [askSeed, setAskSeed] = useState('')
  const mode = paletteMode(search)
  const places = useMemo(() => (open ? snapshotPlaces() : EMPTY_PLACES), [open])
  const askMode = openMode === 'ask' && chat !== null
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)

  useSyncExternalStore(subscribeCommands, commandsVersion)

  const wasAsking = useRef(false)
  useEffect(() => {
    if (open) {
      wasAsking.current = askMode
      return
    }
    setSearch('')
    setAsking(null)
    setAskSeed('')
    if (wasAsking.current) stopUnseenAnswer()
    wasAsking.current = false
  }, [open, askMode])

  useEffect(() => {
    if (open && seed) setSearch(seed)
  }, [open, seed])

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
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) finish()
      }}
    >
      <DialogHeader className="sr-only">
        <DialogTitle>
          {askMode && chat ? fmt(d.ask.tabHint, { name: chat.name }) : d.palette.title}
        </DialogTitle>
        <DialogDescription>{askMode ? d.ask.placeholder : d.palette.placeholder}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn(
          'top-[12vh] origin-top translate-y-0 overflow-hidden rounded-xl! p-0',
          askMode ? 'sm:max-w-3xl' : 'sm:max-w-[47rem]',
        )}
        showCloseButton={false}
      >
        <Command filter={paletteFilter}>
          {askMode && chat ? (
            <ChatView
              workspaceId={activeWorkspaceId}
              variant="palette"
              seed={askSeed}
              onBack={leaveAsk}
              onInserted={finish}
            />
          ) : asking ? (
            <ArgumentStep
              command={asking}
              value={search}
              onValueChange={setSearch}
              onDone={finish}
            />
          ) : (
            <>
              <CommandInput
                placeholder={d.palette.placeholder}
                value={search}
                onValueChange={setSearch}
                onKeyDown={(e) => {
                  if (
                    !chat ||
                    e.key !== 'Tab' ||
                    e.shiftKey ||
                    e.ctrlKey ||
                    e.metaKey ||
                    e.altKey
                  ) {
                    return
                  }
                  e.preventDefault()
                  enterAsk(mode === 'help' ? '' : search)
                }}
              />
              <CommandList className={LIST_CLASS}>
                {mode === 'symbols' ? (
                  <SymbolItems
                    query={paletteQuery(search)}
                    workspaceId={activeWorkspaceId}
                    onDone={finish}
                  />
                ) : (
                  <CommandEmpty>{d.palette.empty}</CommandEmpty>
                )}
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
                  <CommandItems
                    grouped={search.trim().length <= (mode === 'all' ? 0 : 1)}
                    onDone={finish}
                    onAsk={ask}
                    onAskAssistant={() => enterAsk('')}
                  />
                ) : null}
              </CommandList>
            </>
          )}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

interface ArgumentCommand {
  id: string
  title: string
  argument: string
  choices?: () => Promise<CommandChoice[]>
  emptyChoices?: () => string
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
  if (command.choices) {
    return (
      <ChoiceStep
        command={command}
        choices={command.choices}
        value={value}
        onValueChange={onValueChange}
        onDone={onDone}
      />
    )
  }
  return (
    <>
      <CommandInput
        autoFocus
        placeholder={command.argument}
        value={value}
        onValueChange={onValueChange}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          run()
        }}
      />
      <CommandList className={LIST_CLASS}>
        <CommandEmpty>
          {argument
            ? fmt(d.palette.runWith, { title: command.title, value: argument })
            : d.palette.argumentEmpty}
        </CommandEmpty>
      </CommandList>
    </>
  )
}

function ChoiceStep({
  command,
  choices: loadChoices,
  value,
  onValueChange,
  onDone,
}: {
  command: ArgumentCommand
  choices: () => Promise<CommandChoice[]>
  value: string
  onValueChange: (value: string) => void
  onDone: () => void
}): JSX.Element {
  const [choices, setChoices] = useState<CommandChoice[] | null>(null)
  useEffect(() => {
    let live = true
    void loadChoices().then((next) => {
      if (live) setChoices(next)
    })
    return () => {
      live = false
    }
  }, [loadChoices])
  return (
    <>
      <CommandInput
        autoFocus
        placeholder={command.argument}
        value={value}
        onValueChange={onValueChange}
      />
      <CommandList className={LIST_CLASS}>
        {choices !== null && choices.length === 0 ? (
          <CommandEmpty>{command.emptyChoices?.() ?? command.argument}</CommandEmpty>
        ) : null}
        {choices?.map((choice) => (
          <CommandItem
            key={choice.value}
            value={`${choice.label} ${choice.value}`}
            disabled={choice.disabledReason !== undefined}
            onSelect={() => {
              void commands.exec(command.id, { argument: choice.value })
              onDone()
            }}
          >
            <ItemRow name={choice.label} meta={choice.disabledReason} />
          </CommandItem>
        ))}
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
    <CommandGroup heading={d.palette.helpHeading} className={GROUP_CLASS}>
      {askName ? (
        <CommandItem value={`? tab ${fmt(d.ask.tabHint, { name: askName })}`} onSelect={onAsk}>
          <Kbd>Tab</Kbd>
          <span>{fmt(d.ask.tabHint, { name: askName })}</span>
        </CommandItem>
      ) : null}
      {PALETTE_MODES.map((m) => (
        <CommandItem
          key={m.mode}
          value={`? ${m.symbol} ${d.palette.modes[m.mode]}`}
          onSelect={() => onPick(m.symbol)}
        >
          <Kbd>{m.symbol}</Kbd>
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
    <CommandGroup heading={d.palette.modes.workspaces} className={GROUP_CLASS}>
      {workspaces.map((w) => {
        const name = w.customName ?? w.name
        return (
          <CommandItem
            key={w.id}
            value={`${symbol} ${name} ${w.workDir} ${w.id}`}
            onSelect={() => {
              useUIStore.getState().showWorkspaces()
              useWorkspacesStore.getState().setActive(w.id)
              onDone()
            }}
          >
            <ItemRow name={name} meta={w.workDir} mono />
          </CommandItem>
        )
      })}
      {remote.map((w) => (
        <CommandItem
          key={w.id}
          value={`${symbol} ${w.name} ${w.workDir} ${w.id}`}
          onSelect={() => {
            window.ostia.windows.focusWorkspace(w.id, false)
            onDone()
          }}
        >
          <AppWindowIcon aria-label={d.window.inOtherWindow} />
          <ItemRow name={w.name} meta={w.workDir} mono />
        </CommandItem>
      ))}
    </CommandGroup>
  )
}

function ItemRow({
  name,
  meta,
  keys,
  detail,
  mono,
  nameMono,
}: {
  name: string
  meta?: string
  keys?: string | null
  detail?: string
  mono?: boolean
  nameMono?: boolean
}): JSX.Element {
  return (
    <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_7.5rem] items-center gap-x-3 tabular-nums">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className={cn('truncate', nameMono && 'font-mono')}>{name}</span>
        {detail ? (
          <span className="min-w-0 truncate text-fg-muted text-ui-xs">{detail}</span>
        ) : null}
      </span>
      <span
        data-slot="palette-meta"
        className={cn(
          'min-w-0 max-w-80 justify-self-end truncate text-fg-muted text-ui-xs group-data-selected/command-item:text-fg',
          mono && 'font-mono',
        )}
      >
        {meta}
      </span>
      <span className="flex justify-end">
        {keys ? <Kbd className="whitespace-nowrap">{keys}</Kbd> : null}
      </span>
    </span>
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
    <CommandGroup heading={d.palette.modes.tabs} className={GROUP_CLASS}>
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
            <ItemRow name={pane.title} meta={where} />
          </CommandItem>
        )
      })}
    </CommandGroup>
  )
}

function SymbolItems({
  query,
  workspaceId,
  onDone,
}: {
  query: string
  workspaceId: string | null
  onDone: () => void
}): JSX.Element | null {
  const d = useDict()
  const [result, setResult] = useState<WorkspaceSymbolResult | null>(null)
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      void findWorkspaceSymbols(workspaceId, query).then((next) => {
        if (live) setResult(next)
      })
    }, SYMBOL_SEARCH_DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query, workspaceId])
  if (!result) return null
  if (result.hits.length === 0) {
    return (
      <output className="block px-3 py-6 text-center text-fg-muted text-ui-sm">
        {result.servers === 0
          ? d.palette.symbolsNoServer
          : query
            ? d.palette.empty
            : d.palette.symbolsHint}
      </output>
    )
  }
  const workDir = useWorkspacesStore
    .getState()
    .workspaces.find((w) => w.id === workspaceId)?.workDir
  const symbol = symbolOf('symbols')
  return (
    <CommandGroup heading={d.palette.modes.symbols} className={GROUP_CLASS} forceMount>
      {result.hits.map((hit) => {
        const place = symbolPlace(hit, workDir)
        return (
          <CommandItem
            key={hit.id}
            value={`${symbol} ${hit.name} ${hit.path}:${hit.line}:${hit.column}`}
            forceMount
            onSelect={() => {
              openFileAt(hit.path, hit.line, hit.column)
              onDone()
            }}
          >
            <ItemRow name={hit.name} nameMono detail={hit.container} meta={place} mono />
          </CommandItem>
        )
      })}
    </CommandGroup>
  )
}

type RegisteredCommand = ReturnType<typeof commands.list>[number]

interface PaletteCommand {
  command: RegisteredCommand
  shown: CommandWording
}

function searchValue(symbol: string, command: RegisteredCommand, shown: CommandWording): string {
  const words = [shown.title, command.title, command.id, shown.category, command.category]
  return [symbol, ...new Set(words.filter(Boolean))].join(' ')
}

function CommandItems({
  grouped,
  onDone,
  onAsk,
  onAskAssistant,
}: {
  grouped: boolean
  onDone: () => void
  onAsk: (command: ArgumentCommand) => void
  onAskAssistant: () => void
}): JSX.Element {
  const d = useDict()
  useBindings()
  const groups = new Map<string, { heading: string; items: PaletteCommand[] }>()
  for (const command of commands.list()) {
    if (command.hidden) continue
    const shown = commandWording(command, d)
    const key = command.category ?? ''
    const group = groups.get(key) ?? { heading: shown.category ?? d.palette.general, items: [] }
    group.items.push({ command, shown })
    groups.set(key, group)
  }
  const symbol = symbolOf('commands')
  const renderItem = ({ command: c, shown }: PaletteCommand): JSX.Element => {
    const keys = chordLabel(c.id, isMac)
    return (
      <CommandItem
        key={c.id}
        value={searchValue(symbol, c, shown)}
        onSelect={() => {
          if (c.id === ASK_COMMAND_ID) {
            onAskAssistant()
            return
          }
          if (shown.argument) {
            onAsk({
              id: c.id,
              title: shown.title,
              argument: shown.argument,
              choices: c.choices,
              emptyChoices: c.emptyChoices,
            })
            return
          }
          void commands.exec(c.id)
          onDone()
        }}
      >
        <ItemRow name={shown.title} meta={c.id} keys={keys} mono />
      </CommandItem>
    )
  }
  if (!grouped) return <>{[...groups.values()].flatMap((group) => group.items).map(renderItem)}</>
  return (
    <>
      {[...groups.entries()].map(([key, group]) => (
        <CommandGroup key={key} heading={group.heading} className={GROUP_CLASS}>
          {group.items.map(renderItem)}
        </CommandGroup>
      ))}
    </>
  )
}
