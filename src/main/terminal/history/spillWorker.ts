import { parentPort } from 'node:worker_threads'
import { type SpillHostPort, serveSpill } from './spillHost'

if (parentPort) serveSpill(parentPort as unknown as SpillHostPort)
