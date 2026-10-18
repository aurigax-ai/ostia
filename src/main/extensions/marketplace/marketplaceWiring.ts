import { join } from 'node:path'
import { OFFICIAL_MARKETPLACE } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { app } from 'electron'
import type { ManagedServers } from '../../lsp/managedServers'
import type { ServerOverrides } from '../../lsp/serverOverrides'
import { readLocale } from '../../platform/settingsFile'
import type { ExtensionConnections } from '../extensionConnections'
import type { ExtensionHost } from '../extensionHost'
import type { ExtensionSecretStore } from '../extensionHostDeps'
import type { ExtensionStore } from '../extensionStore'
import { Marketplace } from './marketplace'
import type { MarketplaceIpc } from './marketplaceIpc'
import { marketplaceId } from './marketplaceSources'

interface MarketplaceStartDeps {
  configDir: () => string
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
  const marketplace = new Marketplace({
    recordsPath: join(app.getPath('userData'), 'marketplaces.json'),
    clonesDir: join(app.getPath('userData'), 'marketplaces'),
    extensionsDir: join(configDir(), 'extensions'),
    builtinIds: () =>
      services.extensionHost
        ?.list()
        .filter((ext) => ext.builtin)
        .map((ext) => ext.id) ?? [],
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
