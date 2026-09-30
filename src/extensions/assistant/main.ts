import {
  ASSIST_FEATURES,
  ASSIST_UIS,
  type AssistFeatureId,
  type AssistUi,
} from '../../shared/assist'
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
export const SHORTCUT_IDS = ['assist.chat', 'palette.toggle', 'assist.compose']

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function panelHandlers(
  ext: PineExtension,
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
        return failure('lifecycle-failed', errorText(err))
      }
    }
  return {
    state: async () => {
      const state = await service.panelState()
      state.shortcuts = await ext.getShortcuts(SHORTCUT_IDS).catch(() => ({}))
      return ok(undefined, state)
    },
    load: lifecycle(true),
    unload: lifecycle(false),
    toggle: async (args) => {
      const { feature, on } = namedArgs(args)
      if (!ASSIST_FEATURES.includes(feature as AssistFeatureId) || typeof on !== 'boolean') {
        return failure('invalid-params', 'feature and on are required')
      }
      return ext.setSetting(feature as string, on)
    },
    try: async (args, caller) => {
      const ui = namedArgs(args).ui
      if (!ASSIST_UIS.includes(ui as AssistUi)) return failure('invalid-params', 'unknown ui')
      return ext.openAssistUi(ui as AssistUi, caller.workspaceId)
    },
  }
}

async function publish(ext: PineExtension, service: AssistantService): Promise<void> {
  await ext.setAssistStatus(service.report()).catch(() => undefined)
}

async function apply(
  ext: PineExtension,
  service: AssistantService,
  values: ExtensionSettingValues,
): Promise<void> {
  service.configure(values, await ext.getSecret('apiKey').catch(() => null))
  await publish(ext, service)
  await service.probe()
  await publish(ext, service)
}

async function main(): Promise<void> {
  Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false })
  const ext = await connect()
  let changed = (): void => {}
  const service = new AssistantService(process.env, undefined, undefined, () => {
    void publish(ext, service).then(() => changed())
  })
  ext.onAssist((point, input, ctx) => service.handle(point, input, ctx))
  const panel = await startPanelServer({
    dir: __dirname,
    files: ['panel.html', 'panel.js', 'panel.css', 'base.css'],
    handle: async (command, args, caller) => {
      const handler = panelHandlers(ext, service, () => panel.changed())[command]
      return handler ? handler(args, caller) : failure('unknown-command', command)
    },
  })
  changed = () => panel.changed()
  ext.onPanel((caller) => ({
    url: panel.url({ workspaceId: caller.workspaceId ?? '', locale: caller.locale ?? 'en' }),
  }))
  ext.onSettingsChanged((values) => {
    void apply(ext, service, values).then(() => panel.changed())
  })
  await ext.registerCommands({
    open: async (_args, caller) => {
      await ext.openPanel(caller.workspaceId)
      return ok()
    },
    chat: async (_args, caller) => ext.openAssistUi('chat', caller.workspaceId),
  })
  await apply(ext, service, await ext.getSettings())
}

main().catch((err) => {
  console.error(errorText(err))
  process.exit(1)
})
