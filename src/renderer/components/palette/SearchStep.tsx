import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import { fmt, useDict } from '@/lib/app/useDict'
import { PALETTE_MODES, type PaletteMode, paletteQuery } from '@/lib/palette/paletteModes'
import type { ArgumentCommand } from './ArgumentStep'
import { CommandItems } from './CommandItems'
import { FilesTextItem, LineItems, SettingsItems } from './EverywhereItems'
import { FileItems } from './FileItems'
import { type Places, TabItems, WorkspaceItems } from './PlaceItems'
import { GROUP_CLASS, LIST_CLASS } from './paletteClasses'
import { SymbolItems } from './SymbolItems'

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

export function SearchStep({
  search,
  onSearchChange,
  mode,
  placeholder,
  chat,
  places,
  everywhere,
  workspaceId,
  workDir,
  onSelect,
  onDone,
  onAsk,
  onEnterAsk,
}: {
  search: string
  onSearchChange: (search: string) => void
  mode: PaletteMode
  placeholder: string
  chat: { name: string } | null
  places: Places
  everywhere: boolean
  workspaceId: string | null
  workDir: string | null
  onSelect: (value: string) => void
  onDone: () => void
  onAsk: (command: ArgumentCommand) => void
  onEnterAsk: (seed: string) => void
}): JSX.Element {
  const d = useDict()
  return (
    <>
      <CommandInput
        placeholder={placeholder}
        value={search}
        onValueChange={onSearchChange}
        onKeyDown={(e) => {
          if (!chat || e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) {
            return
          }
          e.preventDefault()
          onEnterAsk(mode === 'help' ? '' : mode === 'all' ? search : paletteQuery(search))
        }}
      />
      <CommandList className={LIST_CLASS}>
        {mode === 'symbols' ? (
          <SymbolItems query={paletteQuery(search)} workspaceId={workspaceId} onDone={onDone} />
        ) : mode === 'files' ? (
          <FileItems
            query={paletteQuery(search)}
            workDir={workDir}
            onSelect={onSelect}
            onDone={onDone}
          />
        ) : (
          <CommandEmpty>{d.palette.empty}</CommandEmpty>
        )}
        {mode === 'help' ? (
          <HelpItems
            onPick={(symbol) => onSearchChange(symbol)}
            askName={chat?.name ?? null}
            onAsk={() => onEnterAsk('')}
          />
        ) : null}
        {mode === 'all' || mode === 'workspaces' ? (
          <WorkspaceItems workspaces={places.workspaces} remote={places.remote} onDone={onDone} />
        ) : null}
        {mode === 'all' || mode === 'tabs' ? <TabItems tabs={places.tabs} onDone={onDone} /> : null}
        {mode === 'all' || mode === 'commands' ? (
          <CommandItems
            grouped={search.trim().length <= (mode === 'all' ? 0 : 1)}
            heading={everywhere ? d.palette.modes.commands : undefined}
            onDone={onDone}
            onAsk={onAsk}
            onAskAssistant={() => onEnterAsk('')}
          />
        ) : null}
        {everywhere ? (
          <>
            <FileItems
              query={search.trim()}
              workDir={workDir}
              onSelect={onSelect}
              onDone={onDone}
              quiet
            />
            <LineItems query={search.trim()} workDir={workDir} onDone={onDone} />
            <FilesTextItem query={search.trim()} onDone={onDone} />
            <SettingsItems query={search.trim()} onDone={onDone} />
          </>
        ) : null}
      </CommandList>
    </>
  )
}
