import { seedFromHash } from './pdfFind'

export interface HashWindow {
  location: { hash: string; pathname: string; search: string }
  history: { replaceState: (state: null, title: string, url: string) => void }
  addEventListener: (type: 'hashchange', listener: () => void) => void
}

export interface SeedTarget {
  goTo: (page: number) => void
  find: (query: string) => void
}

export function followHash(win: HashWindow, target: SeedTarget): void {
  const apply = (): void => {
    const seed = seedFromHash(win.location.hash)
    if (seed.page === null && !seed.find) return
    win.history.replaceState(null, '', win.location.pathname + win.location.search)
    if (seed.page !== null) target.goTo(seed.page)
    if (seed.find) target.find(seed.find)
  }
  apply()
  win.addEventListener('hashchange', apply)
}
