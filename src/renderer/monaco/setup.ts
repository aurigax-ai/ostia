import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { registerInlineAssist } from './inlineAssist'

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  },
}

monaco.editor.defineTheme('one-dark-vivid', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'd7dae0' },
    { token: 'comment', foreground: '636d83', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'd55fde' },
    { token: 'keyword.flow', foreground: 'd55fde' },
    { token: 'operator', foreground: '56b6c2' },
    { token: 'delimiter', foreground: 'abb2bf' },
    { token: 'string', foreground: '89ca78' },
    { token: 'string.escape', foreground: '56b6c2' },
    { token: 'string.key.json', foreground: 'ef596f' },
    { token: 'number', foreground: 'd19a66' },
    { token: 'regexp', foreground: '89ca78' },
    { token: 'type', foreground: 'e5c07b' },
    { token: 'type.identifier', foreground: 'e5c07b' },
    { token: 'identifier', foreground: 'ef596f' },
    { token: 'function', foreground: '61afef' },
    { token: 'variable', foreground: 'ef596f' },
    { token: 'variable.predefined', foreground: 'd19a66' },
    { token: 'constant', foreground: 'd19a66' },
    { token: 'tag', foreground: 'ef596f' },
    { token: 'attribute.name', foreground: 'd19a66' },
    { token: 'attribute.value', foreground: '89ca78' },
  ],
  colors: {
    'editor.background': '#282c34',
    'editor.foreground': '#d7dae0',
    'editorCursor.foreground': '#61afef',
    'editor.lineHighlightBackground': '#2f343e80',
    'editorLineNumber.foreground': '#4d5566',
    'editorLineNumber.activeForeground': '#9aa2b1',
    'editor.selectionBackground': '#3a415080',
    'editor.inactiveSelectionBackground': '#3a415055',
    'editorIndentGuide.background1': '#3a4150',
    'editorIndentGuide.activeBackground1': '#4d5566',
    'editorWidget.background': '#21252b',
    'editorWidget.border': '#181b20',
    'editorSuggestWidget.background': '#21252b',
    'editorSuggestWidget.selectedBackground': '#2f343e',
    'editorGutter.background': '#282c34',
    'editorWhitespace.foreground': '#3a4150',
    'scrollbarSlider.background': '#3a415088',
    'scrollbarSlider.hoverBackground': '#4d5566aa',
  },
})

monaco.editor.defineTheme('pine-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: '', foreground: '24292f' },
    { token: 'comment', foreground: '5a6270', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'a1349f' },
    { token: 'keyword.flow', foreground: 'a1349f' },
    { token: 'operator', foreground: '0b7285' },
    { token: 'delimiter', foreground: '4f5866' },
    { token: 'string', foreground: '1b7f3b' },
    { token: 'string.escape', foreground: '0b7285' },
    { token: 'string.key.json', foreground: 'c62828' },
    { token: 'number', foreground: '9a5300' },
    { token: 'regexp', foreground: '1b7f3b' },
    { token: 'type', foreground: '8a6100' },
    { token: 'type.identifier', foreground: '8a6100' },
    { token: 'identifier', foreground: 'c62828' },
    { token: 'function', foreground: '1f5fbf' },
    { token: 'variable', foreground: 'c62828' },
    { token: 'variable.predefined', foreground: '9a5300' },
    { token: 'constant', foreground: '9a5300' },
    { token: 'tag', foreground: 'c62828' },
    { token: 'attribute.name', foreground: '9a5300' },
    { token: 'attribute.value', foreground: '1b7f3b' },
  ],
  colors: {
    'editor.background': '#fbfcfd',
    'editor.foreground': '#24292f',
    'editorCursor.foreground': '#0b62c4',
    'editor.lineHighlightBackground': '#eceef280',
    'editorLineNumber.foreground': '#6b7280',
    'editorLineNumber.activeForeground': '#24292f',
    'editor.selectionBackground': '#0b62c433',
    'editor.inactiveSelectionBackground': '#0b62c422',
    'editorIndentGuide.background1': '#e0e3e8',
    'editorIndentGuide.activeBackground1': '#c5cad2',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#d5d9e0',
    'editorSuggestWidget.background': '#ffffff',
    'editorSuggestWidget.selectedBackground': '#eceef2',
    'editorGutter.background': '#fbfcfd',
    'editorWhitespace.foreground': '#d5d9e0',
    'scrollbarSlider.background': '#0000002a',
    'scrollbarSlider.hoverBackground': '#00000044',
  },
})

export function monacoThemeName(appearance: 'dark' | 'light'): string {
  return appearance === 'light' ? 'pine-light' : 'one-dark-vivid'
}

export { monaco }

registerInlineAssist(monaco)
