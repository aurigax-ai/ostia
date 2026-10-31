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
})
