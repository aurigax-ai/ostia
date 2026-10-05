import { setSettingsFile } from '../monaco/language'
import { settingsJsonDefaults } from '../monaco/settingsLanguage'
import { monaco } from '../monaco/setup'
import { fullSettingsSchema } from './settingsSchema'

export async function registerSettingsSchema(): Promise<void> {
  const path = await window.ostia.settings.path()
  setSettingsFile(path)
  settingsJsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    schemas: [
      {
        uri: 'ostia://settings-schema',
        fileMatch: [monaco.Uri.file(path).toString()],
        schema: fullSettingsSchema(),
      },
    ],
  })
}
