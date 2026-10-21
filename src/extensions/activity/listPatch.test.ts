import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { createPatcher, FADE_CLASS, FADE_GAP_MS, type Row, setText } from './listPatch'

interface Item {
  text: string
}

function setup() {
  const { window } = new JSDOM('<main id="list"></main>')
  const { document } = window
  const list = document.getElementById('list') as HTMLElement
  let clock = 10_000
  const built: string[] = []
  const patch = createPatcher<Item>(
    list,
    (item): Row<Item> => {
      built.push(item.text)
      const label = document.createElement('span')
      const el = document.createElement('li')
      const button = document.createElement('button')
      el.append(label, button)
      const row: Row<Item> = {
        el,
        update: (next) => (setText(label, next.text) ? [label] : []),
      }
      row.update(item)
      return row
    },
    () => clock,
  )
  const items = (rows: [string, string][]) =>
    rows.map(([key, text]) => ({ key, sig: text, value: { text } }))
  const watch = () => {
    const observer = new window.MutationObserver(() => {})
    observer.observe(list, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    return () => observer.takeRecords()
  }
  return {
    document,
    window,
    list,
    patch,
    items,
    built,
    watch,
    tick: (ms: number) => {
      clock += ms
    },
    rows: () => [...list.children] as HTMLElement[],
  }
}

describe('createPatcher', () => {
  it('keeps the element of a row whose text changed, and the focus inside it', () => {
    const s = setup()
    s.patch(
      s.items([
        ['a', 'one'],
        ['b', 'two'],
      ]),
    )
    const [a, b] = s.rows()
    const button = a.querySelector('button') as HTMLButtonElement
    button.focus()
    expect(s.document.activeElement).toBe(button)

    s.patch(
      s.items([
        ['a', 'one, changed'],
        ['b', 'two'],
      ]),
    )
    expect(s.rows()).toEqual([a, b])
    expect(a.textContent).toBe('one, changed')
    expect(s.document.activeElement).toBe(button)
    expect(s.built).toEqual(['one', 'two'])
  })

  it('touches nothing when no row changed', () => {
    const s = setup()
    s.patch(
      s.items([
        ['a', 'one'],
        ['b', 'two'],
      ]),
    )
    const records = s.watch()
    s.patch(
      s.items([
        ['a', 'one'],
        ['b', 'two'],
      ]),
    )
    expect(records()).toHaveLength(0)
  })

  it('does not move rows that are already in order, appends new keys and removes missing ones', () => {
    const s = setup()
    s.patch(
      s.items([
        ['a', 'one'],
        ['b', 'two'],
        ['c', 'three'],
      ]),
    )
    const [a, , c] = s.rows()
    const records = s.watch()
    s.patch(
      s.items([
        ['a', 'one'],
        ['b', 'two'],
        ['c', 'three'],
        ['d', 'four'],
      ]),
    )
    expect(records().flatMap((r) => [...r.addedNodes, ...r.removedNodes])).toHaveLength(1)

    const next = s.watch()
    s.patch(
      s.items([
        ['a', 'one'],
        ['c', 'three'],
        ['d', 'four'],
      ]),
    )
    const changes = next()
    expect(changes.flatMap((r) => [...r.removedNodes])).toHaveLength(1)
    expect(changes.flatMap((r) => [...r.addedNodes])).toHaveLength(0)
    expect(s.rows().map((el) => el.textContent)).toEqual(['one', 'three', 'four'])
    expect(s.rows()[0]).toBe(a)
    expect(s.rows()[1]).toBe(c)
  })

  it('moves only the rows that are out of place when the order of the items changes', () => {
    const s = setup()
    s.patch(
      s.items([
        ['a', 'one'],
        ['b', 'two'],
        ['c', 'three'],
      ]),
    )
    const before = s.rows()
    const records = s.watch()
    s.patch(
      s.items([
        ['c', 'three'],
        ['a', 'one'],
        ['b', 'two'],
      ]),
    )
    expect(s.rows()).toEqual([before[2], before[0], before[1]])
    const changes = records()
    expect(changes.flatMap((r) => [...r.addedNodes])).toEqual([before[2]])
    expect(changes.flatMap((r) => [...r.removedNodes])).toEqual([before[2]])
  })

  it('fades the changed text at most once per second and removes the class when the fade ends', () => {
    const s = setup()
    s.patch(s.items([['a', 'one']]))
    const label = s.rows()[0].querySelector('span') as HTMLElement
    expect(label.classList.contains(FADE_CLASS)).toBe(false)

    s.tick(5_000)
    s.patch(s.items([['a', 'two']]))
    expect(label.classList.contains(FADE_CLASS)).toBe(true)

    label.dispatchEvent(new s.window.Event('animationend'))
    expect(label.classList.contains(FADE_CLASS)).toBe(false)

    s.tick(FADE_GAP_MS - 1)
    s.patch(s.items([['a', 'three']]))
    expect(label.textContent).toBe('three')
    expect(label.classList.contains(FADE_CLASS)).toBe(false)

    s.tick(2)
    s.patch(s.items([['a', 'four']]))
    expect(label.classList.contains(FADE_CLASS)).toBe(true)
  })

  it('never fades a row that has just appeared', () => {
    const s = setup()
    s.patch(s.items([['a', 'one']]))
    expect(s.list.querySelector(`.${FADE_CLASS}`)).toBeNull()
  })
})
