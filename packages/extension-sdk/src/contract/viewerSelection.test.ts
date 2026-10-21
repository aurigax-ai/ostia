import { describe, expect, it } from 'vitest'
import {
  decodeViewerSelection,
  encodeViewerSelection,
  type ViewerSelectionMeta,
} from './viewerSelection'

const META: ViewerSelectionMeta = {
  capture: { kind: 'image', imageWidth: 4, imageHeight: 3, region: null },
  rect: { x: 1, y: 2, width: 3, height: 4 },
  frame: { width: 800, height: 600 },
  text: 'héllo',
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

describe('viewer selection body', () => {
  it('round-trips the metadata and the png', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const decoded = decodeViewerSelection(await bytesOf(encodeViewerSelection(META, png)))
    expect(decoded?.meta).toEqual(META)
    expect([...(decoded?.png ?? [])]).toEqual([...png])
  })

  it('reports no png when none was sent', async () => {
    const decoded = decodeViewerSelection(await bytesOf(encodeViewerSelection(META, null)))
    expect(decoded?.meta).toEqual(META)
    expect(decoded?.png).toBeNull()
  })

  it('refuses a body that is too short, claims too much json or is not json', async () => {
    expect(decodeViewerSelection(new Uint8Array([0, 0]))).toBeNull()
    expect(decodeViewerSelection(new Uint8Array([0, 0, 1, 0, 123]))).toBeNull()
    const garbage = new Uint8Array([0, 0, 0, 3, 0xff, 0xfe, 0xfd])
    expect(decodeViewerSelection(garbage)).toBeNull()
    const notJson = new Uint8Array([0, 0, 0, 3, 120, 120, 120])
    expect(decodeViewerSelection(notJson)).toBeNull()
  })
})
