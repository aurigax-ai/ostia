import { AssistantService } from '../src/extensions/assistant/service'

const svc = new AssistantService({ XDG_RUNTIME_DIR: '/run/user/1000' })
svc.configure({ provider: 'model-runtime' }, null)

function ctx() {
  const chunks: string[] = []
  return {
    chunks,
    c: {
      requestId: 'r',
      signal: new AbortController().signal,
      chunk: async (t: string) => {
        chunks.push(t)
        return true
      },
    },
  }
}

async function time<T>(name: string, fn: () => Promise<T>): Promise<void> {
  const t = Date.now()
  try {
    const r = await fn()
    console.log(`\n## ${name} (${Date.now() - t} ms)\n${JSON.stringify(r, null, 1)}`)
  } catch (e) {
    console.log(`\n## ${name} FAILED (${Date.now() - t} ms)`, (e as Error).message, (e as { code?: string }).code)
  }
}

async function main(): Promise<void> {
  const which = process.argv[2] ?? 'all'
  console.log(JSON.stringify(svc.status()))
  if (which === 'all' || which === 'typos')
    await time('typos', () =>
      svc.handle('input', { text: 'plese refactr the auth modle and add tests for the loign flow', tasks: ['typos'] }, ctx().c),
    )
  if (which === 'all' || which === 'review')
    await time('review', () =>
      svc.handle('input', { text: 'fix the bug', tasks: ['review'], agent: 'claude' }, ctx().c),
    )
  if (which === 'all' || which === 'command')
    await time('command', () =>
      svc.handle('command', { query: 'find files larger than 100MB here', cwd: '/home/u/proj', platform: 'linux', shell: 'zsh' }, ctx().c),
    )
  if (which === 'all' || which === 'completion')
    await time('completion', () =>
      svc.handle(
        'completion',
        {
          path: '/p/math.ts',
          language: 'typescript',
          prefix: 'export function add(a: number, b: number): number {\n  return a + b\n}\n\nexport function multiply(a: number, b: number): number {\n  ',
          suffix: '\n}\n',
        },
        ctx().c,
      ),
    )
  if (which === 'all' || which === 'chat') {
    const k = ctx()
    await time('chat', () =>
      svc.handle('chat', { messages: [{ role: 'user', content: 'How do I list listening TCP ports on Linux? One command.' }], context: [] }, k.c),
    )
    console.log('chunks', k.chunks.length)
  }
}

void main()
