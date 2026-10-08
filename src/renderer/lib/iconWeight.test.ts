import { describe, expect, it } from 'vitest'
import { iconWeightFor } from './iconWeight'

describe('iconWeightFor', () => {
  it('draws the heavier stroke on every display scale where the regular one is thinner than two device pixels', () => {
    expect([1, 1.25, 1.5, 1.75].map(iconWeightFor)).toEqual(['bold', 'bold', 'bold', 'bold'])
  })

  it('keeps the regular stroke where it covers whole device pixels', () => {
    expect([2, 2.5, 3].map(iconWeightFor)).toEqual(['regular', 'regular', 'regular'])
  })
})
