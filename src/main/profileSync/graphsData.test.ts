import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROFILE_FOLDERS, readProfileFolders, TOP_FILES } from './profile'

describe('profile sync and graph runs', () => {
  it('GRF-C103 nothing under the extension data folder is in the pushed set', () => {
    const root = mkdtempSync(join(tmpdir(), 'profile-graphs-'))
    const data = join(root, 'extension-data', 'graphs')
    mkdirSync(join(data, 'runs', 'w1', 'g', '20261014T120000Z-abcd'), { recursive: true })
    writeFileSync(join(data, 'enabled.json'), '{"enabled":[]}')
    writeFileSync(join(data, 'runs', 'w1', 'g', '20261014T120000Z-abcd', 'journal.jsonl'), '{}\n')
    const read = readProfileFolders(root)
    const pushed = [...read.files.keys(), ...read.skipped, ...TOP_FILES]
    expect(
      pushed.filter(
        (p) => p.includes('extension-data') || p.includes('journal') || p.includes('enabled'),
      ),
    ).toEqual([])
    expect(PROFILE_FOLDERS.map((f) => f.name)).not.toContain('extension-data')
  })
})
