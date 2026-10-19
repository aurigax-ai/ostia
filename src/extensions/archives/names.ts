import { BROWSE_NAME_BYTES } from '@aurigax-ai/ostia-extension-sdk/contract/fileBrowse'

const ELLIPSIS = '…'

export function shownName(name: string): string {
  if (Buffer.byteLength(name) <= BROWSE_NAME_BYTES) return name
  const room = BROWSE_NAME_BYTES - Buffer.byteLength(ELLIPSIS)
  const cut = Buffer.from(name).subarray(0, room).toString('utf8').replace(/�+$/, '')
  return `${cut}${ELLIPSIS}`
}

export function shownLink(link: string, limit: number): string {
  return Buffer.byteLength(link) <= limit ? link : ''
}
