import { describe, expect, it } from 'vitest'
import { sandboxSpawnEnv } from './spawnEnv'

describe('sandboxSpawnEnv', () => {
  it('drops the agent sockets a sandbox must not reach', () => {
    const env = sandboxSpawnEnv({ PATH: '/bin', SSH_AUTH_SOCK: '/run/ssh', GPG_AGENT_INFO: 'x' })
    expect(env).toEqual({ PATH: '/bin' })
  })

  it('drops the artifact folder and pad, which the sandbox does not bind', () => {
    const env = sandboxSpawnEnv({
      PATH: '/bin',
      OSTIA_PANE_ID: 'p1',
      OSTIA_ARTIFACTS: '/data/artifacts/w1',
      OSTIA_PAD: '/data/artifacts/w1/PAD.md',
    })
    expect(env).toEqual({ PATH: '/bin', OSTIA_PANE_ID: 'p1' })
  })
})
