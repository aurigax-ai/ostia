import { type Dict, fmt } from '../../shared/app/dict'

export type PaneBannerText = Dict['native']['paneBanner']

const ERROR_SGR = '\x1b[38;2;239;89;111m'

export function errorBanner(text: string): string {
  return `\r\n${ERROR_SGR} ${text}\x1b[0m\r\n`
}

export function integrationNotLoadedNotice(t: PaneBannerText, reason: string): string {
  return errorBanner(fmt(t.integrationNotLoaded, { reason }))
}
