import { describe, expect, it } from 'vitest'
import { en } from '../../../shared/app/dict'
import { restoreSeam, ScreenMirror } from '../screenMirror'
import { feedDisplay, replayRestored } from './ptyRegistry'

const RESTORE_SEAM = restoreSeam(en.native.paneBanner)

function entry() {
  const shown: string[] = []
  const mirror = new ScreenMirror(80, 24)
  return { shown, mirror, session: { push: (data: string) => shown.push(data) } }
}

describe('restored history on a new pty', () => {
  it('RSM-C18 shows the seam but saves only the history', async () => {
    const pane = entry()
    replayRestored(pane as never, 'old output', RESTORE_SEAM)
    feedDisplay(pane as never, 'a notice\r\n')
    pane.mirror.write('new output\r\n')
    await pane.mirror.flush()
    expect(pane.shown.join('')).toContain('workspace restored')
    expect(pane.mirror.serialize()).not.toContain('workspace restored')
    expect(pane.mirror.serialize()).not.toContain('a notice')
    expect(pane.mirror.serialize()).toContain('old output')
    pane.mirror.dispose()
  })
})
