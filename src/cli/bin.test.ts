import { describe, expect, it } from 'vitest'
import pkg from '../../package.json'

describe('installed commands', () => {
  it('installs the ostia command only', () => {
    expect(pkg.bin).toEqual({ ostia: './out/cli/index.js' })
  })
})
