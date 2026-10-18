import { join } from 'node:path'
import { connect } from '@aurigax-ai/ostia-extension-sdk'
import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { ARCHIVE_READS_DIR } from '@aurigax-ai/ostia-extension-sdk/contract/archiveReaders'
import { type Opener, listArchive, readArchive } from './archiveAnswers'
import { openXz } from './xzSource'

const OPENERS: Record<string, Opener> = { xz: openXz }

async function main(): Promise<void> {
  const ext = await connect()
  const dataDir = readEnv('EXTENSION_DATA')
  const readsDir = dataDir ? join(dataDir, ARCHIVE_READS_DIR) : null
  ext.onArchive(async (req, { signal }) => {
    const opener = OPENERS[req.reader]
    if (!opener)
      return req.op === 'list'
        ? { ok: false, error: 'unsupported' }
        : { ok: false, error: 'failed' }
    return req.op === 'list'
      ? listArchive(req, opener, signal)
      : readArchive(req, opener, signal, readsDir)
  })
  await ext.registerCommands({})
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
