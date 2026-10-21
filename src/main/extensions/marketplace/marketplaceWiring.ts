import { join } from 'node:path'
import { OFFICIAL_MARKETPLACE } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import {
  type ExtensionRoot,
  readManifest,
} from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'
import { app } from 'electron'
import type { ManagedServers } from '../../lsp/managedServers'
import type { ServerOverrides } from '../../lsp/serverOverrides'
import { readLocale } from '../../platform/settingsFile'
import type { ExtensionConnections } from '../extensionConnections'
import type { ExtensionHost } from '../extensionHost'
import type { ExtensionSecretStore } from '../extensionHostDeps'
import type { ExtensionStore } from '../extensionStore'
import {
  AcceptedVersions,
  OFFICIAL_EXTENSION_PUBLIC_KEY,
  OFFICIAL_REVOCATIONS_FILE,
  OFFICIAL_VERSIONS_FILE,
  OfficialRevocations,
  OfficialVerifier,
} from '../officialExtensions'
import { Marketplace } from './marketplace'
import type { MarketplaceIpc } from './marketplaceIpc'
import { marketplaceId } from './marketplaceSources'

interface MarketplaceStartDeps {
  configDir: () => string
  extensionRoots: () => ExtensionRoot[]
  services: {
    extensionHost: ExtensionHost | null
    marketplaceInstallIds: () => string[]
  }
  managedServers: ManagedServers
  serverOverrides: ServerOverrides
  extensionStore: ExtensionStore
  extensionConnections: () => ExtensionConnections
  extensionSecretStore: () => ExtensionSecretStore
  assistKeyStore: () => ExtensionSecretStore
  registerMarketplaceIpc: MarketplaceIpc['registerMarketplaceIpc']
  officialMarketplaceId: string
}

export function startMarketplace({
  configDir,
  extensionRoots,
  services,
  managedServers,
  serverOverrides,
  extensionStore,
  extensionConnections,
  extensionSecretStore,
  assistKeyStore,
  registerMarketplaceIpc,
  officialMarketplaceId,
}: MarketplaceStartDeps) {
  const revocations = new OfficialRevocations(
    join(app.getPath('userData'), OFFICIAL_REVOCATIONS_FILE),
  )
  const verifier = new OfficialVerifier({
    publicKey: () => OFFICIAL_EXTENSION_PUBLIC_KEY,
    revocations,
    accepted: new AcceptedVersions(join(app.getPath('userData'), OFFICIAL_VERSIONS_FILE)),
    onVerified: () => services.extensionHost?.announce(),
    recordAccepted: false,
  })
  const marketplace = new Marketplace({
    recordsPath: join(app.getPath('userData'), 'marketplaces.json'),
    clonesDir: join(app.getPath('userData'), 'marketplaces'),
    extensionsDir: join(configDir(), 'extensions'),
    bundled: (extId) => {
      const dir = extensionRoots().find((root) => root.builtin)?.dir
      const bundled = dir ? readManifest(join(dir, extId)) : null
      return bundled?.ok ? bundled.manifest : undefined
    },
    officialUpdate: verifier.check,
    verified: () => verifier.settled(),
    disable: (extId) => services.extensionHost?.processes.setEnabled(extId, false),
    saveRevocations: (revoked) => revocations.replace(revoked),
    forget: (extId) => {
      managedServers.forgetExtension(extId)
      serverOverrides.forgetExtension(extId)
      extensionStore.delete(extId)
      extensionConnections().forget(extId)
      for (const secrets of [extensionSecretStore(), assistKeyStore()]) {
        for (const key of secrets.keys(extId)) secrets.set(extId, key, null)
      }
    },
    rescan: () => services.extensionHost?.processes.rescan(),
    locale: readLocale,
    official: OFFICIAL_MARKETPLACE,
  })
  registerMarketplaceIpc(marketplace)
  services.marketplaceInstallIds = () =>
    marketplace
      .syncedInstalls()
      .filter((install) => marketplaceId(install.marketplace) === officialMarketplaceId)
      .map((install) => install.id)

  return { marketplace }
}
