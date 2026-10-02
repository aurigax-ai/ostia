import { parentPort } from 'node:worker_threads'
import { compilePatterns, customSpans, extraSpans } from '../shared/redaction'
import type { ScanReply, ScanRequest } from './redactionScan'
import { scanSecrets } from './secretScanner'

let compiledFor = ''
let compiled: RegExp[] = []

function patterns(sources: string[]): RegExp[] {
  const key = JSON.stringify(sources)
  if (key !== compiledFor) {
    compiled = compilePatterns(sources)
    compiledFor = key
  }
  return compiled
}

parentPort?.on('message', async (request: ScanRequest) => {
  let reply: ScanReply
  try {
    const spans = [
      ...(await scanSecrets(request.text)),
      ...extraSpans(request.text),
      ...customSpans(request.text, patterns(request.patterns)),
    ]
    reply = { id: request.id, spans }
  } catch (error) {
    reply = { id: request.id, error: error instanceof Error ? error.message : 'scan failed' }
  }
  parentPort?.postMessage(reply)
})
