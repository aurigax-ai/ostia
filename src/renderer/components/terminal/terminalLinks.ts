import { isPaneVisible } from '@/lib/attention/workspaceActivity'
import { openBrowserAs, openBrowserTabAs } from '@/lib/browser/browserProfile'
import { measureCells } from '@/lib/prompt/usePromptGeometry'
import type { OstiaTerminal, WebLinkHandler } from '@/lib/terminal/ostiaTerminal'
import { createLinkHint } from '@/lib/terminalLinks/linkHint'
import {
  type LinkKind,
  attachLinkClaim,
  attachLinkModifier,
  linkModifierHeld,
  linkSpan,
  terminalLinkTarget,
} from '@/lib/terminalLinks/linkModifier'
import { createAppLinkProvider, hintedLinkHandler } from '@/lib/terminalLinks/terminalAppLinks'
import { createFileLinkProvider } from '@/lib/terminalLinks/terminalFileLinks'
import {
  type LinkPane,
  activateFileLink,
  linkRevealable,
  linksConfinedOnly,
} from '@/lib/terminalLinks/terminalLinkActions'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'
import type { IBufferRange } from '@xterm/xterm'
import type { LinkHintBox } from './TerminalLinkHint'
import type { TerminalSession } from './terminalSession'

const LINK_HINT_DELAY_MS = 400

export interface TerminalLinks {
  webLinks: WebLinkHandler
  openWebLink: (e: MouseEvent, uri: string) => void
  showLinkHint: (kind: LinkKind, range: IBufferRange, url?: string) => void
  hideLinkHint: () => void
  dismissHint: () => void
  attach: (term: OstiaTerminal, screenElement: HTMLElement | null) => () => void
  registerProviders: () => () => void
}

export function createTerminalLinks({
  host,
  paneId,
  workspaceIdRef,
  session,
  setLinkHint,
}: {
  host: HTMLElement
  paneId: string
  workspaceIdRef: { current: string }
  session: TerminalSession
  setLinkHint: (hint: LinkHintBox | null) => void
}): TerminalLinks {
  let term: OstiaTerminal
  let hoveredLink = false
  const hint = createLinkHint<LinkHintBox>(
    LINK_HINT_DELAY_MS,
    () => isPaneVisible(paneId),
    setLinkHint,
  )
  const showLinkHint = (kind: LinkKind, range: IBufferRange, url?: string): void => {
    hoveredLink = true
    hint.show(() => {
      const cells = measureCells(host, term)
      if (!cells) return null
      const span = linkSpan(range, term.buffer.active.viewportY, term.cols)
      return {
        kind,
        url,
        plainClick: term.modes.mouseTrackingMode === 'none',
        left: cells.left + span.start * cells.width,
        top: cells.top + span.row * cells.height,
        width: (span.end - span.start) * cells.width,
        height: cells.height,
      }
    })
  }
  const hideLinkHint = (): void => {
    hoveredLink = false
    hint.hide()
  }
  const openWebLink = (e: MouseEvent, uri: string): void => {
    const target = terminalLinkTarget(uri, e, {
      mac: isMac,
      hasSelection: term.hasSelection(),
      mouseReporting: term.modes.mouseTrackingMode !== 'none',
      linkClick: useSettingsStore.getState().terminal.linkClick,
    })
    if (target === 'same-tab') openBrowserAs(workspaceIdRef.current, uri, 'human')
    else if (target === 'new-tab') openBrowserTabAs(workspaceIdRef.current, uri, 'human')
    else if (target === 'system') window.open(uri, '_blank')
    else if (target === 'app') void window.ostia.openPath.openLink(uri)
  }
  const webLinks: WebLinkHandler = hintedLinkHandler(openWebLink, {
    show: (range, uri) => showLinkHint('web', range, uri),
    hide: hideLinkHint,
  })

  const attach = (attached: OstiaTerminal, screenElement: HTMLElement | null): (() => void) => {
    term = attached
    const detachLinkModifier = attachLinkModifier(host, isMac)
    const detachLinkClaim = screenElement
      ? attachLinkClaim(screenElement, (e) => hoveredLink && linkModifierHeld(e, isMac))
      : () => {}
    const linkMoved = term.onScroll(hint.hide)
    const linkResized = term.onResize(hint.hide)
    window.addEventListener('blur', hint.hide)
    return () => {
      detachLinkModifier()
      detachLinkClaim()
      linkMoved.dispose()
      linkResized.dispose()
      window.removeEventListener('blur', hint.hide)
      hint.hide()
    }
  }

  const registerProviders = (): (() => void) => {
    const linkPane = (): LinkPane => ({
      workspaceId: workspaceIdRef.current,
      paneId,
      cwd: session.cwd,
    })
    const appLinks = term.registerLinkProvider(createAppLinkProvider(term, webLinks))
    const fileLinks = term.registerLinkProvider(
      createFileLinkProvider(term, {
        cwd: () => session.cwd,
        remote: () => session.remote,
        confinedOnly: () => linksConfinedOnly(linkPane()),
        revealable: (path) => linkRevealable(linkPane(), path),
        stat: (path) => window.ostia.fs.stat(path),
        probe: (path) => window.ostia.terminalLinks.probe(paneId, path),
        activate: (action, target) => activateFileLink(linkPane(), action, target),
        modifierHeld: (e) => linkModifierHeld(e, isMac),
        hover: (range, action) => showLinkHint(action, range),
        leave: hideLinkHint,
      }),
    )
    return () => {
      appLinks.dispose()
      fileLinks.dispose()
    }
  }

  return {
    webLinks,
    openWebLink,
    showLinkHint,
    hideLinkHint,
    dismissHint: hint.hide,
    attach,
    registerProviders,
  }
}
