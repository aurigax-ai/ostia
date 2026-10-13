import { describe, expect, it, vi } from 'vitest'

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: '<svg/>' })),
}))
vi.mock('mermaid', () => ({ default: mermaid }))

import { MERMAID_SOURCE_MAX, mermaidSvg } from './mermaidImage'

describe('mermaidSvg', () => {
  it('draws with the strict security level and no HTML labels', async () => {
    expect(await mermaidSvg('graph TD\n A-->B', true)).toBe('<svg/>')
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'dark',
        htmlLabels: false,
      }),
    )
    expect(mermaid.render).toHaveBeenCalledWith(
      expect.stringMatching(/^ostia-mermaid-\d+$/),
      'graph TD\n A-->B',
    )
  })

  it('refuses a source too large to draw without loading the library', async () => {
    mermaid.render.mockClear()
    await expect(mermaidSvg('x'.repeat(MERMAID_SOURCE_MAX + 1), false)).rejects.toThrow('too large')
    expect(mermaid.render).not.toHaveBeenCalled()
  })
})
