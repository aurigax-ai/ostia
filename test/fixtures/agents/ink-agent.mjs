const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const transcriptLines = Number(process.env.INK_AGENT_LINES ?? 5000)
const streamFps = Number(process.env.INK_AGENT_STREAM_FPS ?? 0)
const streamLines = Number(process.env.INK_AGENT_STREAM_LINES ?? 2)
const TAIL_ROWS = Number(process.env.INK_AGENT_REGION_ROWS ?? 0)
const BOX_ROWS = 5 + TAIL_ROWS
const sync = process.env.INK_AGENT_SYNC === '1'
const fullRedraw = Number(process.env.INK_AGENT_FULL_REDRAW ?? 0)

let typed = ''
let frame = 0
let line = 0
let drawn = 0

const out = (text) => process.stdout.write(text)

const transcriptLine = () => {
  line++
  const body = `${'lorem ipsum dolor sit amet '.repeat(1 + (line % 4))}`.trimEnd()
  const tag = line % 7 === 0 ? '\x1b[1;33m⏺\x1b[0m' : '\x1b[32m●\x1b[0m'
  return `${tag} \x1b[2m${String(line).padStart(5, '0')}\x1b[0m ${body} \x1b[36m${'x'.repeat(line % 30)}\x1b[0m\r\n`
}

const tailRow = (k) =>
  `\x1b[2m  ${String(line - k).padStart(5, '0')} streamed output ${'·'.repeat((line - k) % 40)}\x1b[0m`.padEnd(
    60,
  )

const region = () =>
  [
    ...Array.from({ length: TAIL_ROWS }, (_, k) => tailRow(TAIL_ROWS - k)),
    `\x1b[35m${SPINNER[frame % SPINNER.length]}\x1b[0m Working… (${frame}s · esc to interrupt)`,
    '',
    '╭────────────────────────────────────────────────────────╮',
    `│ > ${typed.padEnd(52)} │`,
    '╰────────────────────────────────────────────────────────╯',
  ].join('\r\n')

const erase = () => (drawn > 0 ? `\r${'\x1b[2K\x1b[1A'.repeat(drawn - 1)}\x1b[2K` : '')

const recent = []

const redraw = (before = '') => {
  if (fullRedraw > 0) {
    recent.push(before)
    if (recent.length > fullRedraw) recent.splice(0, recent.length - fullRedraw)
  }
  const body =
    fullRedraw > 0
      ? `\x1b[2J\x1b[3J\x1b[H${recent.join('')}${region()}`
      : `${erase()}${before}${region()}`
  out(sync ? `\x1b[?2026h${body}\x1b[?2026l` : body)
  drawn = BOX_ROWS
}

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  for (const ch of data) {
    if (ch === '\x03' || ch === '\x04') {
      out(`${erase()}ink-agent done\r\n`)
      process.exit(0)
    }
    if (ch === '\x7f') typed = typed.slice(0, -1)
    else if (ch >= ' ') typed += ch
  }
  redraw()
})

let transcript = ''
for (let i = 0; i < transcriptLines; i++) transcript += transcriptLine()
out('\x1b]0;✳ Ink task\x07')
redraw(transcript)

if (streamFps > 0) {
  setInterval(() => {
    frame++
    let text = ''
    for (let i = 0; i < streamLines; i++) text += transcriptLine()
    out(`\x1b]0;${SPINNER[frame % SPINNER.length]} Ink task\x07`)
    redraw(text)
  }, 1000 / streamFps)
}
