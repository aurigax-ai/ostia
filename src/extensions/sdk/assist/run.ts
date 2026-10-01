import { type PineExtension, connect } from '..'
import type { ExtensionSettingValues } from '../../../shared/extensions'
import type { ProviderCatalog } from './provider'
import { AssistantService } from './service'

export interface AssistExtensionOptions {
  catalog: ProviderCatalog
  provider?: string
  secret?: string
}

async function publish(ext: PineExtension, service: AssistantService): Promise<void> {
  await ext.setAssistStatus(service.report()).catch(() => undefined)
}

async function apply(
  ext: PineExtension,
  service: AssistantService,
  options: AssistExtensionOptions,
  values: ExtensionSettingValues,
): Promise<void> {
  const apiKey = options.secret ? await ext.getSecret(options.secret).catch(() => null) : null
  service.configure(options.provider ? { ...values, provider: options.provider } : values, apiKey)
  await publish(ext, service)
  await service.probe()
  await publish(ext, service)
}

async function run(options: AssistExtensionOptions): Promise<void> {
  Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false })
  const ext = await connect()
  const service = new AssistantService(options.catalog, process.env, undefined, () => {
    void publish(ext, service)
  })
  ext.onAssist((point, input, ctx) => service.handle(point, input, ctx))
  ext.onAssistModels({
    list: () => service.modelList(),
    setLoaded: (id, loaded) => service.setLoaded(id, loaded),
  })
  ext.onSettingsChanged((values) => {
    void apply(ext, service, options, values)
  })
  await ext.registerCommands({
    chat: async (_args, caller) => ext.openAssistUi('chat', caller.workspaceId),
  })
  await apply(ext, service, options, await ext.getSettings())
}

export function runAssistExtension(options: AssistExtensionOptions): void {
  run(options).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
