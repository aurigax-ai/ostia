import { useEffect, useState } from 'react'
import { CommandGroup, CommandItem } from '@/components/ui/command'
import { useDict } from '@/lib/app/useDict'
import { childPath, splitPath } from '@/lib/files/fileTree'
import { openFileAt } from '@/lib/files/openFile'
import {
  FILE_SEARCH_DELAY_MS,
  findWorkspaceFiles,
  splitFilePosition,
  type WorkspaceFileResult,
} from '@/lib/files/workspaceFileSearch'
import { symbolOf } from '@/lib/palette/paletteModes'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { ItemRow } from './PaletteItemRow'
import { GROUP_CLASS } from './paletteClasses'

export function FileItems({
  query,
  workDir,
  onSelect,
  onDone,
  quiet = false,
}: {
  query: string
  workDir: string | null
  onSelect: (value: string) => void
  onDone: () => void
  quiet?: boolean
}): JSX.Element | null {
  const d = useDict()
  const includeIgnored = useSettingsStore((s) => s.files.searchIgnored)
  const [result, setResult] = useState<WorkspaceFileResult | null>(null)
  const { name: wanted, line, column } = splitFilePosition(query)
  useEffect(() => {
    if (!workDir || !wanted) {
      setResult(null)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      void findWorkspaceFiles(workDir, wanted, includeIgnored).then((next) => {
        if (!live || next.status === 'cancelled') return
        setResult(next)
        const first = next.status === 'hits' ? next.hits[0] : undefined
        onSelect(first ? `${symbolOf('files')} ${first.path}` : '')
      })
    }, FILE_SEARCH_DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [workDir, wanted, includeIgnored, onSelect])
  const status = (text: string): JSX.Element | null =>
    quiet ? null : (
      <output className="block px-3 py-6 text-center text-fg-muted text-ui-sm">{text}</output>
    )
  if (!workDir) return status(d.palette.filesNoWorkspace)
  if (!wanted) return status(d.palette.filesHint)
  if (!result) return null
  if (result.status === 'failed') return status(d.palette.filesFailed)
  if (result.status === 'cancelled') return null
  if (result.hits.length === 0) return status(d.palette.empty)
  const symbol = symbolOf('files')
  return (
    <CommandGroup heading={d.palette.modes.files} className={GROUP_CLASS} forceMount>
      {result.hits.map((hit) => {
        const { name, dir } = splitPath(hit.path)
        return (
          <CommandItem
            key={hit.path}
            value={`${symbol} ${hit.path}`}
            forceMount
            onSelect={() => {
              openFileAt(childPath(result.root, hit.path), line, column)
              onDone()
            }}
          >
            <ItemRow name={name} meta={dir} mono />
          </CommandItem>
        )
      })}
    </CommandGroup>
  )
}
