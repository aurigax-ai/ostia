import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeViewerSelection } from '../contract/viewerSelection'
import {
  clearSelection,
  hasPublishedSelection,
  onSelectionPublished,
  publishSelection,
  viewerDocumentUrl,
} from './viewer'

const eventSources: Array<{ listeners: Map<string, () => void> }> = []

class FakeEventSource {
  listeners = new Map<string, () => void>()
  constructor() {
    eventSources.push(this)
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener)
  }
  close(): void {}
}

Object.assign(globalThis, { EventSource: FakeEventSource })

interface Call {
  url: string
  init: RequestInit
}

function stubFetch(ok = true): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init })
      return { ok }
    }),
  )
  return calls
}

afterEach(async () => {
  stubFetch()
  await clearSelection()
  vi.unstubAllGlobals()
})

describe('publishSelection', () => {
  it('posts the metadata with the frame size and the png, and tells listeners', async () => {
    const calls = stubFetch()
    const seen: boolean[] = []
    const stop = onSelectionPublished((published) => seen.push(published))
    const png = new Uint8Array([0x89, 0x50, 1])
    const ok = await publishSelection({
      capture: { kind: 'image', imageWidth: 2, imageHeight: 2, region: null },
      rect: { x: 1, y: 2, width: 3, height: 4 },
      text: 'hi',
      png,
    })
    expect(ok).toBe(true)
    expect(hasPublishedSelection()).toBe(true)
    expect(calls[0].url).toBe('/~selection')
    expect(calls[0].init.method).toBe('POST')
    const body = decodeViewerSelection(
      new Uint8Array(await (calls[0].init.body as Blob).arrayBuffer()),
    )
    expect(body?.meta).toEqual({
      capture: { kind: 'image', imageWidth: 2, imageHeight: 2, region: null },
      rect: { x: 1, y: 2, width: 3, height: 4 },
      frame: { width: window.innerWidth, height: window.innerHeight },
      text: 'hi',
    })
    expect([...(body?.png ?? [])]).toEqual([...png])
    await clearSelection()
    expect(calls[1]).toMatchObject({ url: '/~selection', init: { method: 'DELETE' } })
    expect(seen).toEqual([true, false])
    stop()
  })

  it('stays unpublished when the host refuses or cannot be reached', async () => {
    stubFetch(false)
    const selection = {
      capture: { kind: 'pdf-text' as const, firstPage: 1, lastPage: 1 },
      rect: { x: 0, y: 0, width: 1, height: 1 },
      text: 'x',
    }
    expect(await publishSelection(selection)).toBe(false)
    vi.stubGlobal('fetch', () => Promise.reject(new Error('down')))
    expect(await publishSelection(selection)).toBe(false)
    expect(hasPublishedSelection()).toBe(false)
  })
})

describe('a selection the host cleared', () => {
  it('is no longer published and tells listeners', async () => {
    stubFetch()
    await publishSelection({
      capture: { kind: 'image', imageWidth: 2, imageHeight: 2, region: null },
      rect: { x: 0, y: 0, width: 1, height: 1 },
      png: new Uint8Array([0x89, 0x50, 1]),
    })
    const seen: boolean[] = []
    const stop = onSelectionPublished((published) => seen.push(published))
    eventSources[0].listeners.get('selection-cleared')?.()
    expect(hasPublishedSelection()).toBe(false)
    expect(seen).toEqual([false])
    stop()
  })
})

describe('viewer host requests', () => {
  it('builds an absolute document url for media elements and pdf.js', () => {
    expect(viewerDocumentUrl()).toBe(new URL('/~document', location.href).href)
  })
})
