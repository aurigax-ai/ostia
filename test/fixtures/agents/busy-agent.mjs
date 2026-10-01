const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const fps = Number(process.env.BUSY_AGENT_FPS ?? 30)
const burstEvery = Number(process.env.BUSY_AGENT_BURST_EVERY ?? 5)
const burstLines = Number(process.env.BUSY_AGENT_BURST_LINES ?? 20)
const titleTask = process.env.BUSY_AGENT_TITLE ?? 'Busy task'

let frame = 0
let typed = ''
let line = 0
let timer = null

const out = (text) => process.stdout.write(text)
const spinner = () => SPINNER[frame % SPINNER.length]
const status = () =>
  `\x1b[2K\x1b[36m${spinner()}\x1b[0m Working… frame ${frame}\r\n\x1b[2K> ${typed}`
const redraw = () => out(`\r\x1b[1A${status()}`)

const burst = () => {
  let text = '\r\x1b[1A\x1b[0J'
  for (let i = 0; i < burstLines; i++) {
    line++
    text += `\x1b[32m●\x1b[0m output line ${line} \x1b[2m${'·'.repeat(line % 40)}\x1b[0m\r\n`
  }
  out(text + status())
}

const tick = () => {
  frame++
  out(`\x1b]0;${spinner()} ${titleTask}\x07`)
  if (burstEvery > 0 && frame % burstEvery === 0) burst()
  else redraw()
}

const finish = () => {
  if (timer) clearInterval(timer)
  out(`\x1b]0;✳ ${titleTask}\x07\r\n\x1b[2Kbusy-agent done\r\n`)
  process.stdin.setRawMode?.(false)
  process.exit(0)
}

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  for (const ch of data) {
    if (ch === '\x03' || ch === '\x04') finish()
    else if (ch === '\x7f') typed = typed.slice(0, -1)
    else if (ch >= ' ') typed += ch
  }
  redraw()
})

out(`\x1b]0;✳ ${titleTask}\x07busy-agent ready\r\n\r\n${status()}`)
if (fps > 0) timer = setInterval(tick, 1000 / fps)
