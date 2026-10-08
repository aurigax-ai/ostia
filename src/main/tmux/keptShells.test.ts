import { describe, expect, it } from 'vitest'
import { HOST_PROTOCOL_VERSION } from '../sandbox/protocol'
import { parseKeptHost } from './keptShells'

const host = {
  kind: 'sandbox-host',
  workspaceId: 'w1',
  channel: '/tmp/host.sock',
  tmpDir: '/tmp/host',
  protocol: HOST_PROTOCOL_VERSION,
  exposed: [],
}

describe('parseKeptHost', () => {
  it('reads a sandbox host record', () => {
    expect(parseKeptHost(host)).toEqual(host)
  })

  it('refuses a record that states no protocol version', () => {
    const { protocol: _protocol, ...withoutProtocol } = host
    expect(parseKeptHost(withoutProtocol)).toBeNull()
    expect(parseKeptHost({ ...host, protocol: '1' })).toBeNull()
  })
})
