import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExtensionLaunches } from './extensionLaunches'

const file = () => join(mkdtempSync(join(tmpdir(), 'ostia-launches-')), 'extension-launches.json')

describe('ExtensionLaunches', () => {
  it('keeps the ids that asked to start with the window across a reload', () => {
    const path = file()
    const launches = new ExtensionLaunches(path)
    launches.set('graphs', true)
    launches.set('activity', true)
    launches.set('activity', false)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(['graphs'])
    expect(new ExtensionLaunches(path).has('graphs')).toBe(true)
    expect(new ExtensionLaunches(path).has('activity')).toBe(false)
  })

  it('drops what is not an extension id', () => {
    const path = file()
    writeFileSync(path, JSON.stringify(['graphs', '../x', 7, 'Bad']))
    const launches = new ExtensionLaunches(path)
    expect(launches.has('graphs')).toBe(true)
    expect(launches.has('../x')).toBe(false)
    expect(launches.has('Bad')).toBe(false)
  })
})
