import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { silenceQueryReplies } from './tmuxQueries'

const QUERIES = [
  '\x1b[6n',
  '\x1b[?6n',
  '\x1b[5n',
  '\x1b[c',
  '\x1b[>c',
  '\x1b[?2004$p',
  '\x1b]10;?\x07',
  '\x1b]11;?\x1b\\',
  '\x1b[14t',
]

function replies(term: Terminal, input: string): Promise<string[]> {
  const out: string[] = []
  const sub = term.onData((d) => out.push(d))
  return new Promise((resolve) =>
    term.write(input, () => {
      sub.dispose()
      resolve(out)
    }),
  )
}

describe('silenceQueryReplies', () => {
  it('KSH-C28 leaves terminal queries in a tmux pane to tmux, so the program gets one reply', async () => {
    const plain = new Terminal({ allowProposedApi: true })
    expect((await replies(plain, '\x1b[6n')).length).toBe(1)
    const kept = new Terminal({ allowProposedApi: true })
    silenceQueryReplies(kept)
    for (const query of QUERIES) expect(await replies(kept, query)).toEqual([])
  })

  it('still draws text and colours around the queries', async () => {
    const kept = new Terminal({ allowProposedApi: true, cols: 20, rows: 2 })
    silenceQueryReplies(kept)
    await replies(kept, '\x1b[31mab\x1b[6ncd\x1b[0m')
    expect(kept.buffer.active.getLine(0)?.translateToString(true)).toBe('abcd')
  })
})
