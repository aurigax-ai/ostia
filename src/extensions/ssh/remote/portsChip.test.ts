import { describe, expect, it } from 'vitest'
import { portItems } from './portsChip'

describe('portItems', () => {
  it('RPF-C10 reads :3000 → localhost:3000 for a forwarded port and :8080 for one that is not', () => {
    expect(
      portItems([
        { remote: 3000, local: 3000, name: 'node' },
        { remote: 8080 },
        { remote: 5173, error: 'port-taken' },
      ]),
    ).toEqual([
      {
        text: ':3000 → localhost:3000',
        detail: 'node',
        url: 'http://localhost:3000',
        port: { remote: 3000, local: 3000 },
      },
      { text: ':8080', port: { remote: 8080 } },
      { text: ':5173', port: { remote: 5173, error: 'port-taken' } },
    ])
  })

  it('RPF-C10 keeps forwarded ports in the menu when more than 64 ports listen', () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({ remote: 1000 + i }))
    rows[70] = { remote: 1070, local: 1070 } as never
    const items = portItems(rows)
    expect(items).toHaveLength(64)
    expect(items[0].text).toBe(':1070 → localhost:1070')
  })
})
