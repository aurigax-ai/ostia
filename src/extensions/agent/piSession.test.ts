import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { READ_FILE_TOOL } from '../../../test/agentHarness'
import { openPiSession } from './piSession'

describe('the pi session', () => {
  it('keeps cache warming and install telemetry off', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-session-'))
    const { session } = await openPiSession({
      sessionId: 's1',
      cwd: root,
      dataDir: join(root, 'data'),
      tools: [READ_FILE_TOOL],
      providers: [{ id: 'fake', name: 'Fake', baseUrl: 'http://127.0.0.1:1/v1', models: ['m'] }],
      callTool: async () => ({ ok: true, output: '' }),
    })
    expect(session.settingsManager.getCacheWarmingMode()).toBe('off')
    expect(session.settingsManager.getEnableInstallTelemetry()).toBe(false)
    session.dispose()
  })
})
