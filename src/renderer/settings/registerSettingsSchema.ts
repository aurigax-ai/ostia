import { monaco } from '../monaco/setup'
import { fullSettingsSchema } from './settingsSchema'

export async function registerSettingsSchema(): Promise<void> {
  const path = await window.pine.settings.path()
  const uri = monaco.Uri.file(path).toString()
  const json = monaco.languages.json as unknown as {
    jsonDefaults: { setDiagnosticsOptions: (options: unknown) => void }
  }
  json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    schemas: [
      {
        uri: 'pine://settings-schema',
        fileMatch: [uri],
        schema: fullSettingsSchema(),
      },
    ],
  })
}
