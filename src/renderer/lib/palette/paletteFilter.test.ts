import { describe, expect, it } from 'vitest'
import { paletteFilter } from './paletteFilter'

const ssh = '> SSH: Connect to Host… ssh.connect SSH'
const history = '> Search Command History history.search Terminal'
const scratch = '> New Scratch Workspace workspace.newScratch Workspace'

describe('paletteFilter', () => {
  it('ranks a command whose words start with every typed word above scattered letter matches', () => {
    const best = paletteFilter(ssh, 'ssh connect')
    expect(best).toBeGreaterThan(paletteFilter(history, 'ssh connect'))
    expect(best).toBeGreaterThan(paletteFilter(scratch, 'ssh connect'))
  })

  it('still finds a command by scattered letters, below word matches', () => {
    const fuzzy = paletteFilter(history, 'srch hist')
    expect(fuzzy).toBeGreaterThan(0)
    expect(fuzzy).toBeLessThan(paletteFilter(history, 'search hist'))
  })

  it('hides a command the letters cannot match', () => {
    expect(paletteFilter(ssh, 'zzz')).toBe(0)
  })
})
