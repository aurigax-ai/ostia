import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('the device name sent to the server', () => {
  it('SSY-C133 is the desktop name, never the machine hostname', () => {
    const source = readFileSync(join(__dirname, 'serverWiring.ts'), 'utf8')
    expect(source).not.toMatch(/hostname/)
    expect(source).toMatch(/deviceName: \(\) => friendlyName\(\)/)
  })
})
