import { describe, expect, it } from 'vitest'
import { FolderAccessMonitor, folderReadOfCommand, folderReadOfError } from './folderAccess'

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

describe('folderReadOfError', () => {
  it('counts only EPERM as a macOS privacy deny', () => {
    expect(folderReadOfError(errno('EPERM', 'EPERM: operation not permitted'))).toBe('denied')
    expect(folderReadOfError(errno('EACCES', 'EACCES: permission denied'))).toBe('other')
    expect(folderReadOfError(errno('ENOENT', 'ENOENT: no such file or directory'))).toBe('other')
    expect(folderReadOfError(errno('ENOTDIR', 'ENOTDIR: not a directory'))).toBe('other')
  })

  it('reads the message only when the error has no code', () => {
    expect(folderReadOfError(new Error('ls: Downloads: Operation not permitted'))).toBe('denied')
    expect(folderReadOfError(errno('EACCES', 'Operation not permitted'))).toBe('other')
    expect(folderReadOfError(new Error('Permission denied'))).toBe('other')
    expect(folderReadOfError(null)).toBe('other')
    expect(folderReadOfError('EPERM')).toBe('other')
  })
})

describe('folderReadOfCommand', () => {
  it('counts a failed ls as denied only when it says Operation not permitted', () => {
    expect(folderReadOfCommand(0, '')).toBe('ok')
    expect(folderReadOfCommand(1, 'ls: /Users/a/Downloads: Operation not permitted ')).toBe(
      'denied',
    )
    expect(folderReadOfCommand(1, 'ls: /Users/a/Downloads: Permission denied ')).toBe('other')
    expect(folderReadOfCommand(1, 'ls: /Users/a/Desktop: No such file or directory ')).toBe('other')
    expect(folderReadOfCommand(2, '')).toBe('other')
  })
})

describe('FolderAccessMonitor', () => {
  it('does not report a folder that was never readable in this launch', () => {
    const monitor = new FolderAccessMonitor()
    expect(monitor.observe([{ Downloads: 'denied' }])).toBeNull()
    expect(monitor.observe([{ Downloads: 'denied' }, { Downloads: 'denied' }])).toBeNull()
  })

  it('reports a folder that was readable earlier and is denied now', () => {
    const monitor = new FolderAccessMonitor()
    expect(monitor.observe([{ Downloads: 'ok', Documents: 'ok' }])).toBeNull()
    expect(monitor.observe([{ Downloads: 'denied', Documents: 'ok' }])).toEqual(['Downloads'])
  })

  it('reports a folder the kept shells cannot read while Ostia itself can', () => {
    const monitor = new FolderAccessMonitor()
    expect(
      monitor.observe([
        { Downloads: 'ok', Documents: 'ok' },
        { Downloads: 'denied', Documents: 'ok' },
      ]),
    ).toEqual(['Downloads'])
  })

  it('does not report Permission denied or a missing folder', () => {
    const monitor = new FolderAccessMonitor()
    monitor.observe([{ Downloads: 'ok', Documents: 'ok' }])
    expect(monitor.observe([{ Downloads: 'other', Documents: 'other' }])).toBeNull()
  })

  it('reports the same set of folders once per launch and a new set again', () => {
    const monitor = new FolderAccessMonitor()
    monitor.observe([{ Downloads: 'ok', Documents: 'ok' }])
    expect(monitor.observe([{ Downloads: 'denied' }])).toEqual(['Downloads'])
    expect(monitor.observe([{ Downloads: 'denied' }])).toBeNull()
    expect(monitor.observe([{ Downloads: 'denied', Documents: 'denied' }])).toEqual([
      'Downloads',
      'Documents',
    ])
    expect(monitor.observe([{ Downloads: 'denied' }])).toBeNull()
  })
})
