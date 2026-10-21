import { describe, expect, it, vi } from 'vitest'
import { drawDiagram, MERMAID_SOURCE_MAX } from './diagram'

describe('drawDiagram', () => {
  it('turns the drawn SVG into a blob image address, never markup', async () => {
    const render = vi.fn().mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg"/>')
    const drawn = await drawDiagram('graph TD\n  A-->B', true, render)
    expect(render).toHaveBeenCalledWith('graph TD\n  A-->B', true)
    expect('url' in drawn && drawn.url.startsWith('blob:')).toBe(true)
    if ('url' in drawn) URL.revokeObjectURL(drawn.url)
  })

  it('reports the reason when the diagram cannot be drawn', async () => {
    const render = vi.fn().mockRejectedValue(new Error('Parse error on line 2'))
    expect(await drawDiagram('graph TD\n  A--', false, render)).toEqual({
      problem: 'Parse error on line 2',
    })
  })

  it('refuses a source over the limit without drawing it', async () => {
    const render = vi.fn()
    expect(await drawDiagram('x'.repeat(MERMAID_SOURCE_MAX + 1), false, render)).toEqual({
      tooLarge: true,
    })
    expect(render).not.toHaveBeenCalled()
  })
})
