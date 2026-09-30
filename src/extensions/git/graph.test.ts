import { describe, expect, it } from 'vitest'
import { type GraphEdge, type GraphNode, layoutGraph } from './graph'

const n = (sha: string, ...parents: string[]): GraphNode => ({ sha, parents })
const moves = (edges: GraphEdge[]): string[] => edges.map((e) => `${e.from}>${e.to}`)

describe('layoutGraph', () => {
  it('keeps a linear history on one lane with straight edges', () => {
    const rows = layoutGraph([n('c', 'b'), n('b', 'a'), n('a')])
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0])
    expect(rows.map((r) => r.width)).toEqual([1, 1, 1])
    expect(moves(rows[0].top)).toEqual([])
    expect(moves(rows[0].bottom)).toEqual(['0>0'])
    expect(moves(rows[1].top)).toEqual(['0>0'])
    expect(moves(rows[2].bottom)).toEqual([])
    expect(new Set(rows.map((r) => r.color)).size).toBe(1)
  })

  it('opens a second lane for a branch and folds it back into its fork point', () => {
    const rows = layoutGraph([
      n('main2', 'base'),
      n('feat2', 'feat1'),
      n('feat1', 'base'),
      n('base'),
    ])
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 1, 0])
    expect(moves(rows[1].top)).toEqual(['0>0'])
    expect(moves(rows[1].bottom)).toEqual(['1>1', '0>0'])
    expect(moves(rows[2].bottom)).toEqual(['1>0', '0>0'])
    expect(moves(rows[3].top)).toEqual(['0>0'])
    expect(rows[3].width).toBe(1)
    expect(rows[1].color).not.toBe(rows[0].color)
  })

  it('draws a merge as a curve into a new lane that rejoins at the fork', () => {
    const rows = layoutGraph([n('m', 'a2', 'b1'), n('a2', 'base'), n('b1', 'base'), n('base')])
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 1, 0])
    expect(moves(rows[0].bottom)).toEqual(['0>0', '0>1'])
    expect(rows[0].bottom[1].color).toBe(rows[2].color)
    expect(rows[0].bottom[1].color).not.toBe(rows[0].color)
    expect(moves(rows[1].bottom)).toEqual(['0>0', '1>1'])
    expect(moves(rows[2].bottom)).toEqual(['1>0', '0>0'])
    expect(moves(rows[3].top)).toEqual(['0>0'])
  })

  it('merges into a parent that another lane already waits for without opening a lane', () => {
    const rows = layoutGraph([n('tip', 'x'), n('m', 'y', 'x'), n('y', 'x'), n('x')])
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 1, 0])
    expect(moves(rows[1].bottom)).toEqual(['1>1', '1>0', '0>0'])
    expect(rows.every((r) => r.width <= 2)).toBe(true)
  })

  it('fans an octopus merge out to one lane per parent', () => {
    const rows = layoutGraph([
      n('oct', 'p1', 'p2', 'p3'),
      n('p1', 'root'),
      n('p2', 'root'),
      n('p3', 'root'),
      n('root'),
    ])
    expect(rows[0].lane).toBe(0)
    expect(moves(rows[0].bottom)).toEqual(['0>0', '0>1', '0>2'])
    expect(new Set(rows[0].bottom.map((e) => e.color)).size).toBe(3)
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 1, 2, 0])
    expect(moves(rows[2].bottom)).toEqual(['1>0', '0>0', '2>2'])
    expect(moves(rows[3].top)).toEqual(['0>0', '2>2'])
    expect(moves(rows[3].bottom)).toEqual(['2>0', '0>0'])
    expect(rows[3].width).toBe(3)
    expect(moves(rows[4].top)).toEqual(['0>0'])
    expect(rows[4].width).toBe(1)
  })

  it('lays out a criss-cross merge without losing either history line', () => {
    const rows = layoutGraph([
      n('m1', 'a', 'b'),
      n('m2', 'b', 'a'),
      n('a', 'root'),
      n('b', 'root'),
      n('root'),
    ])
    expect(rows.map((r) => r.lane)).toEqual([0, 2, 0, 1, 0])
    expect(moves(rows[1].bottom)).toEqual(['2>1', '2>0', '0>0', '1>1'])
    expect(moves(rows[2].top)).toEqual(['0>0', '1>1'])
    expect(moves(rows[3].bottom)).toEqual(['1>0', '0>0'])
    expect(moves(rows[4].top)).toEqual(['0>0'])
  })

  it('reuses a freed lane instead of growing wider', () => {
    const rows = layoutGraph([
      n('b1', 'base'),
      n('a1', 'base'),
      n('base', 'old'),
      n('c1', 'old'),
      n('old'),
    ])
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 1, 0])
    expect(Math.max(...rows.map((r) => r.width))).toBe(2)
  })

  it('marks every edge from a pending node as pending until the parent is reached', () => {
    const rows = layoutGraph([
      { sha: 'worktree', parents: ['head'], pending: true },
      n('other', 'head'),
      n('head', 'root'),
      n('root'),
    ])
    expect(rows[0].bottom).toEqual([{ from: 0, to: 0, color: 0, pending: true }])
    expect(rows[1].top[0]).toMatchObject({ from: 0, to: 0, pending: true })
    expect(rows[1].bottom.find((e) => e.from === 1)).not.toHaveProperty('pending')
    expect(rows[2].top.find((e) => e.from === 0)).toMatchObject({ to: 0, pending: true })
    expect(rows[2].bottom).toEqual([{ from: 0, to: 0, color: rows[2].color }])
  })

  it('leaves lanes of parents outside the loaded page running off the bottom', () => {
    const rows = layoutGraph([n('b', 'a')])
    expect(moves(rows[0].bottom)).toEqual(['0>0'])
  })
})
