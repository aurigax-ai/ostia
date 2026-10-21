import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachLinkClaim,
  attachLinkModifier,
  LINK_MODIFIER_CLASS,
  linkSpan,
  pathLinkTarget,
  terminalLinkTarget,
  webLinkTarget,
} from './linkModifier'

describe('attachLinkModifier', () => {
  let detach: (() => void) | null = null
  afterEach(() => {
    detach?.()
    detach = null
  })

  it('marks the host while Ctrl is held and clears it on release', () => {
    const host = document.createElement('div')
    detach = attachLinkModifier(host, false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }))
    expect(host.classList.contains(LINK_MODIFIER_CLASS)).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', ctrlKey: false }))
    expect(host.classList.contains(LINK_MODIFIER_CLASS)).toBe(false)
  })

  it('uses Cmd instead of Ctrl on macOS', () => {
    const host = document.createElement('div')
    detach = attachLinkModifier(host, true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }))
    expect(host.classList.contains(LINK_MODIFIER_CLASS)).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }))
    expect(host.classList.contains(LINK_MODIFIER_CLASS)).toBe(true)
  })

  it('follows the modifier state of mouse moves and clears on window blur', () => {
    const host = document.createElement('div')
    detach = attachLinkModifier(host, false)
    host.dispatchEvent(new MouseEvent('mousemove', { ctrlKey: true }))
    expect(host.classList.contains(LINK_MODIFIER_CLASS)).toBe(true)
    window.dispatchEvent(new Event('blur'))
    expect(host.classList.contains(LINK_MODIFIER_CLASS)).toBe(false)
  })
})

describe('pathLinkTarget', () => {
  const none = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }
  const linux = { mac: false, linkClick: 'app' as const }

  it('opens in Ostia on Ctrl+click, with the default app on Ctrl+Shift+click, and shows the folder with Alt', () => {
    expect(pathLinkTarget({ ...none, ctrlKey: true }, linux)).toBe('open')
    expect(pathLinkTarget({ ...none, ctrlKey: true, shiftKey: true }, linux)).toBe('open-system')
    expect(pathLinkTarget({ ...none, ctrlKey: true, altKey: true }, linux)).toBe('show')
    expect(pathLinkTarget({ ...none, ctrlKey: true, altKey: true, shiftKey: true }, linux)).toBe(
      'show-system',
    )
  })

  it('does nothing without the link modifier, Alt and Shift included', () => {
    expect(pathLinkTarget(none, linux)).toBe(null)
    expect(pathLinkTarget({ ...none, altKey: true }, linux)).toBe(null)
    expect(pathLinkTarget({ ...none, shiftKey: true, altKey: true }, linux)).toBe(null)
  })

  it('uses Cmd instead of Ctrl on macOS', () => {
    const mac = { ...linux, mac: true }
    expect(pathLinkTarget({ ...none, metaKey: true }, mac)).toBe('open')
    expect(pathLinkTarget({ ...none, metaKey: true, shiftKey: true }, mac)).toBe('open-system')
    expect(pathLinkTarget({ ...none, metaKey: true, altKey: true }, mac)).toBe('show')
    expect(pathLinkTarget({ ...none, ctrlKey: true }, mac)).toBe(null)
  })

  it('swaps Ostia and the system on both pairs when terminal.linkClick is system', () => {
    const swapped = { ...linux, linkClick: 'system' as const }
    expect(pathLinkTarget({ ...none, ctrlKey: true }, swapped)).toBe('open-system')
    expect(pathLinkTarget({ ...none, ctrlKey: true, shiftKey: true }, swapped)).toBe('open')
    expect(pathLinkTarget({ ...none, ctrlKey: true, altKey: true }, swapped)).toBe('show-system')
    expect(pathLinkTarget({ ...none, ctrlKey: true, altKey: true, shiftKey: true }, swapped)).toBe(
      'show',
    )
  })
})

describe('webLinkTarget', () => {
  const plain = { ctrlKey: false, metaKey: false, shiftKey: false, detail: 1 }
  const idle = { mac: false, hasSelection: false, mouseReporting: false, linkClick: 'app' as const }

  it('opens a plain click in the same browser tab', () => {
    expect(webLinkTarget(plain, idle)).toBe('same-tab')
  })

  it('opens a Ctrl+click in a new browser tab and Ctrl+Shift+click in the system browser', () => {
    expect(webLinkTarget({ ...plain, ctrlKey: true }, idle)).toBe('new-tab')
    expect(webLinkTarget({ ...plain, ctrlKey: true, shiftKey: true }, idle)).toBe('system')
  })

  it('uses Cmd instead of Ctrl on macOS', () => {
    const mac = { ...idle, mac: true }
    expect(webLinkTarget({ ...plain, metaKey: true }, mac)).toBe('new-tab')
    expect(webLinkTarget({ ...plain, metaKey: true, shiftKey: true }, mac)).toBe('system')
    expect(webLinkTarget({ ...plain, ctrlKey: true }, mac)).toBe(null)
    expect(webLinkTarget({ ...plain, ctrlKey: true }, idle)).toBe('new-tab')
    expect(webLinkTarget({ ...plain, metaKey: true }, idle)).toBe(null)
  })

  it('swaps the new tab and the system browser when the setting asks, on Linux and macOS', () => {
    const linux = { ...idle, linkClick: 'system' as const }
    expect(webLinkTarget({ ...plain, ctrlKey: true }, linux)).toBe('system')
    expect(webLinkTarget({ ...plain, ctrlKey: true, shiftKey: true }, linux)).toBe('new-tab')
    expect(webLinkTarget(plain, linux)).toBe('same-tab')
    const mac = { ...linux, mac: true }
    expect(webLinkTarget({ ...plain, metaKey: true }, mac)).toBe('system')
    expect(webLinkTarget({ ...plain, metaKey: true, shiftKey: true }, mac)).toBe('new-tab')
    expect(webLinkTarget({ ...plain, ctrlKey: true }, mac)).toBe(null)
  })

  it('ignores a plain click that ends a selection or drag, or is a double click', () => {
    expect(webLinkTarget(plain, { ...idle, hasSelection: true })).toBe(null)
    expect(webLinkTarget({ ...plain, detail: 2 }, idle)).toBe(null)
    expect(webLinkTarget({ ...plain, shiftKey: true }, idle)).toBe(null)
  })

  it('leaves a plain click to a program that reports the mouse but keeps modifier clicks', () => {
    const tui = { ...idle, mouseReporting: true }
    expect(webLinkTarget(plain, tui)).toBe(null)
    expect(webLinkTarget({ ...plain, ctrlKey: true }, tui)).toBe('new-tab')
    expect(webLinkTarget({ ...plain, ctrlKey: true, shiftKey: true }, tui)).toBe('system')
  })

  it('keeps modifier clicks working over a selection', () => {
    const selected = { ...idle, hasSelection: true }
    expect(webLinkTarget({ ...plain, ctrlKey: true }, selected)).toBe('new-tab')
  })
})

describe('linkSpan', () => {
  it('maps a one-row link to zero-based viewport cells, end exclusive', () => {
    const range = { start: { x: 5, y: 12 }, end: { x: 14, y: 12 } }
    expect(linkSpan(range, 10, 80)).toEqual({ row: 1, start: 4, end: 14 })
  })

  it('runs a wrapped link to the end of its first row', () => {
    const range = { start: { x: 70, y: 3 }, end: { x: 9, y: 4 } }
    expect(linkSpan(range, 0, 80)).toEqual({ row: 2, start: 69, end: 80 })
  })
})

describe('attachLinkClaim', () => {
  const setup = (claims: boolean) => {
    const parent = document.createElement('div')
    const screen = document.createElement('div')
    parent.append(screen)
    const own = vi.fn()
    const reported = vi.fn()
    screen.addEventListener('mousedown', own)
    parent.addEventListener('mousedown', reported)
    const detach = attachLinkClaim(screen, () => claims)
    return { screen, own, reported, detach }
  }

  it('keeps a claimed press from reaching the terminal behind the link layer', () => {
    const { screen, own, reported, detach } = setup(true)
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, ctrlKey: true })
    screen.dispatchEvent(press)
    expect(own).toHaveBeenCalledTimes(1)
    expect(reported).not.toHaveBeenCalled()
    expect(press.defaultPrevented).toBe(true)
    detach()
  })

  it('lets unclaimed presses and other buttons through', () => {
    const { screen, reported, detach } = setup(false)
    screen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(reported).toHaveBeenCalledTimes(1)
    detach()
    const claimed = setup(true)
    claimed.screen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }))
    expect(claimed.reported).toHaveBeenCalledTimes(1)
    claimed.detach()
  })
})

describe('terminalLinkTarget', () => {
  const ctx = { mac: true, hasSelection: false, mouseReporting: false, linkClick: 'app' as const }
  const click = { ctrlKey: false, metaKey: false, shiftKey: false, detail: 1 }
  const vault = 'obsidian://advanced-uri?vault=Interdisciplinary Nexus&filepath=中文.md'

  it('opens obsidian, vscode and mail links in their app on a click, with or without the modifier', () => {
    for (const uri of [vault, 'vscode://file/a.ts', 'vscode-insiders://file/a', 'mailto:a@b.c']) {
      expect(terminalLinkTarget(uri, click, ctx)).toBe('app')
      expect(terminalLinkTarget(uri, { ...click, metaKey: true }, ctx)).toBe('app')
    }
  })

  it('opens any other scheme with a double slash in its app', () => {
    for (const uri of ['slack://channel?id=1', 'zed://file/tmp/a', 'x-app://do']) {
      expect(terminalLinkTarget(uri, click, ctx)).toBe('app')
    }
  })

  it('keeps web links in the browser targets', () => {
    expect(terminalLinkTarget('https://a.b', click, ctx)).toBe('same-tab')
    expect(terminalLinkTarget('https://a.b', { ...click, metaKey: true }, ctx)).toBe('new-tab')
    expect(
      terminalLinkTarget('https://a.b', { ...click, metaKey: true, shiftKey: true }, ctx),
    ).toBe('system')
  })

  it('ignores scripts, files, data and unknown schemes', () => {
    for (const uri of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,x',
      'x-app:do',
      'ostia-preview://s/index.html',
      'devtools://devtools/a',
    ]) {
      expect(terminalLinkTarget(uri, click, ctx)).toBeNull()
      expect(terminalLinkTarget(uri, { ...click, metaKey: true, shiftKey: true }, ctx)).toBeNull()
    }
  })

  it('leaves app links alone while selecting or when the program reads the mouse', () => {
    expect(terminalLinkTarget(vault, click, { ...ctx, hasSelection: true })).toBeNull()
    expect(terminalLinkTarget(vault, click, { ...ctx, mouseReporting: true })).toBeNull()
  })
})
