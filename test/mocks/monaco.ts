export interface FakeRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export interface FakeChange {
  range: FakeRange
  rangeLength: number
  text: string
}

type Listener<T> = (event: T) => void

export class FakeUri {
  constructor(readonly path: string) {}

  static file(path: string): FakeUri {
    return new FakeUri(path)
  }

  static parse(text: string): FakeUri {
    return new FakeUri(decodeURIComponent(text.replace(/^file:\/\//, '')))
  }

  get fsPath(): string {
    return this.path
  }

  toString(): string {
    return `file://${this.path}`
  }
}

export class FakeModel {
  private readonly changeListeners = new Set<Listener<{ changes: FakeChange[] }>>()
  private readonly disposeListeners = new Set<() => void>()
  private disposed = false
  readonly uri: FakeUri

  constructor(
    path: string,
    private value: string,
    private readonly language = 'plaintext',
  ) {
    this.uri = new FakeUri(path)
  }

  getValue(): string {
    return this.value
  }

  getLanguageId(): string {
    return this.language
  }

  isDisposed(): boolean {
    return this.disposed
  }

  getLineCount(): number {
    return this.value.split('\n').length
  }

  getLineMaxColumn(line: number): number {
    return (this.value.split('\n')[line - 1] ?? '').length + 1
  }

  getWordUntilPosition(position: { lineNumber: number; column: number }): {
    word: string
    startColumn: number
    endColumn: number
  } {
    const line = this.value.split('\n')[position.lineNumber - 1] ?? ''
    let start = position.column - 1
    while (start > 0 && /\w/.test(line[start - 1])) start -= 1
    return {
      word: line.slice(start, position.column - 1),
      startColumn: start + 1,
      endColumn: position.column,
    }
  }

  getWordAtPosition(position: { lineNumber: number; column: number }): {
    word: string
    startColumn: number
    endColumn: number
  } | null {
    const line = this.value.split('\n')[position.lineNumber - 1] ?? ''
    let start = position.column - 1
    let end = position.column - 1
    while (start > 0 && /\w/.test(line[start - 1])) start -= 1
    while (end < line.length && /\w/.test(line[end])) end += 1
    return start === end
      ? null
      : { word: line.slice(start, end), startColumn: start + 1, endColumn: end + 1 }
  }

  getValueInRange(range: FakeRange): string {
    return this.value.slice(
      this.offsetAt(range.startLineNumber, range.startColumn),
      this.offsetAt(range.endLineNumber, range.endColumn),
    )
  }

  private offsetAt(line: number, column: number): number {
    const lines = this.value.split('\n')
    let offset = 0
    for (let i = 0; i < line - 1; i++) offset += lines[i].length + 1
    return offset + column - 1
  }

  edit(range: FakeRange, text: string): void {
    const start = this.offsetAt(range.startLineNumber, range.startColumn)
    const end = this.offsetAt(range.endLineNumber, range.endColumn)
    this.value = this.value.slice(0, start) + text + this.value.slice(end)
    const event = { changes: [{ range, rangeLength: end - start, text }] }
    for (const listener of [...this.changeListeners]) listener(event)
  }

  pushEditOperations(
    _before: unknown,
    edits: { range: FakeRange; text: string }[],
    _after: unknown,
  ): null {
    const ordered = [...edits].sort(
      (a, b) =>
        b.range.startLineNumber - a.range.startLineNumber ||
        b.range.startColumn - a.range.startColumn,
    )
    for (const edit of ordered) this.edit(edit.range, edit.text)
    return null
  }

  onDidChangeContent(listener: Listener<{ changes: FakeChange[] }>): { dispose: () => void } {
    this.changeListeners.add(listener)
    return { dispose: () => this.changeListeners.delete(listener) }
  }

  onWillDispose(listener: () => void): { dispose: () => void } {
    this.disposeListeners.add(listener)
    return { dispose: () => this.disposeListeners.delete(listener) }
  }

  dispose(): void {
    for (const listener of [...this.disposeListeners]) listener()
    this.disposed = true
  }
}

export interface Registration {
  kind: string
  language: string
  provider: Record<string, unknown>
  extra: unknown[]
  disposed: boolean
}

export interface FakeMonaco {
  monaco: Record<string, unknown>
  markers: Map<string, unknown[]>
  registrations: Registration[]
  models: Map<string, FakeModel>
  commands: Map<string, (...args: unknown[]) => void>
  active: (kind: string) => Registration[]
  addModel: (model: FakeModel) => FakeModel
}

function enumOf(names: string[], offset = 0): Record<string, number> {
  return Object.fromEntries(names.map((name, index) => [name, index + offset]))
}

export function createFakeMonaco(): FakeMonaco {
  const markers = new Map<string, unknown[]>()
  const registrations: Registration[] = []
  const models = new Map<string, FakeModel>()
  const commands = new Map<string, (...args: unknown[]) => void>()
  const constants: Record<string, unknown> = {
    CompletionItemKind: enumOf([
      'Method',
      'Function',
      'Constructor',
      'Field',
      'Variable',
      'Class',
      'Struct',
      'Interface',
      'Module',
      'Property',
      'Event',
      'Operator',
      'Unit',
      'Value',
      'Constant',
      'Enum',
      'EnumMember',
      'Keyword',
      'Text',
      'Color',
      'File',
      'Reference',
      'Customcolor',
      'Folder',
      'TypeParameter',
      'User',
      'Issue',
      'Snippet',
    ]),
    CompletionItemInsertTextRule: { None: 0, KeepWhitespace: 1, InsertAsSnippet: 4 },
    CompletionItemTag: { Deprecated: 1 },
    SymbolKind: enumOf([
      'File',
      'Module',
      'Namespace',
      'Package',
      'Class',
      'Method',
      'Property',
      'Field',
      'Constructor',
      'Enum',
      'Interface',
      'Function',
      'Variable',
      'Constant',
      'String',
      'Number',
      'Boolean',
      'Array',
      'Object',
      'Key',
      'Null',
      'EnumMember',
      'Struct',
      'Event',
      'Operator',
      'TypeParameter',
    ]),
    SymbolTag: { Deprecated: 1 },
    DocumentHighlightKind: { Text: 0, Read: 1, Write: 2 },
    InlayHintKind: { Type: 1, Parameter: 2 },
    SignatureHelpTriggerKind: { Invoke: 1, TriggerCharacter: 2, ContentChange: 3 },
    CodeActionTriggerType: { Invoke: 1, Auto: 2 },
  }
  const languages = new Proxy(constants, {
    get(target, property) {
      const name = String(property)
      if (name in target) return target[name]
      if (!name.startsWith('register')) return undefined
      return (language: string, provider: Record<string, unknown>, ...extra: unknown[]) => {
        const registration: Registration = {
          kind: name.replace(/^register/, ''),
          language,
          provider,
          extra,
          disposed: false,
        }
        registrations.push(registration)
        return {
          dispose: () => {
            registration.disposed = true
          },
        }
      }
    },
  })
  const monaco = {
    Uri: FakeUri,
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    MarkerTag: { Unnecessary: 1, Deprecated: 2 },
    editor: {
      registerCommand: (id: string, handler: (...args: unknown[]) => void) => {
        commands.set(id, handler)
        return { dispose: () => commands.delete(id) }
      },
      setModelMarkers: (model: FakeModel, owner: string, list: unknown[]) => {
        markers.set(`${owner} ${model.uri.toString()}`, list)
      },
      getModel: (uri: FakeUri) => models.get(uri.toString()) ?? null,
      getModels: () => [...models.values()],
    },
    languages,
  }
  return {
    monaco,
    markers,
    registrations,
    models,
    commands,
    active: (kind) => registrations.filter((r) => r.kind === kind && !r.disposed),
    addModel: (model) => {
      models.set(model.uri.toString(), model)
      return model
    },
  }
}
