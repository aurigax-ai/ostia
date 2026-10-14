import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'

const HOLD_PORT_PY = [
  'import socket, sys',
  's = socket.socket()',
  's.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)',
  "s.bind(('127.0.0.1', 0))",
  'print(s.getsockname()[1], flush=True)',
  'sys.stdin.read()',
].join('\n')

interface HeldPort {
  port: number
  release: () => void
}

export async function holdPort(): Promise<HeldPort> {
  const holder = spawn('python3', ['-c', HOLD_PORT_PY], { stdio: ['pipe', 'pipe', 'inherit'] })
  const [line] = (await once(createInterface({ input: holder.stdout }), 'line')) as [string]
  return { port: Number(line), release: () => holder.kill() }
}
