import { spillWorker } from '../../../src/main/terminal/history/historyFeed'

const keepAlive = setTimeout(() => process.exit(2), 30_000)
const worker = spillWorker(process.argv[2] ?? '')
worker.once('online', async () => {
  console.log((await worker.getHeapStatistics()).heap_size_limit)
  await worker.terminate()
  clearTimeout(keepAlive)
})
