import { describe, expect, it } from 'vitest'
import { instanceKey, KEEP_ALIVE_MAX, keepInstance, type PanelInstance } from './panelKeepAlive'

const at = (extId: string, workspaceId = 'w1'): PanelInstance => ({ extId, workspaceId })

describe('keepInstance', () => {
  it('adds a new instance as the most recent', () => {
    expect(keepInstance([at('a')], at('b'))).toEqual([at('a'), at('b')])
  })

  it('moves a kept instance to the end without duplicating it', () => {
    expect(keepInstance([at('a'), at('b')], at('a'))).toEqual([at('b'), at('a')])
  })

  it('evicts the least recently shown instance past the cap and never the shown one', () => {
    let kept: PanelInstance[] = []
    for (const id of ['a', 'b', 'c', 'd']) kept = keepInstance(kept, at(id))
    expect(kept).toEqual([at('b'), at('c'), at('d')])
    expect(kept).toHaveLength(KEEP_ALIVE_MAX)
  })

  it('counts the same extension in two workspaces as two instances', () => {
    const kept = keepInstance(keepInstance([], at('a', 'w1')), at('a', 'w2'))
    expect(kept).toEqual([at('a', 'w1'), at('a', 'w2')])
    expect(instanceKey(at('a', 'w1'))).not.toBe(instanceKey(at('a', 'w2')))
  })

  it('keeps only the shown instance when the cap is one', () => {
    expect(keepInstance([at('a')], at('b'), 1)).toEqual([at('b')])
  })
})
