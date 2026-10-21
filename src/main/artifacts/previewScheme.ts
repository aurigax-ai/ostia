import { app, type CustomScheme, protocol } from 'electron'
import { PREVIEW_SCHEME } from '../../shared/artifacts/htmlPreview'

const NO_DNS_PREFETCH = ['blink-settings', 'dnsPrefetchingEnabled=false'] as const

export function registerPreviewScheme(others: readonly CustomScheme[] = []): void {
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
    ...others,
  ])
}
