import { resolve } from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import { SpillClient, type SpillPort } from '../src/main/terminal/history/historyFeed'
import { type SpillHostPort, serveSpill } from '../src/main/terminal/history/spillHost'

export const HISTORY_WORKER_SCRIPT = resolve(__dirname, '../out/history/worker.js')

const channels: MessageChannel[] = []

export function spillInThread(): SpillClient {
  const channel = new MessageChannel()
  channels.push(channel)
  serveSpill(channel.port1 as unknown as SpillHostPort)
  return new SpillClient(channel.port2 as unknown as SpillPort)
}

export function closeSpillChannels(): void {
  for (const channel of channels.splice(0)) {
    channel.port1.close()
    channel.port2.close()
  }
}
