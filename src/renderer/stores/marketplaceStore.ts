import type { MarketplaceError, MarketplaceResult, MarketplaceState } from '@shared/marketplace'
import { create } from 'zustand'

export interface MarketplaceFailure {
  error: MarketplaceError
  detail?: string
}

interface MarketplaceStoreState {
  state: MarketplaceState
  loaded: boolean
  busy: boolean
  failure: MarketplaceFailure | null
  load: () => Promise<void>
  add: (url: string) => Promise<boolean>
  remove: (marketplaceId: string, uninstallExtensions: boolean) => Promise<boolean>
  refresh: (marketplaceId: string) => Promise<boolean>
  install: (marketplaceId: string, extId: string) => Promise<boolean>
  installCode: (marketplaceId: string, code: string) => Promise<boolean>
  uninstall: (extId: string) => Promise<boolean>
}

export const useMarketplaceStore = create<MarketplaceStoreState>((set) => {
  const run = async (call: () => Promise<MarketplaceResult>): Promise<boolean> => {
    set({ busy: true, failure: null })
    const res = await call()
    set({
      busy: false,
      state: res.state,
      failure: res.ok ? null : { error: res.error, ...(res.detail ? { detail: res.detail } : {}) },
    })
    return res.ok
  }
  return {
    state: { marketplaces: [], installed: [] },
    loaded: false,
    busy: false,
    failure: null,
    load: async () => set({ state: await window.ostia.marketplace.list(), loaded: true }),
    add: (url) => run(() => window.ostia.marketplace.add(url)),
    remove: (id, uninstallExtensions) =>
      run(() => window.ostia.marketplace.remove(id, uninstallExtensions)),
    refresh: (id) => run(() => window.ostia.marketplace.refresh(id)),
    install: (id, extId) => run(() => window.ostia.marketplace.install(id, extId)),
    installCode: (id, code) => run(() => window.ostia.marketplace.installCode(id, code)),
    uninstall: (extId) => run(() => window.ostia.marketplace.uninstall(extId)),
  }
})
