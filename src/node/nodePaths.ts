import { join } from 'node:path'
import {
  NODE_AGENTS,
  NODE_HOME,
  NODE_REPOS,
  NODE_SOCKET,
  NODE_TMUX_SOCKET,
  NODE_TOKENS,
  NODE_WORK,
} from '../shared/remote/remoteNode'

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
  repos: string
  work: string
}

export function nodePaths(home: string): NodePaths {
  const root = join(home, NODE_HOME)
  const run = join(root, 'run')
  return {
    root,
    run,
    socket: join(home, NODE_SOCKET),
    tmuxSocket: join(home, NODE_TMUX_SOCKET),
    tmuxConf: join(run, 'tmux.conf'),
    tokens: join(home, NODE_TOKENS),
    jobs: join(root, 'jobs.json'),
    bus: join(root, 'bus.json'),
    agents: join(home, NODE_AGENTS),
    repos: join(home, NODE_REPOS),
    work: join(home, NODE_WORK),
  }
}
