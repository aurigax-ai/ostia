import { join } from 'node:path'
import { OFFICIAL_MARKETPLACE } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { app, ipcMain } from 'electron'
import { EXTENSION_SUGGESTIONS } from '../../../shared/extensions/extensionSuggestions'
import { getByPaneId } from '../../control/idRegistry'
import type { OpenFileGrants } from '../../files/openFileGrants'
import type { ExtensionHost } from '../extensionHost'
import { DismissedSuggestions, suggestionFor } from './extensionSuggestions'
import type { Marketplace } from './marketplace'

interface MarketplaceIpcDeps {
  openFileGrants: OpenFileGrants
  services: {
    extensionHost: ExtensionHost | null
  }
  officialMarketplaceId: string
  editorLanguageOf: (path: string) => string
}

export type MarketplaceIpc = ReturnType<typeof createMarketplaceIpc>

export function createMarketplaceIpc({
  openFileGrants,
  services,
  officialMarketplaceId,
  editorLanguageOf,
}: MarketplaceIpcDeps) {
  function registerMarketplaceIpc(marketplace: Marketplace): void {
    ipcMain.handle('marketplace:list', () => marketplace.state())
    ipcMain.handle('marketplace:add', (_e, url: unknown) => marketplace.add(url))
    ipcMain.handle('marketplace:remove', (_e, id: unknown, uninstallExtensions: unknown) =>
      marketplace.remove(id, uninstallExtensions),
    )
    ipcMain.handle('marketplace:refresh', (_e, id: unknown) => marketplace.refresh(id))
    ipcMain.handle(
      'marketplace:install',
      (_e, id: unknown, extId: unknown, confirmDowngrade: unknown) =>
        marketplace.install(id, extId, confirmDowngrade),
    )
    ipcMain.handle('marketplace:find-code', (_e, code: unknown) => marketplace.findCode(code))
    ipcMain.handle('marketplace:install-code', (_e, id: unknown, code: unknown) =>
      marketplace.installCode(id, code),
    )
    ipcMain.handle('marketplace:uninstall', (_e, extId: unknown) => marketplace.uninstall(extId))
    ipcMain.handle('marketplace:set-prerelease', (_e, extId: unknown, enabled: unknown) =>
      marketplace.setPrerelease(extId, enabled),
    )
    ipcMain.handle('marketplace:install-dev', (_e, source: unknown) =>
      marketplace.installDev(source),
    )

    const dismissed = new DismissedSuggestions(
      join(app.getPath('userData'), 'extension-suggestions.json'),
    )
    ipcMain.handle('suggestions:for-file', (e, paneId: unknown, path: unknown) => {
      if (typeof paneId !== 'string' || typeof path !== 'string') return null
      if (getByPaneId(paneId)?.windowId !== String(e.sender.id)) return null
      const file = openFileGrants.confine(path)
      if (file === null) return null
      return suggestionFor(file, {
        servers: () => services.extensionHost?.contributions.languageServers() ?? [],
        extensions: () => services.extensionHost?.list() ?? [],
        listings: () => marketplace.listings(),
        dismissed: () => dismissed.list(),
        official: officialMarketplaceId,
        languageOf: editorLanguageOf,
      })
    })
    ipcMain.handle('suggestions:dismiss', (_e, extId: unknown) => dismissed.dismiss(extId))
    ipcMain.handle('suggestions:install', (_e, extId: unknown) =>
      marketplace.installSuggested(
        extId,
        OFFICIAL_MARKETPLACE,
        typeof extId === 'string' && Object.hasOwn(EXTENSION_SUGGESTIONS, extId),
      ),
    )
  }

  return { registerMarketplaceIpc }
}
