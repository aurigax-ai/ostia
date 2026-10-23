import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { linkPluginsFarm } from './pluginsFarm'

let root: string
let source: string
let farm: string
let data: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ostia-plugins-farm-'))
  source = join(root, 'plugins')
  farm = join(root, 'farm')
  data = join(root, 'data')
  mkdirSync(join(source, 'data/codex'), { recursive: true })
  mkdirSync(join(source, 'cache'))
  writeFileSync(join(source, 'installed_plugins.json'), '{}')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('linkPluginsFarm', () => {
  it('links every real entry except data, and points data at a folder of its own', () => {
    linkPluginsFarm(farm, data, source)
    expect(readlinkSync(join(farm, 'cache'))).toBe(join(source, 'cache'))
    expect(readlinkSync(join(farm, 'installed_plugins.json'))).toBe(
      join(source, 'installed_plugins.json'),
    )
    expect(readlinkSync(join(farm, 'data'))).toBe(data)
    expect(readdirSync(data)).toEqual([])
    expect(lstatSync(farm).mode & 0o777).toBe(0o700)
  })

  it('follows the real folder on the next call and keeps the data the sandbox wrote', () => {
    linkPluginsFarm(farm, data, source)
    writeFileSync(join(data, 'state.json'), '{}')
    mkdirSync(join(source, 'marketplaces'))
    rmSync(join(source, 'cache'), { recursive: true })
    linkPluginsFarm(farm, data, source)
    expect(existsSync(join(farm, 'marketplaces'))).toBe(true)
    expect(existsSync(join(farm, 'cache'))).toBe(false)
    expect(existsSync(join(data, 'state.json'))).toBe(true)
  })

  it('makes only the data link when the real plugins folder does not exist', () => {
    linkPluginsFarm(farm, data, join(root, 'missing'))
    expect(readdirSync(farm)).toEqual(['data'])
  })
})
