import { describe, expect, it } from 'vitest'
import { clickedLinkOf, LINK_CLICK_SCRIPT } from './guestLinkClicks'

class FakeElement {
  constructor(private readonly link: { href: string } | null) {}
  closest(selector: string): { href: string } | null {
    return selector === 'a[href], area[href]' ? this.link : null
  }
}

interface ClickEvent {
  target: unknown
  isTrusted: boolean
  button: number
}

function runScript() {
  const logged: string[] = []
  let onClick: ((event: ClickEvent) => void) | null = null
  let capture = false
  const source =
    typeof LINK_CLICK_SCRIPT === 'string' ? LINK_CLICK_SCRIPT : LINK_CLICK_SCRIPT.source
  new Function('addEventListener', 'Element', 'console', source)(
    (type: string, listener: typeof onClick, useCapture: boolean) => {
      if (type === 'click') onClick = listener
      capture = useCapture
    },
    FakeElement,
    { debug: (message: string) => logged.push(message) },
  )
  const click = (target: unknown, event: Partial<ClickEvent> = {}): void =>
    onClick?.({ target, isTrusted: true, button: 0, ...event })
  return { logged, click, capture: () => capture }
}

describe('LINK_CLICK_SCRIPT', () => {
  it('runs in its own isolated world', () => {
    expect(LINK_CLICK_SCRIPT).toMatchObject({ worldName: 'ostia-link-clicks' })
  })

  it('reports the address of a clicked link to main, before the page’s own listeners', () => {
    const { logged, click, capture } = runScript()
    click(new FakeElement({ href: 'https://docs.example.com/a' }))
    expect(capture()).toBe(true)
    expect(logged).toHaveLength(1)
    expect(clickedLinkOf(logged[0])).toBe('https://docs.example.com/a')
  })

  it('reports nothing for a click the page made itself or another button', () => {
    const { logged, click } = runScript()
    const link = new FakeElement({ href: 'https://docs.example.com/a' })
    click(link, { isTrusted: false })
    click(link, { button: 1 })
    click(link, { button: 2 })
    expect(logged).toEqual([])
  })

  it('reports nothing for a click outside a link or on a non-element', () => {
    const { logged, click } = runScript()
    click(new FakeElement(null))
    click({ nodeType: 3 })
    expect(logged).toEqual([])
  })
})

describe('clickedLinkOf', () => {
  it('reads only the script’s own messages, never a page’s look-alike', () => {
    expect(clickedLinkOf('https://docs.example.com/a')).toBeNull()
    expect(clickedLinkOf('[ostia-link-click] https://docs.example.com/a')).toBeNull()
  })
})
