import { stepZoom } from '@shared/app/zoom'
import { registerCore } from '@/commands/coreCommand'
import { resetZoom } from '@/lib/app/wheelZoom'
import {
  FILES_PREFIX,
  GO_TO_FILE_COMMAND,
  GO_TO_WORKSPACE_COMMAND,
  GO_TO_WORKSPACE_SYMBOL_COMMAND,
  SYMBOLS_PREFIX,
  WORKSPACES_PREFIX,
} from '@/lib/palette/paletteModes'
import { focusActivePaneWhenReady } from '@/lib/panes/paneFocus'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useUpdateStore } from '@/stores/app/updateStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

function registerViewCommands(): void {
  registerCore({
    id: 'palette.toggle',
    category: 'view',
    target: 'none',
    run: () => useUIStore.getState().togglePalette(),
  })

  registerCore({
    id: 'palette.searchEverywhere',
    category: 'view',
    target: 'none',
    run: () => useUIStore.getState().openPalette('everywhere'),
  })

  registerCore({
    id: GO_TO_FILE_COMMAND,
    category: 'view',
    target: 'none',
    run: () => useUIStore.getState().openPalette('search', FILES_PREFIX),
  })

  registerCore({
    id: GO_TO_WORKSPACE_COMMAND,
    category: 'view',
    target: 'none',
    run: () => useUIStore.getState().openPalette('search', WORKSPACES_PREFIX),
  })

  registerCore({
    id: GO_TO_WORKSPACE_SYMBOL_COMMAND,
    category: 'view',
    target: 'none',
    run: () => useUIStore.getState().openPalette('search', SYMBOLS_PREFIX),
  })

  registerCore({
    id: 'view.toggleRail',
    category: 'view',
    target: 'none',
    run: () => useUIStore.getState().toggleRail(),
  })

  registerCore({
    id: 'view.searchFiles',
    category: 'view',
    target: 'none',
    run: () => {
      const ui = useUIStore.getState()
      if (!ui.filesOpen) {
        ui.searchFiles()
        return
      }
      const focused = document.activeElement
      if (focused instanceof Element && focused.closest('#files-panel')) {
        ui.toggleFiles()
        const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
        if (workspaceId) focusActivePaneWhenReady(workspaceId)
        return
      }
      ui.searchFiles()
    },
  })

  const zoomBy = (direction: 1 | -1): void => {
    const settings = useSettingsStore.getState()
    settings.setZoom(stepZoom(settings.appearance.zoom, direction))
  }

  registerCore({
    id: 'view.zoomIn',
    category: 'view',
    target: 'none',
    run: () => zoomBy(1),
  })

  registerCore({
    id: 'view.zoomOut',
    category: 'view',
    target: 'none',
    run: () => zoomBy(-1),
  })

  registerCore({
    id: 'view.zoomReset',
    category: 'view',
    target: 'none',
    run: resetZoom,
  })
}

function registerAppCommands(): void {
  registerCore({
    id: 'app.openSettings',
    category: 'app',
    target: 'none',
    run: () => useUIStore.getState().openSettings(),
  })

  registerCore({
    id: 'app.browseExtensions',
    category: 'app',
    target: 'none',
    run: () => useUIStore.getState().openBrowseExtensions(),
  })

  registerCore({
    id: 'assist.settings',
    category: 'assistant',
    target: 'none',
    run: () => useUIStore.getState().openSettings('assistant'),
  })

  registerCore({
    id: 'app.checkForUpdates',
    category: 'app',
    local: true,
    target: 'none',
    run: () => {
      useUIStore.getState().openSettings('about')
      void useUpdateStore.getState().checkForUpdates()
    },
  })

  registerCore({
    id: 'app.quit',
    category: 'app',
    target: 'none',
    capabilities: ['destructive'],
    run: () => window.ostia.window.quit(),
  })

  registerCore({
    id: 'developer.toggleDevTools',
    category: 'developer',
    target: 'none',
    capabilities: ['destructive'],
    run: () => window.ostia.diagnostics.toggleDevTools(),
  })

  registerCore<undefined, { opened: boolean }>({
    id: 'developer.openLogFolder',
    category: 'developer',
    target: 'none',
    capabilities: ['drive-self'],
    run: async () => ({ opened: await window.ostia.diagnostics.openLogFolder() }),
  })
}

export function registerAppViewCommands(): void {
  registerViewCommands()
  registerAppCommands()
}
