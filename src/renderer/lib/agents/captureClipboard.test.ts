import { describe, expect, it } from 'vitest'
import { selectionClipboard } from './captureClipboard'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])

describe('selectionClipboard', () => {
  it('copies the text of a text capture', () => {
    expect(
      selectionClipboard(
        {
          kind: 'text',
          file: '/a.ts',
          view: 'source',
          range: { startLine: 1, endLine: 1 },
          text: 'x',
        },
        undefined,
      ),
    ).toEqual({ text: 'x' })
    expect(
      selectionClipboard({ kind: 'terminal', cwd: null, command: null, text: 'ls' }, undefined),
    ).toEqual({ text: 'ls' })
  })

  it('copies the pixels of an image capture and nothing without them', () => {
    const capture = {
      kind: 'image',
      file: '/a.png',
      imageWidth: 4,
      imageHeight: 4,
      region: null,
    } as const
    expect(selectionClipboard(capture, PNG)).toEqual({ png: PNG })
    expect(selectionClipboard(capture, undefined)).toBeNull()
  })
})
