import { describe, expect, it } from 'vitest'
import { extensionEnvironment } from './extensionEnv'

const parts = {
  socket: '/tmp/s.sock',
  token: 't',
  apiVersion: '4.13',
  apiEnvName: 'EXTENSION_API',
  id: 'agent',
  dir: '/ext/agent',
  dataDir: '/data/agent',
}

describe('extensionEnvironment', () => {
  it('passes no provider or cloud credential to an extension', () => {
    const parent = {
      PATH: '/usr/bin',
      HOME: '/home/u',
      ANTHROPIC_API_KEY: 'sk-ant-1',
      OPENAI_API_KEY: 'sk-1',
      OPENAI_BASE_URL: 'http://x',
      AWS_ACCESS_KEY_ID: 'AKIA',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_PROFILE: 'prod',
      GOOGLE_APPLICATION_CREDENTIALS: '/k.json',
      AZURE_OPENAI_API_KEY: 'az',
      GEMINI_API_KEY: 'g',
      GROQ_API_KEY: 'q',
      HF_TOKEN: 'hf',
      COPILOT_GITHUB_TOKEN: 'gh',
      SOME_NEW_VENDOR_API_KEY: 'v',
    }
    const env = extensionEnvironment(parent, parts)
    const leaked = Object.keys(env).filter(
      (name) => !name.startsWith('OSTIA_') && /KEY|TOKEN|AWS|GOOGLE|AZURE|OPENAI|HF_/.test(name),
    )
    expect(leaked).toEqual([])
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/u')
  })

  it('still hands the extension its own socket, token and folders', () => {
    const env = extensionEnvironment({ OSTIA_PANE_ID: 'p', OSTIA_START_DIR: '/x' }, parts)
    expect(env.OSTIA_PANE_ID).toBeUndefined()
    expect(env.OSTIA_START_DIR).toBeUndefined()
    expect(Object.values(env)).toEqual(
      expect.arrayContaining(['/tmp/s.sock', 't', '4.13', 'agent', '/ext/agent', '/data/agent']),
    )
  })
})
