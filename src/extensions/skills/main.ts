import {
  type CommandHandler,
  connect,
  createTranslator,
  failure,
  ok,
  startPanelServer,
} from '@aurigax-ai/ostia-extension-sdk'
import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { skillsService } from './service'
import { RulesStore } from './store'

const PANEL_FILES = ['panel.html', 'panel.js', 'panel.css', 'base.css']

async function main(): Promise<void> {
  const ext = await connect()
  const store = new RulesStore(readEnv('EXTENSION_DATA') ?? null, Date.now)
  const panelStarting = startPanelServer({
    dir: __dirname,
    files: PANEL_FILES,
    handle: async (command, args, caller) => {
      const handler = service.panel[command]
      return handler ? handler(args, caller) : failure('unknown-command', command)
    },
  })
  let panelChanged = (): void => {}
  const translate = createTranslator()
  const service = skillsService({
    store,
    redact: (texts) => ext.redact(texts),
    workspace: async (workspaceId) => {
      const listed = await ext.listWorkspaces().catch(() => [])
      const found = (Array.isArray(listed) ? listed : []).find(
        (w: { workspaceId?: string }) => w.workspaceId === workspaceId,
      )
      return typeof found?.kind === 'string' && typeof found.workDir === 'string'
        ? { kind: found.kind, workDir: found.workDir }
        : null
    },
    confirmDelete: (rule, locale) => {
      const t = translate(locale)
      return ext.confirm({
        title: t('delete.title'),
        message: t('delete.message', { rule }),
        confirmLabel: t('delete.confirm'),
        cancelLabel: t('cancel'),
      })
    },
    changed: () => panelChanged(),
  })
  ext.onPanel(async (caller) => ({
    url: (await panelStarting).url({
      workspaceId: caller.workspaceId ?? '',
      locale: caller.locale ?? '',
    }),
  }))
  const handlers: Record<string, CommandHandler> = {
    open: async (_args, caller) => {
      await ext.openPanel(caller.workspaceId)
      return ok()
    },
    'on-session': (_args, caller) => service.onSession(undefined, caller),
  }
  await ext.registerCommands(handlers)
  panelChanged = () => void panelStarting.then((panel) => panel.changed())
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
