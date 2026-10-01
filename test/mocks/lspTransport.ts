import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageConnection,
  type MessageReader,
  type MessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/browser'

class QueueReader extends AbstractMessageReader implements MessageReader {
  private callback: DataCallback | null = null
  private readonly queued: Message[] = []

  listen(callback: DataCallback): Disposable {
    this.callback = callback
    for (const message of this.queued.splice(0)) callback(message)
    return {
      dispose: () => {
        this.callback = null
      },
    }
  }

  push(message: Message): void {
    if (this.callback) this.callback(message)
    else this.queued.push(message)
  }
}

class CallbackWriter extends AbstractMessageWriter implements MessageWriter {
  readonly sent: Message[] = []

  constructor(private readonly deliver: (message: Message) => void) {
    super()
  }

  async write(message: Message): Promise<void> {
    const copy = JSON.parse(JSON.stringify(message)) as Message
    this.sent.push(copy)
    queueMicrotask(() => this.deliver(copy))
  }

  end(): void {}
}

export interface ServerEndpoint {
  server: MessageConnection
  receive: (message: unknown) => void
  received: Message[]
  sent: Message[]
}

export function createServerEndpoint(deliver: (message: Message) => void): ServerEndpoint {
  const inbox = new QueueReader()
  const writer = new CallbackWriter(deliver)
  const received: Message[] = []
  return {
    server: createMessageConnection(inbox, writer),
    receive: (message) => {
      const copy = JSON.parse(JSON.stringify(message)) as Message
      received.push(copy)
      inbox.push(copy)
    },
    received,
    sent: writer.sent,
  }
}

export interface LinkedTransport extends ServerEndpoint {
  clientReader: MessageReader
  clientWriter: MessageWriter
}

export function createLinkedTransport(): LinkedTransport {
  const clientInbox = new QueueReader()
  const endpoint = createServerEndpoint((message) => clientInbox.push(message))
  return {
    ...endpoint,
    clientReader: clientInbox,
    clientWriter: new CallbackWriter((message) => endpoint.receive(message)),
  }
}
