import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { parseNetTcp } from '../main/ports/procfs'
import { samePorts, scanHostPorts, userSockets } from './hostPorts'

const table = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11 1
   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22 1
`

describe('host port scan', () => {
  it('RPF-C6 keeps only the sockets of the login user', () => {
    const sockets = userSockets(parseNetTcp(table), 1000)
    expect(sockets.map((s) => s.port)).toEqual([3000])
  })

  it.skipIf(process.platform !== 'linux')(
    'RPF-C6 reports a listening port of this user with the process name only',
    async () => {
      const server = createServer().listen(0, '127.0.0.1')
      await new Promise((resolve) => server.once('listening', resolve))
      const { port } = server.address() as { port: number }
      try {
        const found = (await scanHostPorts()).find((p) => p.port === port)
        expect(found).toBeDefined()
        expect(Object.keys(found ?? {}).sort()).toEqual(['name', 'port'])
        expect(found?.name).not.toContain(' ')
      } finally {
        server.close()
      }
    },
  )

  it('RPF-C5 tells a changed list from an unchanged one', () => {
    expect(samePorts([{ port: 1 }], [{ port: 1 }])).toBe(true)
    expect(samePorts([{ port: 1 }], [])).toBe(false)
  })
})
