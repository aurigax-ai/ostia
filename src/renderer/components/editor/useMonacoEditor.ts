import type { RemoteFileError } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { exceedsPad, PAD_SAVE_DELAY_MS } from '@shared/artifacts/artifacts'
import { debounce } from 'es-toolkit'
import { type MutableRefObject, type RefObject, useEffect } from 'react'
import { attachWheelZoom } from '@/lib/app/wheelZoom'
import { findStep, matchChord, runAppChord } from '@/lib/keyboard/chords'
import { fileFeatureOptions } from '@/lib/monaco/largeFile'
import { ensureMonacoTheme } from '@/lib/monaco/monacoScheme'
import { EDITOR_SCROLLBAR } from '@/lib/monaco/scrollbarOptions'
import { monaco } from '@/lib/monaco/setup'
import { AUTO_SAVE_DELAY_MS, type EditorSettings } from '@/lib/settings/browserEditorSettings'
import { codeFontStack } from '@/lib/theme/uiFonts'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'
import {
  createDiskCheck,
  createEditorSave,
  type DiskBar,
  type ReloadFromDisk,
} from './editorDiskSync'
import { isDirty } from './editorModels'
import { behaviorOptions } from './useEditorOptions'

function findAction(by: 1 | -1 | null): string {
  if (by === null) return 'actions.find'
  return by > 0 ? 'editor.action.nextMatchFindAction' : 'editor.action.previousMatchFindAction'
}

interface MonacoEditorParams {
  hostRef: RefObject<HTMLDivElement>
  editorRef: MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>
  reducedMotionRef: MutableRefObject<boolean>
  setLiveEditor: (editor: monaco.editor.IStandaloneCodeEditor | null) => void
  saveRef: MutableRefObject<(force?: boolean) => Promise<void>>
  reloadRef: MutableRefObject<ReloadFromDisk>
  checkDiskRef: MutableRefObject<() => Promise<void>>
  diskBarRef: MutableRefObject<DiskBar | null>
  setUnsavedPath: (path: string | null) => void
  setRemoteProblem: (problem: RemoteFileError | null) => void
  setDiskBar: (bar: DiskBar | null) => void
  padRef: MutableRefObject<boolean>
  setPadFull: (full: boolean) => void
  visibleRef: MutableRefObject<boolean>
  releaseShownRef: MutableRefObject<() => void>
}

export function useMonacoEditor({
  hostRef,
  editorRef,
  reducedMotionRef,
  setLiveEditor,
  saveRef,
  reloadRef,
  checkDiskRef,
  diskBarRef,
  setUnsavedPath,
  setRemoteProblem,
  setDiskBar,
  padRef,
  setPadFull,
  visibleRef,
  releaseShownRef,
}: MonacoEditorParams): void {
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const initial = useSettingsStore.getState().appearance.editor
    ensureMonacoTheme()
    const editor = monaco.editor.create(host, {
      automaticLayout: false,
      fontFamily: codeFontStack(initial.family),
      fontSize: initial.size,
      fontWeight: String(initial.weight),
      fontLigatures: true,
      minimap: { enabled: false },
      scrollbar: EDITOR_SCROLLBAR,
      scrollBeyondLastLine: false,
      smoothScrolling: false,
      ...behaviorOptions(useSettingsStore.getState().editor),
      renderWhitespace: 'selection',
      padding: { top: 8 },
      ...fileFeatureOptions(false),
    })
    editorRef.current = editor
    setLiveEditor(editor)
    const appChordKeys = editor.onKeyDown((e) => {
      const chord = matchChord(e.browserEvent, isMac)
      const findBy = findStep(chord)
      if (chord === 'find' || findBy !== null) {
        e.preventDefault()
        e.stopPropagation()
        void editor.getAction(findAction(findBy))?.run()
        return
      }
      if (runAppChord(e.browserEvent, isMac)) e.stopPropagation()
    })

    const save = createEditorSave({ editor, saveRef, setUnsavedPath, setRemoteProblem, setDiskBar })
    const stopHighlight = createDiskCheck({
      editor,
      reducedMotionRef,
      reloadRef,
      checkDiskRef,
      diskBarRef,
      setDiskBar,
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save())

    const saveIfDirty = (mode: EditorSettings['autoSave']): void => {
      const model = editor.getModel()
      if (useSettingsStore.getState().editor.autoSave !== mode) return
      if (diskBarRef.current) return
      if (model && isDirty(model)) void save()
    }
    const autoSave = debounce(() => saveIfDirty('afterDelay'), AUTO_SAVE_DELAY_MS)
    const padSave = debounce(() => {
      const model = editor.getModel()
      if (padRef.current && !diskBarRef.current && model && isDirty(model)) void save()
    }, PAD_SAVE_DELAY_MS)
    const measurePad = (): void =>
      setPadFull(padRef.current && exceedsPad(editor.getModel()?.getValue() ?? ''))
    const contentSub = editor.onDidChangeModelContent(() => {
      if (useSettingsStore.getState().editor.autoSave === 'afterDelay') autoSave()
      if (!padRef.current) return
      padSave()
      measurePad()
    })
    const modelSub = editor.onDidChangeModel(measurePad)
    const blurSub = editor.onDidBlurEditorText(() => saveIfDirty('onFocusChange'))

    const detachWheelZoom = attachWheelZoom(host, 'editor', isMac)
    const resize = new ResizeObserver(() => {
      if (visibleRef.current) editor.layout()
    })
    resize.observe(host)

    return () => {
      resize.disconnect()
      stopHighlight()
      autoSave.cancel()
      padSave.cancel()
      appChordKeys.dispose()
      contentSub.dispose()
      modelSub.dispose()
      blurSub.dispose()
      detachWheelZoom()
      editor.dispose()
      releaseShownRef.current()
      releaseShownRef.current = () => {}
      editorRef.current = null
      setLiveEditor(null)
    }
  }, [
    hostRef,
    editorRef,
    reducedMotionRef,
    setLiveEditor,
    saveRef,
    reloadRef,
    checkDiskRef,
    diskBarRef,
    setUnsavedPath,
    setRemoteProblem,
    setDiskBar,
    padRef,
    setPadFull,
    visibleRef,
    releaseShownRef,
  ])
}
