import {
  OPEN_DIFF_COMMAND,
  OPEN_FILES_COMMAND,
  type OpenedPane,
  parseFileTargets,
  REVEAL_FOLDER_COMMAND,
} from '@shared/files/openFiles'
import { delegate, registerCore } from '@/commands/coreCommand'
import { browserProfileIn, openerOf } from '@/lib/browser/browserProfile'
import {
  markOpenedQuietly,
  openFilesQuietly,
  openRequestedFiles,
  openWaitedFiles,
} from '@/lib/files/openFile'
import { waitOnPanes } from '@/lib/files/openWaits'
import { revealFolder } from '@/lib/files/revealFolder'
import { callerHasFocus, openKeepingFocus, opensQuietly } from '@/lib/panes/callerFocus'
import { focusActivePaneWhenReady } from '@/lib/panes/paneFocus'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useOpenWithStore } from '@/stores/files/openWithStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

export function registerFileOpenCommands(): void {
  registerCore<{ paneId?: string } | undefined>({
    id: 'file.openWith',
    category: 'editor',
    local: true,
    run: (args, ctx) => {
      const paneId = args?.paneId ?? ctx.activePaneId
      if (paneId) useOpenWithStore.getState().open(paneId)
    },
  })

  registerCore<{ path: string }>({
    id: 'editor.open',
    hidden: true,
    capabilities: ['drive-self'],
    target: 'active',
    run: ({ path }, ctx) => {
      if (ctx.activeWorkspaceId && path)
        useLayoutStore.getState().openFile(ctx.activeWorkspaceId, path)
    },
  })

  registerCore<{ files?: unknown; background?: unknown; wait?: unknown }, { opened: OpenedPane[] }>(
    {
      id: OPEN_FILES_COMMAND,
      hidden: true,
      capabilities: ['drive-self'],
      target: 'active',
      run: (args, ctx) => {
        const files = parseFileTargets(args?.files)
        if (!files) throw new Error('expected files: [{ path, line?, column? }]')
        const workspaceId = ctx.activeWorkspaceId
        if (!workspaceId) return { opened: [] }
        const paneId = ctx.activePaneId ?? undefined
        const quiet = opensQuietly(ctx, args?.background)
        if (args?.wait !== true) {
          if (quiet) openFilesQuietly(workspaceId, files, paneId)
          else openRequestedFiles(workspaceId, files, paneId)
          if (!quiet) focusActivePaneWhenReady(workspaceId)
          return { opened: [] }
        }
        const opened = openWaitedFiles(workspaceId, files, paneId, quiet)
        if (!quiet) focusActivePaneWhenReady(workspaceId)
        waitOnPanes(workspaceId, paneId, opened)
        return { opened }
      },
    },
  )

  registerCore<
    {
      title?: unknown
      original?: unknown
      modified?: unknown
      path?: unknown
      background?: unknown
    },
    { opened: OpenedPane[] }
  >({
    id: OPEN_DIFF_COMMAND,
    hidden: true,
    capabilities: ['drive-self'],
    target: 'active',
    run: (args, ctx) => {
      const workspaceId = ctx.activeWorkspaceId
      if (
        typeof args?.title !== 'string' ||
        typeof args.original !== 'string' ||
        typeof args.modified !== 'string' ||
        typeof args.path !== 'string'
      ) {
        throw new Error('expected { title, original, modified, path }')
      }
      if (!workspaceId) return { opened: [] }
      const content = {
        title: args.title,
        original: args.original,
        modified: args.modified,
        path: args.path,
      }
      const open = (): string | null => {
        const before = useLayoutStore.getState().byWorkspace[workspaceId]?.activePaneId
        const paneId = useLayoutStore.getState().openDiff(workspaceId, content)
        if (quiet && before && paneId) useLayoutStore.getState().focusPane(workspaceId, before)
        return paneId
      }
      const quiet = opensQuietly(ctx, args.background)
      const paneId = quiet ? openKeepingFocus(open) : open()
      if (!paneId) return { opened: [] }
      if (quiet) markOpenedQuietly(paneId, content.title)
      else focusActivePaneWhenReady(workspaceId)
      return { opened: [{ path: content.path, paneId }] }
    },
  })

  registerCore<{ path?: unknown }, { revealed: boolean }>({
    id: REVEAL_FOLDER_COMMAND,
    hidden: true,
    capabilities: ['drive-self'],
    target: 'active',
    run: async (args, ctx) => {
      if (typeof args?.path !== 'string' || !args.path.startsWith('/')) {
        throw new Error('expected path: an absolute folder path')
      }
      const workspaceId = ctx.activeWorkspaceId
      if (!workspaceId) return { revealed: false }
      if (ctx.origin === 'remote' && useSandboxStore.getState().enabled[workspaceId] === true) {
        throw new Error('outside-sandbox: a sandboxed workspace cannot show folders')
      }
      if ((await window.ostia.fs.stat(args.path)) !== 'dir') {
        throw new Error('not-a-directory: no such folder inside the file roots')
      }
      revealFolder(workspaceId, args.path)
      return { revealed: true }
    },
  })

  registerCore<{ url?: string; background?: unknown } | undefined>({
    id: 'browser.new',
    hidden: true,
    capabilities: ['browse'],
    target: 'active',
    run: (args, ctx) => {
      const workspaceId = ctx.activeWorkspaceId
      if (!workspaceId) return
      const url = args?.url || 'about:blank'
      const profile = browserProfileIn(workspaceId, openerOf(ctx))
      const show = (): void => useLayoutStore.getState().openBrowser(workspaceId, url, profile)
      if (args?.background !== true) {
        if (callerHasFocus(ctx)) show()
        else openKeepingFocus(show)
        return
      }
      const opened = openKeepingFocus(() =>
        useLayoutStore.getState().openBrowserTab(workspaceId, url, profile, {
          beside: ctx.activePaneId ?? undefined,
          background: true,
        }),
      )
      if (opened) markOpenedQuietly(opened, url)
    },
  })

  registerCore({
    id: 'browser.open',
    category: 'app',
    capabilities: ['browse'],
    run: (_args, ctx) => delegate(ctx, 'browser.new'),
  })
}
