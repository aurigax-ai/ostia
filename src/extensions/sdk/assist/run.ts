import { type PineExtension, connect } from '..'
import type { AssistProviderEntry } from '../../../shared/assist'
import type { ExtensionSettingValues } from '../../../shared/extensions'
import type { ProviderCatalog } from './provider'
import { AssistantService } from './service'

export interface AssistExtensionOptions {
  catalog: ProviderCatalog
  provider?: string
}

async function publish(ext: PineExtension, service: AssistantService): Promise<void> {
  await ext.setAssistStatus(service.report()).catch(() => undefined)
}

function fixedEntry(kind: string, values: ExtensionSettingValues): AssistProviderEntry {
  const baseUrl = typeof values.baseUrl === 'string' ? values.baseUrl.trim() : ''
  return { id: kind, kind, name: '', baseUrl, models: [], apiKey: null }
}

async function run(options: AssistExtensionOptions): Promise<void> {
  Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false })
  const ext = await connect()
  const fixed = options.provider
  const service = new AssistantService(
    options.catalog,
    process.env,
    undefined,
    () => {
      void publish(ext, service)
    },
    fixed ? { listedModels: true } : { configurable: true },
  )
  let values: ExtensionSettingValues = {}
  let entries: AssistProviderEntry[] = []
  const apply = async (): Promise<void> => {
    service.configure(values, fixed ? [fixedEntry(fixed, values)] : entries)
    await publish(ext, service)
    await service.probe()
    await publish(ext, service)
  }
  ext.onAssist((point, input, ctx) => service.handle(point, input, ctx))
  ext.onAssistModels({
    list: (provider) => service.modelList(provider),
    setLoaded: (id, loaded, provider) => service.setLoaded(id, loaded, provider),
  })
  ext.onSettingsChanged((next) => {
    values = next
    void apply()
  })
  ext.onAssistProvidersChanged((next) => {
    entries = next
    void apply()
  })
  ext.onLocaleChanged((locale) => {
    service.setLocale(locale)
    void publish(ext, service)
  })
  await ext.registerCommands({
    chat: async (_args, caller) => ext.openAssistUi('chat', caller.workspaceId),
  })
  service.setLocale(await ext.getLocale().catch(() => 'en'))
  values = await ext.getSettings()
  entries = fixed ? [] : await ext.getAssistProviders().catch(() => [])
  await apply()
}

export function runAssistExtension(options: AssistExtensionOptions): void {
  run(options).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
