import 'monaco-editor/features/register.all.js'
import * as monaco from 'monaco-editor/editor/editor.api.js'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import {
  cssDefaults,
  lessDefaults,
  scssDefaults,
} from 'monaco-editor/language/css/monaco.contribution.js'
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import {
  handlebarDefaults,
  htmlDefaults,
  razorDefaults,
} from 'monaco-editor/language/html/monaco.contribution.js'
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import { jsonDefaults } from 'monaco-editor/language/json/monaco.contribution.js'
import { BuiltinFeatures } from './builtinFeatures'
import { registerInlineAssist } from './inlineAssist'
import { SETTINGS_LANGUAGE_ID } from './language'
import { registerSettingsLanguage } from './settingsLanguage'

import.meta.glob('../../../node_modules/monaco-editor/esm/vs/languages/definitions/*/register.js', {
  eager: true,
})

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
      case SETTINGS_LANGUAGE_ID:
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      default:
        return new editorWorker()
    }
  },
}

export { monaco }

registerInlineAssist(monaco)
registerSettingsLanguage(monaco)

export const builtinFeatures = new BuiltinFeatures(() => ({
  json: jsonDefaults,
  css: cssDefaults,
  scss: scssDefaults,
  less: lessDefaults,
  html: htmlDefaults,
  handlebars: handlebarDefaults,
  razor: razorDefaults,
}))
