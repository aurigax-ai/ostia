import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { _electron as electron, expect, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'
import { PROMPT, openWorkspace } from './helpers'

const SUGGESTED = 'echo pine-assist-suggested'
const ANSWER_PARTS = ['Use this', ' to list files:\n\n', '```bash\nls -la\n```\n']

interface ChatBody {
  model?: string
  stream?: boolean
  messages?: { role: string; content: string }[]
}

function readJson(req: IncomingMessage): Promise<ChatBody> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => resolve(JSON.parse(raw || '{}') as ChatBody))
  })
}

function reply(res: ServerResponse, content: string): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      id: 'x',
      object: 'chat.completion',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    }),
  )
}

function stream(res: ServerResponse, parts: string[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  let i = 0
  const next = (): void => {
    if (i < parts.length) {
      const delta = { choices: [{ index: 0, delta: { content: parts[i++] } }] }
      res.write(`data: ${JSON.stringify(delta)}\n\n`)
      setTimeout(next, 150)
    } else {
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }
  next()
}

function startFakeProvider(): Promise<{ server: Server; url: string; models: string[] }> {
  const models: string[] = []
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'fake-small' }, { id: 'fake-big' }] }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404)
      res.end()
      return
    }
    const body = await readJson(req)
    models.push(body.model ?? '')
    const system = body.messages?.find((m) => m.role === 'system')?.content ?? ''
    if (body.stream) {
      stream(res, ANSWER_PARTS)
    } else if (system.includes('"suggestions"')) {
      reply(
        res,
        JSON.stringify({ suggestions: [{ command: SUGGESTED, description: 'prints a marker' }] }),
      )
    } else {
      reply(res, ANSWER_PARTS.join(''))
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, models })
    })
  })
}

test('a custom OpenAI-compatible provider set in Settings answers in Ask and suggests a command that is inserted, not run', async () => {
  const provider = await startFakeProvider()
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    await win.keyboard.press('Control+,')
    const settings = win.getByRole('region', { name: 'Settings' })
    await expect(settings).toBeVisible({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Plugins', exact: true }).click()
    const assistant = settings.getByRole('group', { name: /Assistant/ })
    await assistant.getByRole('combobox', { name: 'provider' }).click()
    await win.getByRole('option', { name: 'openai-compatible', exact: true }).click()
    for (const [key, value] of [
      ['baseUrl', provider.url],
      ['fastModel', 'fake-small'],
      ['chatModel', 'fake-big'],
    ]) {
      const box = assistant.getByRole('textbox', { name: key, exact: true })
      await box.fill(value)
      await box.press('Enter')
    }
    await expect(assistant).toContainText('openai-compatible · fake-big', { timeout: 15_000 })
    await win.keyboard.press('Escape')

    await win.locator('.xterm').first().click()
    await win.keyboard.press('Control+Shift+P')
    const palette = win.getByRole('dialog')
    await expect(palette).toBeVisible()
    await win.keyboard.type('how do I list files')
    await win.keyboard.press('Tab')
    await win.keyboard.press('Enter')
    const answer = palette.locator('.ask-answer').last()
    await expect(answer).toContainText('Use this to list files', { timeout: 15_000 })
    await expect(answer.locator('.ask-code-body')).toContainText('ls -la')
    expect(provider.models).toContain('fake-big')
    await win.keyboard.press('Escape')
    await expect(palette).toBeHidden()

    await win.locator('.xterm').first().click()
    await win.keyboard.press('Control+Shift+J')
    const composer = win.getByRole('region', { name: 'Describe a command' })
    await expect(composer).toBeVisible({ timeout: 5_000 })
    await win.keyboard.type('print a marker')
    const suggestion = composer.getByRole('option', { name: new RegExp(SUGGESTED) })
    await expect(suggestion).toBeVisible({ timeout: 15_000 })
    await win.keyboard.press('Enter')
    await expect(composer).toBeHidden()
    const rows = win.locator('.xterm-rows').first()
    await expect(rows).toContainText(SUGGESTED, { timeout: 10_000 })
    await win.waitForTimeout(500)
    await expect(rows).not.toContainText('pine-assist-suggested\npine-assist-suggested')
    const lines = (await rows.innerText()).split('\n').filter((l) => l.includes(SUGGESTED))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(PROMPT)
    expect(provider.models).toContain('fake-small')
  } finally {
    await app.close()
    provider.server.close()
  }
})
