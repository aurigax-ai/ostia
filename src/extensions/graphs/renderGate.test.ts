import { describe, expect, it } from 'vitest'
import { renderGate } from './renderGate'

const list = { kind: 'list' }
const runs = { kind: 'runs' }

describe('the Graphs panel paints only current renders', () => {
  it('a list render that finishes after the Runs view was opened never paints over it', () => {
    const gate = renderGate<object>()
    const listing = gate.begin()
    const opening = gate.begin()
    expect(gate.mayPaint(opening, runs, runs)).toBe(true)
    expect(gate.mayPaint(listing, list, runs)).toBe(false)
  })

  it('a render older than the one already painted never paints, even for the same view', () => {
    const gate = renderGate<object>()
    const older = gate.begin()
    const newer = gate.begin()
    expect(gate.mayPaint(newer, list, list)).toBe(true)
    expect(gate.mayPaint(older, list, list)).toBe(false)
  })

  it('renders that keep starting while earlier ones finish still paint, so a busy panel is never left blank', () => {
    const gate = renderGate<object>()
    let painted = 0
    let previous = gate.begin()
    for (let i = 0; i < 50; i++) {
      const next = gate.begin()
      if (gate.mayPaint(previous, list, list)) painted += 1
      previous = next
    }
    expect(painted).toBe(50)
  })
})
