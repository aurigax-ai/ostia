import { join } from 'node:path'
import { NODE_HOME } from '../shared/remote/remoteNode'

export interface NodePaths {
  root: string
  run: string
  socket: string
  tmuxSocket: string
  tmuxConf: string
  tokens: string
  jobs: string
  bus: string
  agents: string
}

export function nodePaths(home: string): NodePaths {
  const root = join(home, NODE_HOME)
  const run = join(root, 'run')
  return {
    root,
    run,
    socket: join(run, 'control.sock'),
    tmuxSocket: join(run, 'tmux'),
    tmuxConf: join(run, 'tmux.conf'),
    tokens: join(run, 'tokens'),
    jobs: join(root, 'jobs.json'),
    bus: join(root, 'bus.json'),
    agents: join(root, 'agents'),
  }
}
