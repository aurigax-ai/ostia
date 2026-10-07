import { beforeEach } from 'vitest'
import { activeEntries, isListed, quarantineMode } from './quarantine.mjs'

const entries = activeEntries()
const only = quarantineMode() === 'only'

beforeEach((ctx) => {
  const titles: string[] = [ctx.task.name]
  for (let suite = ctx.task.suite; suite && suite !== ctx.task.file; suite = suite.suite) {
    titles.unshift(suite.name)
  }
  const listed = isListed(entries, ctx.task.file.filepath, titles.join(' > '))
  if (listed !== only) ctx.skip()
})
