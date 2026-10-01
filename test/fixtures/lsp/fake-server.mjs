import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import rpc from 'vscode-jsonrpc/node'

const { StreamMessageReader, StreamMessageWriter, createMessageConnection } = rpc

const ALL_CAPS = [
  'completion',
  'hover',
  'definition',
  'formatting',
  'references',
  'rename',
  'signature',
  'symbols',
  'highlight',
  'rangeFormatting',
  'codeAction',
  'semanticTokens',
  'inlayHints',
]

function option(name) {
  const prefix = `--${name}=`
  const found = process.argv.find((arg) => arg.startsWith(prefix))
  return found === undefined ? undefined : found.slice(prefix.length)
}

const caps = new Set((option('caps') ?? ALL_CAPS.join(',')).split(',').filter(Boolean))
const recordFile = option('record')
const crashAfter = option('crash-after') === undefined ? null : Number(option('crash-after'))
const slowInit = Number(option('slow-init') ?? 0)
const incremental = option('sync') === 'incremental'
const serverName = option('name') ?? 'pine-fake-lsp'

function record(entry) {
  if (recordFile) appendFileSync(recordFile, `${JSON.stringify(entry)}\n`)
}

record({
  method: '$start',
  cwd: process.cwd(),
  argv: process.argv.slice(2),
  pineEnv: Object.keys(process.env).filter((name) => name.startsWith('PINE_')),
  runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
})

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
)
const documents = new Map()
let received = 0
let clientConfiguration = false

function seen(method, params) {
  record({ method, params })
  received += 1
  if (crashAfter !== null && received > crashAfter) process.exit(1)
}

function offsetAt(text, position) {
  const lines = text.split('\n')
  let offset = 0
  for (let i = 0; i < position.line && i < lines.length; i++) offset += lines[i].length + 1
  return offset + Math.min(position.character, (lines[position.line] ?? '').length)
}

function applyChange(text, change) {
  if (!change.range) return change.text
  const start = offsetAt(text, change.range.start)
  const end = offsetAt(text, change.range.end)
  return text.slice(0, start) + change.text + text.slice(end)
}

function wordAt(text, position) {
  const line = text.split('\n')[position.line] ?? ''
  let start = position.character
  let end = position.character
  while (start > 0 && /\w/.test(line[start - 1])) start -= 1
  while (end < line.length && /\w/.test(line[end])) end += 1
  return {
    word: line.slice(start, end),
    range: {
      start: { line: position.line, character: start },
      end: { line: position.line, character: end },
    },
  }
}

function occurrences(text, word) {
  if (!word) return []
  const ranges = []
  const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(pattern)) {
      ranges.push({
        start: { line: index, character: match.index },
        end: { line: index, character: match.index + word.length },
      })
    }
  })
  return ranges
}

function lineRange(line, text, token) {
  const character = text.indexOf(token)
  return {
    start: { line, character },
    end: { line, character: character + token.length },
  }
}

async function diagnosticsFor(uri, text) {
  const diagnostics = []
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    if (line.includes('CRASH')) process.exit(1)
    if (line.includes('ERROR')) {
      diagnostics.push({
        range: lineRange(index, line, 'ERROR'),
        severity: 1,
        source: 'fake',
        message: `fake error on line ${index + 1}`,
      })
    }
    if (line.includes('WARN')) {
      diagnostics.push({
        range: lineRange(index, line, 'WARN'),
        severity: 2,
        source: 'fake',
        message: `fake warning on line ${index + 1}`,
      })
    }
    const read = /READ (\S+)/.exec(line)
    if (read) {
      let outcome
      try {
        outcome = `read ok: ${readFileSync(read[1], 'utf8').split('\n')[0]}`
      } catch (err) {
        outcome = `read failed: ${err.code ?? 'error'}`
      }
      diagnostics.push({
        range: lineRange(index, line, 'READ'),
        severity: 3,
        source: 'fake',
        message: outcome,
      })
    }
    const config = /CONFIG (\S+)/.exec(line)
    if (config && clientConfiguration) {
      const [value] = await connection.sendRequest('workspace/configuration', {
        items: [{ scopeUri: uri, section: config[1] }],
      })
      diagnostics.push({
        range: lineRange(index, line, 'CONFIG'),
        severity: 3,
        source: 'fake',
        message: `config ${config[1]} = ${JSON.stringify(value)}`,
      })
    }
  }
  return diagnostics
}

async function publish(uri) {
  const text = documents.get(uri)
  if (text === undefined) return
  const diagnostics = await diagnosticsFor(uri, text)
  connection.sendNotification('textDocument/publishDiagnostics', { uri, diagnostics })
}

function formattingEdits(text, range) {
  const edits = []
  text.split('\n').forEach((line, index) => {
    if (range && (index < range.start.line || index > range.end.line)) return
    if (line.includes('FORMATME')) {
      edits.push({ range: lineRange(index, line, 'FORMATME'), newText: 'formatted' })
    }
  })
  return edits
}

connection.onRequest('initialize', async (params) => {
  seen('initialize', params)
  clientConfiguration = params.capabilities?.workspace?.configuration === true
  if (slowInit > 0) await new Promise((resolve) => setTimeout(resolve, slowInit))
  const capabilities = {
    textDocumentSync: { openClose: true, change: incremental ? 2 : 1, save: { includeText: false } },
  }
  if (caps.has('completion')) {
    capabilities.completionProvider = { triggerCharacters: ['.', '#'], resolveProvider: true }
  }
  if (caps.has('hover')) capabilities.hoverProvider = true
  if (caps.has('definition')) capabilities.definitionProvider = true
  if (caps.has('formatting')) capabilities.documentFormattingProvider = true
  if (caps.has('references')) capabilities.referencesProvider = true
  if (caps.has('rename')) capabilities.renameProvider = { prepareProvider: true }
  if (caps.has('signature')) {
    capabilities.signatureHelpProvider = { triggerCharacters: ['(', ','] }
  }
  if (caps.has('symbols')) capabilities.documentSymbolProvider = true
  if (caps.has('highlight')) capabilities.documentHighlightProvider = true
  if (caps.has('rangeFormatting')) capabilities.documentRangeFormattingProvider = true
  if (caps.has('codeAction')) capabilities.codeActionProvider = { codeActionKinds: ['quickfix'] }
  if (caps.has('semanticTokens')) {
    capabilities.semanticTokensProvider = {
      legend: { tokenTypes: ['keyword', 'function'], tokenModifiers: ['declaration'] },
      full: true,
    }
  }
  if (caps.has('inlayHints')) capabilities.inlayHintProvider = true
  return { capabilities, serverInfo: { name: serverName, version: '1.0.0' } }
})

connection.onNotification('initialized', (params) => seen('initialized', params))

connection.onNotification('textDocument/didOpen', (params) => {
  seen('textDocument/didOpen', params)
  documents.set(params.textDocument.uri, params.textDocument.text)
  void publish(params.textDocument.uri)
})

connection.onNotification('textDocument/didChange', (params) => {
  seen('textDocument/didChange', params)
  let text = documents.get(params.textDocument.uri) ?? ''
  for (const change of params.contentChanges) text = applyChange(text, change)
  documents.set(params.textDocument.uri, text)
  void publish(params.textDocument.uri)
})

connection.onNotification('textDocument/didSave', (params) => seen('textDocument/didSave', params))

connection.onNotification('textDocument/didClose', (params) => {
  seen('textDocument/didClose', params)
  documents.delete(params.textDocument.uri)
  connection.sendNotification('textDocument/publishDiagnostics', {
    uri: params.textDocument.uri,
    diagnostics: [],
  })
})

connection.onNotification('workspace/didChangeConfiguration', (params) => {
  seen('workspace/didChangeConfiguration', params)
  for (const uri of documents.keys()) void publish(uri)
})

connection.onRequest('textDocument/completion', (params) => {
  seen('textDocument/completion', params)
  const text = documents.get(params.textDocument.uri) ?? ''
  const { range } = wordAt(text, params.position)
  return {
    isIncomplete: false,
    items: [
      { label: 'fakeAlpha', kind: 3, detail: 'fake function', data: 'alpha' },
      {
        label: 'fakeEdit',
        kind: 6,
        textEdit: { range, newText: 'fakeEdited' },
        additionalTextEdits: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: 'imported by fake\n',
          },
        ],
        data: 'edit',
      },
      {
        label: 'fakeSnippet',
        kind: 15,
        insertTextFormat: 2,
        insertText: 'fakeCall(${1:argument})',
        data: 'snippet',
      },
    ],
  }
})

connection.onRequest('completionItem/resolve', (item) => {
  seen('completionItem/resolve', item)
  return { ...item, documentation: { kind: 'markdown', value: `resolved **${item.label}**` } }
})

connection.onRequest('textDocument/hover', (params) => {
  seen('textDocument/hover', params)
  const { word, range } = wordAt(documents.get(params.textDocument.uri) ?? '', params.position)
  if (!word) return null
  return { contents: { kind: 'markdown', value: `fake hover: **${word}**` }, range }
})

connection.onRequest('textDocument/definition', (params) => {
  seen('textDocument/definition', params)
  return {
    uri: params.textDocument.uri,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
  }
})

connection.onRequest('textDocument/formatting', (params) => {
  seen('textDocument/formatting', params)
  return formattingEdits(documents.get(params.textDocument.uri) ?? '')
})

connection.onRequest('textDocument/rangeFormatting', (params) => {
  seen('textDocument/rangeFormatting', params)
  return formattingEdits(documents.get(params.textDocument.uri) ?? '', params.range)
})

connection.onRequest('textDocument/references', (params) => {
  seen('textDocument/references', params)
  const text = documents.get(params.textDocument.uri) ?? ''
  return occurrences(text, wordAt(text, params.position).word).map((range) => ({
    uri: params.textDocument.uri,
    range,
  }))
})

connection.onRequest('textDocument/documentHighlight', (params) => {
  seen('textDocument/documentHighlight', params)
  const text = documents.get(params.textDocument.uri) ?? ''
  return occurrences(text, wordAt(text, params.position).word).map((range) => ({ range, kind: 1 }))
})

connection.onRequest('textDocument/prepareRename', (params) => {
  seen('textDocument/prepareRename', params)
  const { word, range } = wordAt(documents.get(params.textDocument.uri) ?? '', params.position)
  return word ? { range, placeholder: word } : null
})

connection.onRequest('textDocument/rename', (params) => {
  seen('textDocument/rename', params)
  const text = documents.get(params.textDocument.uri) ?? ''
  const { word } = wordAt(text, params.position)
  const changes = {
    [params.textDocument.uri]: occurrences(text, word).map((range) => ({
      range,
      newText: params.newName,
    })),
  }
  const sibling = /RENAME_ALSO (\S+)/.exec(text)
  if (sibling) {
    const other = new URL(sibling[1], params.textDocument.uri).href
    const otherText = documents.get(other) ?? readFileSync(fileURLToPath(other), 'utf8')
    changes[other] = occurrences(otherText, word).map((range) => ({
      range,
      newText: params.newName,
    }))
  }
  return { changes }
})

connection.onRequest('textDocument/signatureHelp', (params) => {
  seen('textDocument/signatureHelp', params)
  const text = documents.get(params.textDocument.uri) ?? ''
  const line = (text.split('\n')[params.position.line] ?? '').slice(0, params.position.character)
  const open = line.lastIndexOf('(')
  if (open < 0) return null
  return {
    signatures: [
      {
        label: 'fakeCall(first: string, second: number)',
        documentation: 'A fake signature',
        parameters: [{ label: 'first: string' }, { label: 'second: number' }],
      },
    ],
    activeSignature: 0,
    activeParameter: Math.min(1, line.slice(open).split(',').length - 1),
  }
})

connection.onRequest('textDocument/documentSymbol', (params) => {
  seen('textDocument/documentSymbol', params)
  const symbols = []
  ;(documents.get(params.textDocument.uri) ?? '').split('\n').forEach((line, index) => {
    const match = /^fn (\w+)/.exec(line)
    if (!match) return
    const range = { start: { line: index, character: 0 }, end: { line: index, character: line.length } }
    symbols.push({
      name: match[1],
      kind: 12,
      range,
      selectionRange: lineRange(index, line, match[1]),
    })
  })
  return symbols
})

connection.onRequest('textDocument/codeAction', (params) => {
  seen('textDocument/codeAction', params)
  return params.context.diagnostics
    .filter((diagnostic) => diagnostic.message.startsWith('fake error'))
    .map((diagnostic) => ({
      title: 'Replace ERROR with FIXED',
      kind: 'quickfix',
      diagnostics: [diagnostic],
      edit: {
        changes: { [params.textDocument.uri]: [{ range: diagnostic.range, newText: 'FIXED' }] },
      },
    }))
})

connection.onRequest('textDocument/semanticTokens/full', (params) => {
  seen('textDocument/semanticTokens/full', params)
  const data = []
  let previousLine = 0
  let previousStart = 0
  ;(documents.get(params.textDocument.uri) ?? '').split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/\b(fn|KEYWORD)\b/g)) {
      const deltaLine = index - previousLine
      const deltaStart = deltaLine === 0 ? match.index - previousStart : match.index
      data.push(deltaLine, deltaStart, match[0].length, 0, 0)
      previousLine = index
      previousStart = match.index
    }
  })
  return { data }
})

connection.onRequest('textDocument/inlayHint', (params) => {
  seen('textDocument/inlayHint', params)
  const hints = []
  ;(documents.get(params.textDocument.uri) ?? '').split('\n').forEach((line, index) => {
    const match = /\blet (\w+)/.exec(line)
    if (!match || index < params.range.start.line || index > params.range.end.line) return
    hints.push({
      position: { line: index, character: match.index + match[0].length },
      label: ': fake',
      kind: 1,
      paddingLeft: false,
    })
  })
  return hints
})

connection.onRequest('shutdown', () => {
  record({ method: 'shutdown' })
  return null
})

connection.onNotification('exit', () => {
  record({ method: 'exit' })
  process.exit(0)
})

connection.listen()
