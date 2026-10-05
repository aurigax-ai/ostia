import { describe, expect, it } from 'vitest'
import pkg from '../../package.json'

describe('installed commands', () => {
  it('installs ostia and keeps pine as the same program', () => {
    expect(pkg.bin.ostia).toBe('./out/cli/index.js')
    expect(pkg.bin.pine).toBe(pkg.bin.ostia)
  })
})
