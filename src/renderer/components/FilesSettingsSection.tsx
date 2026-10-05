import { PlusIcon, XIcon } from '@phosphor-icons/react'
import { BUILTIN_ICON_THEME } from '@shared/iconTheme'
import { type FormEvent, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import {
  BREADCRUMB_STYLES,
  type BreadcrumbStyle,
  DEFAULT_NESTING_PATTERNS,
  FILE_SORT_BYS,
  FILE_SORT_ORDERS,
  type FileSortBy,
  type FileSortOrder,
} from '../settings/fileTreeSettings'
import { useAvailableIconThemes } from '../stores/iconThemeStore'
import { useSettingsStore } from '../stores/settingsStore'
import { IconButton } from './IconButton'
import { ControlRow, SelectField, SettingsGroup, SubHead, ToggleRow } from './SettingsPanel'
import { Button } from './ui/button'
import { Input } from './ui/input'

function PatternRow({
  label,
  detail,
  onRemove,
}: {
  label: string
  detail?: string
  onRemove: () => void
}): JSX.Element {
  const d = useDict()
  return (
    <li className="flex items-center gap-2 rounded-sm py-0.5 pr-1 pl-2">
      <span className="min-w-0 flex-1 truncate font-mono text-fg text-ui-sm">
        {label}
        {detail ? <span className="text-fg-muted"> → {detail}</span> : null}
      </span>
      <IconButton
        icon={XIcon}
        label={fmt(d.filesView.removePattern, { pattern: label })}
        onClick={onRemove}
      />
    </li>
  )
}

function ExcludeList(): JSX.Element {
  const d = useDict()
  const exclude = useSettingsStore((s) => s.files.exclude)
  const setFiles = useSettingsStore((s) => s.setFiles)
  const [draft, setDraft] = useState('')
  const add = (e: FormEvent): void => {
    e.preventDefault()
    const pattern = draft.trim()
    if (!pattern) return
    setFiles({ exclude: [...exclude.filter((p) => p !== pattern), pattern] })
    setDraft('')
  }
  return (
    <div className="py-1.5">
      <p className="mb-2 text-fg-muted text-ui-sm">{d.filesView.excludeDesc}</p>
      <ul aria-label={d.filesView.exclude} className="mb-2 flex flex-col">
        {exclude.map((pattern) => (
          <PatternRow
            key={pattern}
            label={pattern}
            onRemove={() => setFiles({ exclude: exclude.filter((p) => p !== pattern) })}
          />
        ))}
      </ul>
      <form className="flex items-center gap-2" onSubmit={add}>
        <Input
          value={draft}
          spellCheck={false}
          placeholder={d.filesView.newExclude}
          aria-label={d.filesView.newExclude}
          onChange={(e) => setDraft(e.target.value)}
          className="h-7 flex-1 font-mono"
        />
        <Button type="submit" variant="outline" size="sm" disabled={!draft.trim()}>
          <PlusIcon data-icon="inline-start" />
          {d.filesView.addPattern}
        </Button>
      </form>
    </div>
  )
}

function NestingList(): JSX.Element {
  const d = useDict()
  const nesting = useSettingsStore((s) => s.files.nesting)
  const setFiles = useSettingsStore((s) => s.setFiles)
  const [parent, setParent] = useState('')
  const [children, setChildren] = useState('')
  const setPatterns = (patterns: Record<string, string>): void =>
    setFiles({ nesting: { ...nesting, patterns } })
  const add = (e: FormEvent): void => {
    e.preventDefault()
    const key = parent.trim()
    const value = children.trim()
    if (!key || !value) return
    setPatterns({ ...nesting.patterns, [key]: value })
    setParent('')
    setChildren('')
  }
  const remove = (key: string): void => {
    const { [key]: _removed, ...rest } = nesting.patterns
    setPatterns(rest)
  }
  return (
    <div className="py-1.5">
      <SubHead title={d.filesView.nestingPatterns} desc={d.filesView.nestingPatternsDesc} />
      <ul aria-label={d.filesView.nestingPatterns} className="mb-2 flex flex-col">
        {Object.entries(nesting.patterns).map(([key, value]) => (
          <PatternRow key={key} label={key} detail={value} onRemove={() => remove(key)} />
        ))}
      </ul>
      <form className="flex items-center gap-2" onSubmit={add}>
        <Input
          value={parent}
          spellCheck={false}
          placeholder={d.filesView.nestingParent}
          aria-label={d.filesView.nestingParent}
          onChange={(e) => setParent(e.target.value)}
          className="h-7 w-40 font-mono"
        />
        <Input
          value={children}
          spellCheck={false}
          placeholder={d.filesView.nestingChildren}
          aria-label={d.filesView.nestingChildren}
          onChange={(e) => setChildren(e.target.value)}
          className="h-7 flex-1 font-mono"
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={!parent.trim() || !children.trim()}
        >
          <PlusIcon data-icon="inline-start" />
          {d.filesView.addPattern}
        </Button>
      </form>
      <Button
        variant="ghost"
        size="sm"
        className="mt-2 text-fg-muted"
        onClick={() => setPatterns(DEFAULT_NESTING_PATTERNS)}
      >
        {d.filesView.resetNesting}
      </Button>
    </div>
  )
}

export function FileTreeSettingsGroups(): JSX.Element {
  const d = useDict()
  const files = useSettingsStore((s) => s.files)
  const setFiles = useSettingsStore((s) => s.setFiles)
  const themes = useAvailableIconThemes()
  const iconTheme = themes.some((t) => t.id === files.iconTheme)
    ? files.iconTheme
    : BUILTIN_ICON_THEME
  const orderLabel: Record<FileSortOrder, string> = {
    foldersFirst: d.filesView.foldersFirst,
    mixed: d.filesView.mixed,
  }
  const byLabel: Record<FileSortBy, string> = {
    name: d.filesView.byName,
    type: d.filesView.byType,
  }
  const breadcrumbLabel: Record<BreadcrumbStyle, string> = {
    auto: d.filesView.breadcrumbAuto,
    full: d.filesView.breadcrumbFull,
    short: d.filesView.breadcrumbShort,
  }
  return (
    <>
      <SettingsGroup title={d.filesView.groupTree}>
        <ControlRow label={d.filesView.iconTheme} desc={d.filesView.iconThemeDesc}>
          <SelectField
            label={d.filesView.iconTheme}
            value={iconTheme}
            onChange={(v) => setFiles({ iconTheme: v })}
            options={[
              { value: BUILTIN_ICON_THEME, label: d.filesView.builtinIcons },
              ...themes.map((t) => ({ value: t.id, label: t.label })),
            ]}
          />
        </ControlRow>
        <ControlRow label={d.filesView.breadcrumb} desc={d.filesView.breadcrumbDesc}>
          <SelectField
            label={d.filesView.breadcrumb}
            value={files.breadcrumb}
            onChange={(v) => setFiles({ breadcrumb: v })}
            options={BREADCRUMB_STYLES.map((v) => ({ value: v, label: breadcrumbLabel[v] }))}
          />
        </ControlRow>
        <ToggleRow
          label={d.filesView.compactFolders}
          desc={d.filesView.compactFoldersDesc}
          checked={files.compactFolders}
          onChange={(v) => setFiles({ compactFolders: v })}
        />
        <ControlRow label={d.filesView.sortOrder}>
          <SelectField
            label={d.filesView.sortOrder}
            value={files.sortOrder}
            onChange={(v) => setFiles({ sortOrder: v })}
            options={FILE_SORT_ORDERS.map((v) => ({ value: v, label: orderLabel[v] }))}
            width="w-52"
          />
        </ControlRow>
        <ControlRow label={d.filesView.sortBy} desc={d.filesView.sortByDesc}>
          <SelectField
            label={d.filesView.sortBy}
            value={files.sortBy}
            onChange={(v) => setFiles({ sortBy: v })}
            options={FILE_SORT_BYS.map((v) => ({ value: v, label: byLabel[v] }))}
          />
        </ControlRow>
      </SettingsGroup>
      <SettingsGroup title={d.filesView.groupHidden}>
        <ToggleRow
          label={d.filesView.showExcluded}
          desc={d.filesView.showExcludedDesc}
          checked={files.showExcluded}
          onChange={(v) => setFiles({ showExcluded: v })}
        />
        <ExcludeList />
      </SettingsGroup>
      <SettingsGroup title={d.filesView.groupNesting}>
        <ToggleRow
          label={d.filesView.nesting}
          desc={d.filesView.nestingDesc}
          checked={files.nesting.enabled}
          onChange={(v) => setFiles({ nesting: { ...files.nesting, enabled: v } })}
        />
        {files.nesting.enabled ? <NestingList /> : null}
      </SettingsGroup>
    </>
  )
}
