import { ipcMain } from 'electron'
import { REDACT_TEXT_MAX, unchanged } from '../../shared/privacy/redaction'
import { type Redactor, redactRequestedTexts } from './redaction'

export function registerPrivacyIpc(redactor: Redactor): void {
  ipcMain.handle('privacy:kinds', () => redactor.kinds())
  ipcMain.handle(
    'privacy:redact',
    (_e, texts: unknown) => redactRequestedTexts(redactor, texts) ?? [],
  )
  ipcMain.handle('privacy:preview', (_e, text: unknown) =>
    typeof text === 'string' && text.length <= REDACT_TEXT_MAX
      ? redactor.preview(text)
      : unchanged(''),
  )
}
