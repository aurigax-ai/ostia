import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

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

export { monaco }
