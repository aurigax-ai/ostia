import { randomUUID } from 'node:crypto'
import type { PageScript } from './browsePageScripts'

const MARKER = `[ostia-link-click ${randomUUID()}] `

export const LINK_CLICK_SCRIPT: PageScript = {
  worldName: 'ostia-link-clicks',
  source: `addEventListener('click', (event) => {
  const target = event.target;
  const link = target instanceof Element ? target.closest('a[href], area[href]') : null;
  if (link) console.debug(${JSON.stringify(MARKER)} + link.href);
}, true);`,
}

export function clickedLinkOf(message: string): string | null {
  return message.startsWith(MARKER) ? message.slice(MARKER.length) : null
}
