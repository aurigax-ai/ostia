import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connect } from '@aurigax-ai/ostia-extension-sdk'
import { Tickets } from './tickets'
import { handoffVerbs } from './verbs'

async function main(): Promise<void> {
  const ext = await connect()
  const tickets = new Tickets({ now: Date.now, newId: () => randomBytes(4).toString('hex') })
  await ext.registerCommands(
    handoffVerbs({ ext, tickets, projectsDir: join(homedir(), '.claude', 'projects') }),
  )
  await ext.subscribe(['pane.closed'], (_type, payload) => {
    if ('paneId' in payload) tickets.forget(payload.paneId)
  })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
