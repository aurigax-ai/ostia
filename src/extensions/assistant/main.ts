import type { ExtensionSettingValues } from '../../shared/extensions'
import { type PineExtension, connect } from '../sdk'
import { AssistantService } from './service'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
  const service = new AssistantService(process.env, undefined, undefined, () => {
    void publish(ext, service)
  })
  ext.onAssist((point, input, ctx) => service.handle(point, input, ctx))
  ext.onAssistModels({
    list: () => service.modelList(),
    setLoaded: (id, loaded) => service.setLoaded(id, loaded),
  })
  ext.onSettingsChanged((values) => {
    void apply(ext, service, values)
  })
  await ext.registerCommands({
    chat: async (_args, caller) => ext.openAssistUi('chat', caller.workspaceId),
  })
  await apply(ext, service, await ext.getSettings())
}

main().catch((err) => {
  console.error(errorText(err))
  process.exit(1)
})
