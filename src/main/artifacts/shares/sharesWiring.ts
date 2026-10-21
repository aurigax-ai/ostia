import { clipboard, safeStorage } from 'electron'
import { parsePrivacySettings } from '../../../shared/privacy/redaction'
import { loadJson, saveJson, storePath } from '../../platform/jsonStore'
import { readSettingsFile } from '../../platform/settingsFile'
import type { WorkerScan } from '../../privacy/redactionScan'
import type { ServerAccount } from '../../server/serverAccount'
import type { PortableExport } from '../portableExport'
import { ShareService } from './shareService'
import { ShareStore } from './shareStore'
import { registerSharesIpc } from './sharesIpc'

const PROBE_TIMEOUT_MS = 10_000

interface SharesStartDeps {
  portableExport: PortableExport
  server: ServerAccount
  redactionScan: WorkerScan
}

export function startShares({ portableExport, server, redactionScan }: SharesStartDeps): void {
  const path = storePath('shares', 'global')
  const store = new ShareStore({
    load: () => loadJson<unknown>(path, {}),
    save: (data) => saveJson(path, data, { secure: true }),
    canEncrypt: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (secret) => safeStorage.decryptString(Buffer.from(secret, 'base64')),
  })
  const shares = new ShareService({
    account: server,
    store,
    scan: (text) =>
      redactionScan.scan(text, parsePrivacySettings(readSettingsFile().privacy).redaction.patterns),
    probe: async (url) => {
      try {
        const response = await fetch(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
        return response.status
      } catch {
        return null
      }
    },
    writeClipboard: (text) => clipboard.writeText(text),
  })
  portableExport.useShares(shares)
  registerSharesIpc(shares)
}
