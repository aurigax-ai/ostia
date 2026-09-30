import type { ExtensionSettingValues } from '../../shared/extensions'
import {
  type CommandHandler,
  type PineExtension,
  connect,
  failure,
  namedArgs,
  ok,
  startPanelServer,
} from '../sdk'
import { AssistantService } from './service'

const MODEL_ID_MAX = 200

function panelHandlers(
  service: AssistantService,
  changed: () => void,
): Record<string, CommandHandler> {
  const lifecycle =
    (loaded: boolean): CommandHandler =>
    async (args) => {
      const id = namedArgs(args).id
      if (typeof id !== 'string' || !id || id.length > MODEL_ID_MAX) {
        return failure('invalid-params', 'id is required')
      }
      try {
        await service.setLoaded(id, loaded)
        changed()
        return ok()
      } catch (err) {
        return failure('lifecycle-failed', err instanceof Error ? err.message : String(err))
      }
    }
  return {
    state: async () => ok(undefined, await service.panelState()),
    load: lifecycle(true),
    unload: lifecycle(false),
  }
}

async function apply(
  ext: PineExtension,
  service: AssistantService,
  values: ExtensionSettingValues,
): Promise<void> {
  service.configure(values, await ext.getSecret('apiKey').catch(() => null))
  await ext.setAssistStatus(service.status())
}

async function main(): Promise<void> {
  const ext = await connect()
  const service = new AssistantService()
  ext.onAssist((point, input, ctx) => service.handle(point, input, ctx))
  const panel = await startPanelServer({
    dir: __dirname,
    files: ['panel.html', 'panel.js', 'panel.css', 'base.css'],
    handle: async (command, args, caller) => {
      const handler = panelHandlers(service, () => panel.changed())[command]
      return handler ? handler(args, caller) : failure('unknown-command', command)
    },
  })
  ext.onPanel((caller) => ({
    url: panel.url({ workspaceId: caller.workspaceId ?? '', locale: caller.locale ?? 'en' }),
  }))
  ext.onSettingsChanged((values) => {
    void apply(ext, service, values).then(() => panel.changed())
  })
  await apply(ext, service, await ext.getSettings())
  await ext.registerCommands({
    models: async (_args, caller) => {
      await ext.openPanel(caller.workspaceId)
      return ok()
    },
  })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
