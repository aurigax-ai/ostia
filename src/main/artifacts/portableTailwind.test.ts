import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PortableTailwind } from './portableTailwind'

const runtimeDir = join(process.cwd(), 'out', 'artifact-runtime')

describe('PortableTailwind', () => {
  it('PRT-C68 compiles off the main thread, so a timer fires while a large page compiles', async () => {
    const tailwind = new PortableTailwind(() => runtimeDir)
    const classes = Array.from({ length: 60_000 }, (_, i) => `p-[${i}px] m-[${i}px]`).join(' ')
    const order: string[] = []
    const css = tailwind.css('component', [classes]).then((out) => {
      order.push('css')
      return out
    })
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        order.push('timer')
        resolve()
      }, 20),
    )
    await Promise.all([css, timer])
    expect(order[0]).toBe('timer')
    expect(await css).toContain('.p-\\[59999px\\]')
  })

  it('PRT-C68 stops a compile that is asked to stop, and answers no CSS', async () => {
    const tailwind = new PortableTailwind(() => runtimeDir)
    const controller = new AbortController()
    const classes = Array.from({ length: 60_000 }, (_, i) => `p-[${i}px]`).join(' ')
    const css = tailwind.css('component', [classes], controller.signal)
    controller.abort()
    await expect(css).rejects.toThrow(/stopped/)
  })
})
