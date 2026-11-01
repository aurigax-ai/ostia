import { describe, expect, it } from 'vitest'
import { frameLine, parseFrame } from './linkFrames'

const roundTrip = (frame: object): unknown => parseFrame(JSON.stringify(frame))

describe('port frames', () => {
  it('RPF-C6 keeps only port numbers and process names in a ports frame', () => {
    const frame = roundTrip({
      t: 'ports',
      ports: [{ port: 3000, name: 'node', cmdline: 'node --token=secret', user: 'root' }],
    })
    expect(frame).toEqual({ t: 'ports', ports: [{ port: 3000, name: 'node' }] })
    expect(frameLine(frame as never)).not.toContain('secret')
  })

  it('RPF-C6 refuses a ports frame with a bad port', () => {
    expect(roundTrip({ t: 'ports', ports: [{ port: 0 }] })).toBeNull()
    expect(roundTrip({ t: 'ports', ports: [{ port: 70000 }] })).toBeNull()
    expect(roundTrip({ t: 'ports', ports: 'x' })).toBeNull()
  })

  it('RPF-C21 passes an out-of-range local port through for the desktop to refuse', () => {
    expect(roundTrip({ t: 'ports-req', id: 'a', op: 'forward', remote: 3000, local: 80 })).toEqual({
      t: 'ports-req',
      id: 'a',
      op: 'forward',
      remote: 3000,
      local: 80,
    })
  })

  it('RPF-C19 reads list, forward and stop requests and refuses other verbs', () => {
    expect(roundTrip({ t: 'ports-req', id: 'a', op: 'list' })).toEqual({
      t: 'ports-req',
      id: 'a',
      op: 'list',
    })
    expect(roundTrip({ t: 'ports-req', id: 'a', op: 'tag' })).toBeNull()
  })

  it('RPF-C20 reads a ports result with forwards and an error result', () => {
    const rows = [{ remote: 3000, local: 3000, name: 'node' }]
    expect(roundTrip({ t: 'ports-res', id: 'a', result: { ok: true, forwards: rows } })).toEqual({
      t: 'ports-res',
      id: 'a',
      result: { ok: true, forwards: rows },
    })
    expect(
      roundTrip({ t: 'ports-res', id: 'a', result: { ok: false, error: 'link-down' } }),
    ).toEqual({ t: 'ports-res', id: 'a', result: { ok: false, error: 'link-down' } })
  })
})
