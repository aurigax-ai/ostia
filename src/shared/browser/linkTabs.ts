export interface BrowserTabOpen {
  guestId: number
  url: string
  background: boolean
}

const TAB_URL = /^https?:\/\//i

export function isTabUrl(url: string): boolean {
  return TAB_URL.test(url)
}
