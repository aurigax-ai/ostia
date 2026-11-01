import { isPaneVisible } from '@/lib/attention/workspaceActivity'
import { openBrowserAs, openBrowserTabAs } from '@/lib/browser/browserProfile'
import { measureCells } from '@/lib/prompt/usePromptGeometry'
import type { OstiaTerminal, TerminalRange, WebLinkHandler } from '@/lib/terminal/ostiaTerminal'
import { openAppLink } from '@/lib/terminalLinks/appLinkOpen'
import { createLinkHint } from '@/lib/terminalLinks/linkHint'
import {
  attachLinkClaim,
  attachLinkModifier,
  type LinkKind,
  linkModifierHeld,
  linkSpan,
  type PathLinkTarget,
  pathLinkTarget,
  terminalLinkTarget,
} from '@/lib/terminalLinks/linkModifier'
import { createAppLinkProvider, hintedLinkHandler } from '@/lib/terminalLinks/terminalAppLinks'
import { createFileLinkProvider } from '@/lib/terminalLinks/terminalFileLinks'
import {
  createFileUrlLinks,
  fileUrlOffers,
  withFileUrls,
} from '@/lib/terminalLinks/terminalFileUrls'
import {
  activateFileLink,
  activateFileUrl,
  fileUrlPreviews,
  type LinkPane,
  linkRevealable,
  linksConfinedOnly,
} from '@/lib/terminalLinks/terminalLinkActions'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'
import type { LinkHintBox } from './TerminalLinkHint'
import type { TerminalSession } from './terminalSession'

const LINK_HINT_DELAY_MS = 400

export interface TerminalLinks {
  webLinks: WebLinkHandler
  openWebLink: (e: MouseEvent, uri: string) => void
  showLinkHint: (
    kind: LinkKind,
    range: TerminalRange,
    url?: string,
    offers?: PathLinkTarget[],
  ) => void
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
  const showLinkHint = (
    kind: LinkKind,
    range: TerminalRange,
    url?: string,
    offers?: PathLinkTarget[],
  ): void => {
    hoveredLink = true
    hint.show(() => {
      const cells = measureCells(host, term)
      if (!cells) return null
      const span = linkSpan(range, term.buffer.active.viewportY, term.cols)
      return {
        kind,
        url,
        offers,
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
    else if (target === 'app') void openAppLink(paneId, uri)
  }
  const linkPane = (): LinkPane => ({
    workspaceId: workspaceIdRef.current,
    paneId,
    cwd: session.cwd,
  })
  const pathTarget = (e: MouseEvent): PathLinkTarget | null =>
    pathLinkTarget(e, {
      mac: isMac,
      linkClick: useSettingsStore.getState().terminal.linkClick,
    })
  const fileUrls = createFileUrlLinks({
    remote: () => session.remote,
    check: (url) => window.ostia.terminalLinks.fileUrl(paneId, url),
    previews: (target) => fileUrlPreviews(linkPane(), target),
    target: pathTarget,
    activate: (how, url, target, action) => activateFileUrl(linkPane(), how, url, target, action),
    hover: (range, target, action) =>
      showLinkHint(action, range, target.path, fileUrlOffers(action)),
    leave: hideLinkHint,
  })
  const webLinks: WebLinkHandler = withFileUrls(
    hintedLinkHandler(openWebLink, {
      show: (range, uri) => showLinkHint('web', range, uri),
      hide: hideLinkHint,
    }),
    fileUrls,
  )

  const attach = (attached: OstiaTerminal, screenElement: HTMLElement | null): (() => void) => {
    term = attached
    const detachLinkModifier = attachLinkModifier(host, isMac)
    const detachLinkClaim = screenElement
      ? attachLinkClaim(screenElement, (e) => hoveredLink && linkModifierHeld(e, isMac))
      : () => {}
    const linkMoved = term.onScroll(hint.hide)
    const linkResized = term.onResize(hint.hide)
    window.addEventListener('blur', hint.hide)
    host.addEventListener('mousedown', hint.hide, true)
    return () => {
      detachLinkModifier()
      detachLinkClaim()
      linkMoved.dispose()
      linkResized.dispose()
      window.removeEventListener('blur', hint.hide)
      host.removeEventListener('mousedown', hint.hide, true)
      hint.hide()
    }
  }

  const registerProviders = (): (() => void) => {
    const appLinks = term.registerLinkProvider(createAppLinkProvider(term, webLinks))
    const fileUrlLinks = term.registerLinkProvider(fileUrls.provider(term))
    const fileLinks = term.registerLinkProvider(
      createFileLinkProvider(term, {
        cwd: () => session.cwd,
        remote: () => session.remote,
        confinedOnly: () => linksConfinedOnly(linkPane()),
        revealable: (path) => linkRevealable(linkPane(), path),
        stat: (path) => window.ostia.fs.stat(path),
        probe: (path) => window.ostia.terminalLinks.probe(paneId, path),
        activate: (how, action, target) => activateFileLink(linkPane(), how, action, target),
        target: pathTarget,
        hover: (range, action, offers) => showLinkHint(action, range, undefined, offers),
        leave: hideLinkHint,
      }),
    )
    return () => {
      appLinks.dispose()
      fileUrlLinks.dispose()
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
