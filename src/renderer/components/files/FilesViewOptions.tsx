import { BUILTIN_ICON_THEME } from '@aurigax-ai/ostia-extension-sdk/contract/iconTheme'
import { SlidersHorizontalIcon } from '@phosphor-icons/react'
import type { JSX } from 'react'
import { IconButton } from '@/components/common/IconButton'
import {
  DropdownMenu,
  MenuCheckboxItem,
  MenuLabel,
  MenuRadioItem,
  MenuSubContent,
  MenuSubTrigger,
} from '@/components/common/Menu'
import {
  ContextMenuGroup,
  ContextMenuRadioGroup,
  ContextMenuSeparator,
  ContextMenuSub,
} from '@/components/ui/context-menu'
import { useDict } from '@/lib/app/useDict'
import type { FileSortBy, FileSortOrder, FileTreeSettings } from '@/lib/settings/fileTreeSettings'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useAvailableIconThemes } from '@/stores/extensions/iconThemeStore'

export function FilesViewOptions({ settings }: { settings: FileTreeSettings }): JSX.Element {
  const d = useDict()
  const setFiles = useSettingsStore((s) => s.setFiles)
  const themes = useAvailableIconThemes()
  const themeIds = themes.map((t) => t.id)
  const currentTheme = themeIds.includes(settings.iconTheme)
    ? settings.iconTheme
    : BUILTIN_ICON_THEME
  return (
    <DropdownMenu
      trigger={<IconButton icon={SlidersHorizontalIcon} label={d.filesView.viewOptions} />}
    >
      <MenuCheckboxItem
        checked={settings.compactFolders}
        onCheckedChange={(v) => setFiles({ compactFolders: v })}
      >
        {d.filesView.compactFolders}
      </MenuCheckboxItem>
      <MenuCheckboxItem
        checked={settings.nesting.enabled}
        onCheckedChange={(v) => setFiles({ nesting: { ...settings.nesting, enabled: v } })}
      >
        {d.filesView.nesting}
      </MenuCheckboxItem>
      <MenuCheckboxItem
        checked={settings.showExcluded}
        onCheckedChange={(v) => setFiles({ showExcluded: v })}
      >
        {d.filesView.showExcluded}
      </MenuCheckboxItem>
      <ContextMenuSeparator />
      <ContextMenuGroup>
        <MenuLabel>{d.filesView.sort}</MenuLabel>
        <ContextMenuRadioGroup
          value={settings.sortOrder}
          onValueChange={(v) => setFiles({ sortOrder: v as FileSortOrder })}
        >
          <MenuRadioItem value="foldersFirst">{d.filesView.foldersFirst}</MenuRadioItem>
          <MenuRadioItem value="mixed">{d.filesView.mixed}</MenuRadioItem>
        </ContextMenuRadioGroup>
        <ContextMenuSeparator />
        <ContextMenuRadioGroup
          value={settings.sortBy}
          onValueChange={(v) => setFiles({ sortBy: v as FileSortBy })}
        >
          <MenuRadioItem value="name">{d.filesView.byName}</MenuRadioItem>
          <MenuRadioItem value="type">{d.filesView.byType}</MenuRadioItem>
        </ContextMenuRadioGroup>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuSub>
        <MenuSubTrigger>{d.filesView.iconTheme}</MenuSubTrigger>
        <MenuSubContent>
          <ContextMenuRadioGroup
            value={currentTheme}
            onValueChange={(v) => setFiles({ iconTheme: String(v) })}
          >
            <MenuRadioItem value={BUILTIN_ICON_THEME}>{d.filesView.builtinIcons}</MenuRadioItem>
            {themes.map((t) => (
              <MenuRadioItem key={t.id} value={t.id}>
                {t.label}
              </MenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </MenuSubContent>
      </ContextMenuSub>
    </DropdownMenu>
  )
}
