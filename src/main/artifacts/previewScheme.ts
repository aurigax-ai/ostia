import { app, protocol } from 'electron'
import { PREVIEW_SCHEME } from '../../shared/htmlPreview'

export const NO_DNS_PREFETCH = ['blink-settings', 'dnsPrefetchingEnabled=false'] as const

export function registerPreviewScheme(): void {
  app.commandLine.appendSwitch(...NO_DNS_PREFETCH)
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}
