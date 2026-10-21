import { useEffect, useMemo, useState } from 'react'
import { CommandGroup, CommandItem } from '@/components/ui/command'
import { fmt, useDict } from '@/lib/app/useDict'
import { childPath, splitPath } from '@/lib/files/fileTree'
import { openFileAt } from '@/lib/files/openFile'
import {
  findWorkspaceLines,
  LINE_SEARCH_DELAY_MS,
  type WorkspaceLineResult,
} from '@/lib/files/workspaceFileSearch'
import { settingsSections } from '@/lib/settings/settingsSections'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { ItemRow } from './PaletteItemRow'
import { GROUP_CLASS } from './paletteClasses'

const SETTINGS_SYMBOL = '§'
const FILES_TEXT_SYMBOL = '¶'
const LINE_SEARCH_MIN_CHARS = 2

export function LineItems({
  query,
  workDir,
  onDone,
}: {
  query: string
  workDir: string | null
  onDone: () => void
}): JSX.Element | null {
  const d = useDict()
  const includeIgnored = useSettingsStore((s) => s.files.searchIgnored)
  const [result, setResult] = useState<WorkspaceLineResult | null>(null)
  useEffect(() => {
    if (!workDir || query.length < LINE_SEARCH_MIN_CHARS) {
      setResult(null)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      void findWorkspaceLines(workDir, query, includeIgnored).then((next) => {
        if (live && next.status !== 'cancelled') setResult(next)
      })
    }, LINE_SEARCH_DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [workDir, query, includeIgnored])
  if (result?.status !== 'hits' || result.lines.length === 0) return null
  return (
    <CommandGroup heading={d.palette.textLines} className={GROUP_CLASS} forceMount>
      {result.lines.map((hit) => (
        <CommandItem
          key={`${hit.path}:${hit.line}:${hit.column}`}
          value={`${FILES_TEXT_SYMBOL} ${hit.path}:${hit.line}:${hit.column}`}
          forceMount
          onSelect={() => {
            openFileAt(childPath(result.root, hit.path), hit.line, hit.column)
            onDone()
          }}
        >
          <ItemRow name={`${splitPath(hit.path).name}:${hit.line}`} nameMono meta={hit.text} mono />
        </CommandItem>
      ))}
    </CommandGroup>
  )
}

export function FilesTextItem({
  query,
  onDone,
}: {
  query: string
  onDone: () => void
}): JSX.Element {
  const d = useDict()
  return (
    <CommandItem
      className="mx-1"
      value={FILES_TEXT_SYMBOL}
      forceMount
      onSelect={() => {
        useUIStore.getState().searchFiles(query)
        onDone()
      }}
    >
      <ItemRow name={fmt(d.palette.searchFilesText, { query })} />
    </CommandItem>
  )
}

export function SettingsItems({
  query,
  onDone,
}: {
  query: string
  onDone: () => void
}): JSX.Element {
  const d = useDict()
  const sections = useMemo(() => settingsSections(d), [d])
  const open = (section: string | undefined, text: string): void => {
    useUIStore.getState().openSettings(section, { query: text })
    onDone()
  }
  return (
    <>
      <CommandGroup heading={d.palette.settings} className={GROUP_CLASS}>
        {sections.map((s) => (
          <CommandItem
            key={s.id}
            value={`${SETTINGS_SYMBOL} ${s.label} ${s.id}`}
            onSelect={() => open(s.id, '')}
          >
            <ItemRow name={s.label} />
          </CommandItem>
        ))}
      </CommandGroup>
      <CommandItem
        className="mx-1"
        value={SETTINGS_SYMBOL}
        forceMount
        onSelect={() => open(undefined, query)}
      >
        <ItemRow name={fmt(d.palette.searchSettings, { query })} />
      </CommandItem>
    </>
  )
}
