import { resolve } from 'node:path'
import { createWorkerScan } from '../src/main/privacy/redactionScan'

export const REDACTION_WORKER_SCRIPT = resolve(__dirname, '../out/redaction/worker.js')

export const testScan = createWorkerScan(REDACTION_WORKER_SCRIPT).scan
