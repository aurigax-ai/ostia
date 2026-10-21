import { useEffect, useState } from 'react'
import { CommandGroup, CommandItem } from '@/components/ui/command'
import { useDict } from '@/lib/app/useDict'
import { openFileAt } from '@/lib/files/openFile'
import {
  findWorkspaceSymbols,
  SYMBOL_SEARCH_DELAY_MS,
  symbolPlace,
  type WorkspaceSymbolResult,
} from '@/lib/files/workspaceSymbolSearch'
import { symbolOf } from '@/lib/palette/paletteModes'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { ItemRow } from './PaletteItemRow'
import { GROUP_CLASS } from './paletteClasses'

export function SymbolItems({
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
