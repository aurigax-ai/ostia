import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageReader,
  type MessageWriter,
} from 'vscode-jsonrpc'

export class IpcReader extends AbstractMessageReader implements MessageReader {
  private off: () => void = () => {}
  constructor(private readonly id: string) {
    super()
  }
  listen(callback: DataCallback): Disposable {
    this.off = window.pine.lsp.onMessage(this.id, (message) => callback(message as Message))
    return { dispose: () => this.off() }
  }
}

export class IpcWriter extends AbstractMessageWriter implements MessageWriter {
  constructor(private readonly id: string) {
    super()
  }
  async write(message: Message): Promise<void> {
    window.pine.lsp.send(this.id, message)
  }
  end(): void {}
}
