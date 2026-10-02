import type { RemoteReadResult, RemoteStatResult, RemoteWriteResult } from '@shared/remoteFolders'
import { describe, expect, it, vi } from 'vitest'
import { type RemoteTextApi, checkRemoteText, saveRemoteText } from './remoteFileSync'

const PATH = 'remote://abcdef012345/srv/app/app.conf'

const MISSING: RemoteStatResult & RemoteReadResult = { ok: false, error: 'not-found' }
const WRITTEN: RemoteWriteResult = { ok: true, version: '2-2' }

function api(
  over: {
    stat?: RemoteStatResult
    read?: RemoteReadResult
    write?: RemoteWriteResult
  } = {},
) {
  return {
    stat: vi.fn<RemoteTextApi['stat']>(async () => over.stat ?? MISSING),
    read: vi.fn<RemoteTextApi['read']>(async () => over.read ?? MISSING),
    write: vi.fn<RemoteTextApi['write']>(async () => over.write ?? WRITTEN),
  }
}

describe('saveRemoteText', () => {
  it('SSH-C66 sends the text with the version it was read at and returns the new version', async () => {
    const remote = api({ write: { ok: true, version: '9-4' } })
    expect(await saveRemoteText(remote, PATH, 'text', '1-1', false)).toEqual({
      kind: 'saved',
      version: '9-4',
    })
    expect(remote.write).toHaveBeenCalledWith(PATH, 'text', '1-1')
  })

  it('writes a file that did not exist as new, and overwrites with any when forced', async () => {
    const remote = api()
    await saveRemoteText(remote, PATH, 'text', null, false)
    expect(remote.write).toHaveBeenLastCalledWith(PATH, 'text', 'new')
    await saveRemoteText(remote, PATH, 'text', '1-1', true)
    expect(remote.write).toHaveBeenLastCalledWith(PATH, 'text', 'any')
  })

  it('SSH-C67 reads what is on the host now when the file changed, so the human can compare', async () => {
    const remote = api({
      write: { ok: false, error: 'changed' },
      read: { ok: true, content: 'theirs', version: '5-6' },
    })
    expect(await saveRemoteText(remote, PATH, 'mine', '1-1', false)).toEqual({
      kind: 'conflict',
      disk: 'theirs',
      version: '5-6',
    })
  })

  it('reports a file that vanished as deleted and any other failure as failed', async () => {
    const vanished = api({ write: { ok: false, error: 'changed' } })
    expect(await saveRemoteText(vanished, PATH, 'mine', '1-1', false)).toEqual({ kind: 'deleted' })
    const denied = api({ write: { ok: false, error: 'denied' } })
    expect(await saveRemoteText(denied, PATH, 'mine', '1-1', false)).toEqual({
      kind: 'failed',
      error: 'denied',
    })
    expect(denied.read).not.toHaveBeenCalled()
    const unreadable = api({
      write: { ok: false, error: 'changed' },
      read: { ok: false, error: 'unavailable' },
    })
    expect(await saveRemoteText(unreadable, PATH, 'mine', '1-1', false)).toEqual({
      kind: 'failed',
      error: 'unavailable',
    })
  })
})

describe('checkRemoteText', () => {
  it('SSH-C68 reads the file only when its version moved', async () => {
    const same = api({ stat: { ok: true, kind: 'file', version: '1-1' } })
    expect(await checkRemoteText(same, PATH, '1-1')).toEqual({ kind: 'same' })
    expect(same.read).not.toHaveBeenCalled()

    const moved = api({
      stat: { ok: true, kind: 'file', version: '5-6' },
      read: { ok: true, content: 'theirs', version: '5-6' },
    })
    expect(await checkRemoteText(moved, PATH, '1-1')).toEqual({
      kind: 'changed',
      disk: 'theirs',
      version: '5-6',
    })
  })

  it('says deleted once for a file that was there, and nothing for one that never was', async () => {
    expect(await checkRemoteText(api(), PATH, '1-1')).toEqual({ kind: 'deleted' })
    expect(await checkRemoteText(api(), PATH, null)).toEqual({ kind: 'same' })
  })

  it('changes nothing when the host cannot be asked or the file has no version', async () => {
    const down = api({ stat: { ok: false, error: 'unavailable' } })
    expect(await checkRemoteText(down, PATH, '1-1')).toEqual({ kind: 'unknown' })
    const big = api({ stat: { ok: true, kind: 'file' } })
    expect(await checkRemoteText(big, PATH, '1-1')).toEqual({ kind: 'unknown' })
    const folder = api({ stat: { ok: true, kind: 'dir' } })
    expect(await checkRemoteText(folder, PATH, '1-1')).toEqual({ kind: 'unknown' })
    const raced = api({
      stat: { ok: true, kind: 'file', version: '5-6' },
      read: { ok: true, content: 'mine', version: '1-1' },
    })
    expect(await checkRemoteText(raced, PATH, '1-1')).toEqual({ kind: 'same' })
  })
})
