import { createInterface } from 'node:readline'

createInterface({ input: process.stdin }).on('line', () => process.exit(1))
