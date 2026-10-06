import { StringDecoder } from 'node:string_decoder'

export type ControlEvent =
  | { type: 'output'; pane: string; data: string }
  | { type: 'reply'; ok: boolean; lines: string[] }
  | { type: 'subscription'; name: string; pane: string; value: string }
  | { type: 'exit' }

const BACKSLASH = 0x5c
const NEWLINE = 0x0a
const SPACE = 0x20
const CLIENT_COMMAND_FLAG = 1
const OUTPUT_PREFIX = '%output '

function isOctalDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x37
}

export function unescapeOutput(escaped: Buffer): Buffer {
  const out = Buffer.allocUnsafe(escaped.length)
  let n = 0
  for (let i = 0; i < escaped.length; i++) {
    const byte = escaped[i]
    if (
      byte === BACKSLASH &&
      isOctalDigit(escaped[i + 1]) &&
      isOctalDigit(escaped[i + 2]) &&
      isOctalDigit(escaped[i + 3])
    ) {
      out[n++] =
        ((escaped[i + 1] - 0x30) << 6) | ((escaped[i + 2] - 0x30) << 3) | (escaped[i + 3] - 0x30)
      i += 3
    } else {
      out[n++] = byte
    }
  }
  return out.subarray(0, n)
}

interface OpenReply {
  number: string
  ours: boolean
  lines: string[]
}

export class ControlModeParser {
  private pending: Buffer = Buffer.alloc(0)
  private reply: OpenReply | null = null
  private readonly decoders = new Map<string, StringDecoder>()

  constructor(private readonly emit: (event: ControlEvent) => void) {}

  push(chunk: Buffer): void {
    let data = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk
    let newline = data.indexOf(NEWLINE)
    while (newline !== -1) {
      this.line(data.subarray(0, newline))
      data = data.subarray(newline + 1)
      newline = data.indexOf(NEWLINE)
    }
    this.pending = Buffer.from(data)
  }

  forgetPane(pane: string): void {
    this.decoders.delete(pane)
  }

  private line(raw: Buffer): void {
    if (this.reply) {
      this.replyLine(this.reply, raw.toString('utf8'))
      return
    }
    if (raw.subarray(0, OUTPUT_PREFIX.length).toString('latin1') === OUTPUT_PREFIX) {
      const paneEnd = raw.indexOf(SPACE, OUTPUT_PREFIX.length)
      if (paneEnd === -1) return
      const pane = raw.subarray(OUTPUT_PREFIX.length, paneEnd).toString('latin1')
      this.output(pane, unescapeOutput(raw.subarray(paneEnd + 1)))
      return
    }
    this.notification(raw.toString('utf8'))
  }

  private replyLine(reply: OpenReply, text: string): void {
    const [word, , number] = text.split(' ')
    if ((word === '%end' || word === '%error') && number === reply.number) {
      this.reply = null
      if (reply.ours) this.emit({ type: 'reply', ok: word === '%end', lines: reply.lines })
      return
    }
    reply.lines.push(text)
  }

  private notification(text: string): void {
    const words = text.split(' ')
    if (words[0] === '%begin') {
      this.reply = {
        number: words[2] ?? '',
        ours: (Number(words[3]) & CLIENT_COMMAND_FLAG) !== 0,
        lines: [],
      }
    } else if (words[0] === '%exit') {
      this.emit({ type: 'exit' })
    } else if (words[0] === '%subscription-changed') {
      const colon = text.indexOf(' : ')
      if (colon === -1) return
      this.emit({
        type: 'subscription',
        name: words[1] ?? '',
        pane: words[5] ?? '',
        value: text.slice(colon + 3),
      })
    }
  }

  private output(pane: string, bytes: Buffer): void {
    let decoder = this.decoders.get(pane)
    if (!decoder) {
      decoder = new StringDecoder('utf8')
      this.decoders.set(pane, decoder)
    }
    const data = decoder.write(bytes)
    if (data) this.emit({ type: 'output', pane, data })
  }
}
