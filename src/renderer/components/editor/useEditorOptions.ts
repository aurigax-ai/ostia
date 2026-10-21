import { exceedsPad } from '@shared/artifacts/artifacts'
import { type MutableRefObject, useEffect } from 'react'
import type { monaco } from '@/lib/monaco/setup'
import type { EditorSettings } from '@/lib/settings/browserEditorSettings'
import { codeFontStack } from '@/lib/theme/uiFonts'
import type { SurfaceFont } from '@/stores/app/settingsModel'

export function behaviorOptions(
  s: EditorSettings,
): monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions {
  return {
    wordWrap: s.wordWrap,
    lineNumbers: s.lineNumbers,
    tabSize: s.tabSize,
    insertSpaces: s.insertSpaces,
    detectIndentation: false,
  }
}

interface EditorOptionsParams {
  editorRef: MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>
  editorSettings: EditorSettings
  pad: boolean
  padHint: string
  setPadFull: (full: boolean) => void
  font: SurfaceFont
}

export function useEditorOptions({
  editorRef,
  editorSettings,
  pad,
  padHint,
  setPadFull,
  font,
}: EditorOptionsParams): void {
  useEffect(() => {
    editorRef.current?.updateOptions(behaviorOptions(editorSettings))
  }, [editorRef, editorSettings])

  useEffect(() => {
    const editor = editorRef.current
    if (!pad || !editor) {
      setPadFull(false)
      return
    }
    setPadFull(exceedsPad(editor.getModel()?.getValue() ?? ''))
    editor.updateOptions({ placeholder: padHint })
    return () => editor.updateOptions({ placeholder: '' })
  }, [editorRef, pad, padHint, setPadFull])

  useEffect(() => {
    editorRef.current?.updateOptions({
      fontFamily: codeFontStack(font.family),
      fontSize: font.size,
      fontWeight: String(font.weight),
    })
  }, [editorRef, font.family, font.size, font.weight])
}
