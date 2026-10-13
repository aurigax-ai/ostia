import { describe, expect, it } from 'vitest'
import { claudeSessionInfo, codexSessionInfo, formatTokens } from './agentSessionInfo'

const line = (v: unknown) => JSON.stringify(v)

describe('claudeSessionInfo', () => {
  it('reads the title, model, context size, folder and branch of the main thread', () => {
    const info = claudeSessionInfo([
      line({ type: 'permission-mode', permissionMode: 'acceptEdits' }),
      line({ type: 'ai-title', aiTitle: 'Resume tokens' }),
      line({ type: 'user', cwd: '/w', gitBranch: 'main', version: '2.3.0' }),
      line({
        type: 'assistant',
        cwd: '/w',
        effort: 'high',
        message: {
          model: 'claude-opus-5-5',
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 2000,
            cache_read_input_tokens: 56000,
          },
        },
      }),
      line({
        type: 'assistant',
        isSidechain: true,
        message: { model: 'claude-haiku-4-5', usage: { input_tokens: 999999 } },
      }),
      '{"type":"assistant", broken',
    ])
    expect(info).toEqual({
      title: 'Resume tokens',
      model: 'claude-opus-5-5',
      contextTokens: 58010,
      contextWindow: null,
      cwd: '/w',
      branch: 'main',
      version: '2.3.0',
      mode: 'acceptEdits',
      effort: 'high',
    })
  })

  it('prefers a title the human set over the generated one', () => {
    const info = claudeSessionInfo([
      line({ type: 'ai-title', aiTitle: 'Generated' }),
      line({ type: 'custom-title', customTitle: 'Mine' }),
      line({ type: 'ai-title', aiTitle: 'Newer generated' }),
    ])
    expect(info.title).toBe('Mine')
  })
})

describe('codexSessionInfo', () => {
  it('reads the model, folder, branch and context use against the window', () => {
    const info = codexSessionInfo([
      line({
        type: 'session_meta',
        payload: { cwd: '/w', cli_version: '0.157.0', git: { branch: 'dev' } },
      }),
      line({
        type: 'turn_context',
        payload: {
          model: 'gpt-5.4',
          cwd: '/w/app',
          effort: 'medium',
          approval_policy: 'on-request',
        },
      }),
      line({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { model_context_window: 272000, last_token_usage: { input_tokens: 41000 } },
        },
      }),
    ])
    expect(info).toEqual({
      title: null,
      model: 'gpt-5.4',
      contextTokens: 41000,
      contextWindow: 272000,
      cwd: '/w/app',
      branch: 'dev',
      version: '0.157.0',
      mode: 'on-request',
      effort: 'medium',
    })
  })
})

describe('formatTokens', () => {
  it('shortens large counts', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(58010)).toBe('58.0k')
    expect(formatTokens(1_250_000)).toBe('1.25M')
  })
})
