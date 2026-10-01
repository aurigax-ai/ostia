import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PanelSizeStore } from './panelSizes'

describe('PanelSizeStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pine-panel-sizes-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('remembers a split across restarts and forgets it on reset', () => {
    const file = join(dir, 'sub', 'panel-sizes.json')
    const store = new PanelSizeStore(file)
    expect(store.all()).toEqual({})
    expect(store.set('graph-details', 0.3)).toBe(true)
    expect(new PanelSizeStore(file).all()).toEqual({ 'graph-details': 0.3 })
    expect(store.set('graph-details', null)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({})
  })

  it('refuses bad keys and values without touching what is stored', () => {
    const store = new PanelSizeStore(join(dir, 'panel-sizes.json'))
    store.set('a', 0.5)
    expect(store.set('../x', 0.5)).toBe(false)
    expect(store.set('a', 2)).toBe(false)
    expect(store.set('a', '0.4')).toBe(false)
    expect(store.set(7, 0.4)).toBe(false)
    expect(store.all()).toEqual({ a: 0.5 })
  })

  it('starts empty when the file is unreadable', () => {
    const file = join(dir, 'panel-sizes.json')
    writeFileSync(file, '{nope')
    expect(new PanelSizeStore(file).all()).toEqual({})
  })

  it('keeps sizes in memory when there is no data folder', () => {
    const store = new PanelSizeStore(null)
    store.set('a', 0.25)
    expect(store.all()).toEqual({ a: 0.25 })
  })
})
