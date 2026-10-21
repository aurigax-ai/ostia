import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { CommandBridge } from '../control/commandBridge'
import { platformEvents } from '../control/events'
import type { ExtensionHost } from '../extensions/extensionHost'
import { registerIconThemeIpc } from '../extensions/iconThemes'
import { describeSkipped, registerKeymapIpc } from '../extensions/keymaps'
import type { LanguageSource } from '../extensions/languagePacks'
import { registerLanguagePackIpc } from '../extensions/languagePacks'
import { registerEditorLanguageIpc } from '../lsp/editorLanguages'
import { registerCompletionIpc } from '../terminal/completionSpecs'
import type { WindowSend } from '../windows/windowSend'
import { registerSameFolder } from './sameFolder'
import {
  ownSnippets,
  registerSnippetIpc,
  registerSnippetMethods,
  type SnippetDeps,
} from './snippets'
import { ViewHost, ViewStore } from './viewHost'
import { registerViewMethods, registerViewsIpc } from './viewsIpc'
import { workDirForWorkspace } from './workspaceRegistry'

interface ContentIpcDeps {
  configDir: () => string
  services: {
    extensionHost: ExtensionHost | null
    viewHost: ViewHost | null
  }
  broadcast: WindowSend['broadcast']
  execCommand: CommandBridge['execCommand']
  languagePackDeps: {
    languages: () => LanguageSource[]
    onError: (extId: string, error: string) => void
  }
}

export function registerContentIpc({
  configDir,
  services,
  broadcast,
  execCommand,
  languagePackDeps,
}: ContentIpcDeps) {
  const snippetDeps: SnippetDeps = {
    userDir: join(configDir(), 'snippets'),
    roots: () => [homedir(), app.getPath('userData')],
    workDirForWorkspace,
    extensionSnippets: () => services.extensionHost?.contributions.snippets() ?? [],
  }
  registerSnippetIpc(snippetDeps)
  registerSnippetMethods(snippetDeps)
  registerCompletionIpc({
    userDir: join(configDir(), 'completions'),
    extensionDirs: () => services.extensionHost?.contributions.completionDirs() ?? [],
  })
  services.viewHost = new ViewHost({
    dir: join(configDir(), 'views'),
    store: new ViewStore(join(app.getPath('userData'), 'views.json')),
    onChange: (listing) => broadcast('views:changed', listing),
    log: (line) => console.warn(`[views] ${line}`),
  })
  registerViewsIpc(services.viewHost)
  registerViewMethods({ host: services.viewHost, execCommand })
  registerIconThemeIpc({
    themes: () => services.extensionHost?.contributions.iconThemes() ?? [],
    onError: (id, error) => console.warn(`[icon theme ${id}] ${error}`),
  })
  registerKeymapIpc({
    keymaps: () => services.extensionHost?.contributions.keymaps() ?? [],
    platform: process.platform,
    onError: (ref, error) => console.warn(`[keymap ${ref}] ${error}`),
    onSkipped: (ref, skipped) =>
      console.warn(`[keymap ${ref}] skipped entries: ${describeSkipped(skipped)}`),
  })
  registerLanguagePackIpc(languagePackDeps)
  registerEditorLanguageIpc({
    languages: () => services.extensionHost?.contributions.editorLanguages() ?? [],
    onError: (extId, error) => console.warn(`[editor language ${extId}] ${error}`),
  })
  platformEvents.on('notify', (n: { title: string; body?: string; from: string }) =>
    services.extensionHost?.events.emitEvent('notification', n),
  )
  registerSameFolder({ workDir: workDirForWorkspace, home: homedir })

  return {
    viewHost: services.viewHost,
    ownSnippets: (workspaceId: string | undefined) => ownSnippets(snippetDeps, workspaceId),
  }
}
