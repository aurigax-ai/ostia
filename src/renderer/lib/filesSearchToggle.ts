import { useUIStore } from '../stores/uiStore'

export function toggleFilesSearch(): void {
  const ui = useUIStore.getState()
  const focused = document.activeElement
  const inSearch = focused instanceof Element && focused.closest('.files-search') !== null
  if (ui.filesOpen && ui.filesSearchOpen && inSearch) ui.closeFilesSearch()
  else ui.searchFiles()
}
