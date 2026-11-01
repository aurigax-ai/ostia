import {
  isRemotePath,
  type RemoteFileError,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import type { MutableRefObject } from 'react'
import { reportError } from '@/lib/app/errorReporting'
import { changedLines, minimalLineEdit } from '@/lib/files/diskReload'
import { saveFormatted } from '@/lib/files/editorSave'
import { trackSave } from '@/lib/files/pendingSaves'
import { checkRemoteText, type RemoteSaveOutcome, saveRemoteText } from '@/lib/files/remoteFileSync'
import { documentSaved } from '@/lib/lsp/client'
import type { monaco } from '@/lib/monaco/setup'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useEditorStatus } from '@/stores/files/editorStatusStore'
import {
  diskBase,
  diskVersions,
  isDirty,
  markSaved,
  pathOf,
  remoteVersions,
  savedVersions,
  setDiskBase,
  unchangedOnDisk,
} from './editorModels'

const RELOAD_HIGHLIGHT_MS = 2000

export type DiskBar =
  | { kind: 'changed'; disk: string; version?: string }
  | { kind: 'conflict'; disk: string }
  | { kind: 'deleted' }

export type ReloadFromDisk = (
  model: monaco.editor.ITextModel,
  text: string,
  version?: string,
) => void

interface EditorSaveParams {
  editor: monaco.editor.IStandaloneCodeEditor
  saveRef: MutableRefObject<(force?: boolean) => Promise<void>>
  setUnsavedPath: (path: string | null) => void
  setRemoteProblem: (problem: RemoteFileError | null) => void
  setDiskBar: (bar: DiskBar | null) => void
}

function saveFailed(err: unknown): false {
  reportError('rejection', err, 'editorSave')
  return false
}

export function createEditorSave({
  editor,
  saveRef,
  setUnsavedPath,
  setRemoteProblem,
  setDiskBar,
}: EditorSaveParams): (force?: boolean) => Promise<void> {
  const saveRemote = async (
    model: monaco.editor.ITextModel,
    fp: string,
    force: boolean,
  ): Promise<void> => {
    const key = model.uri.toString()
    const attempt: { version: number; outcome: RemoteSaveOutcome | null } = {
      version: model.getAlternativeVersionId(),
      outcome: null,
    }
    await saveFormatted({
      formatOnSave: useSettingsStore.getState().editor.formatOnSave,
      format: async () => editor.getAction('editor.action.formatDocument')?.run(),
      write: async () => {
        attempt.version = model.getAlternativeVersionId()
        attempt.outcome = await saveRemoteText(
          window.ostia.remoteFiles,
          fp,
          model.getValue(),
          remoteVersions.get(key) ?? null,
          force,
        )
        return attempt.outcome.kind === 'saved'
      },
    }).catch(saveFailed)
    const { outcome } = attempt
    if (outcome?.kind === 'saved') {
      remoteVersions.set(key, outcome.version)
      savedVersions.set(key, attempt.version)
      useEditorStatus.getState().setDirty(fp, isDirty(model))
      setUnsavedPath(null)
      setRemoteProblem(null)
      setDiskBar(null)
    } else if (outcome?.kind === 'conflict') {
      setDiskBar({ kind: 'conflict', disk: outcome.disk })
    } else if (outcome?.kind === 'deleted') {
      remoteVersions.set(key, null)
      setDiskBar({ kind: 'deleted' })
    } else {
      setUnsavedPath(fp)
    }
  }

  const saveModel = async (
    model: monaco.editor.ITextModel,
    fp: string,
    force: boolean,
  ): Promise<void> => {
    if (isRemotePath(fp)) {
      await saveRemote(model, fp, force)
      return
    }
    const key = model.uri.toString()
    if (!force && !(await unchangedOnDisk(key, fp))) {
      const res = await window.ostia.fs.read(fp)
      if (!res.ok && res.error !== 'missing') {
        setUnsavedPath(fp)
        return
      }
      if (res.ok && diskBase.has(key) && res.text !== diskBase.get(key)) {
        setDiskBar({ kind: 'conflict', disk: res.text })
        return
      }
    }
    let version = model.getAlternativeVersionId()
    let text = ''
    const ok = await saveFormatted({
      formatOnSave: useSettingsStore.getState().editor.formatOnSave,
      format: async () => editor.getAction('editor.action.formatDocument')?.run(),
      write: () => {
        version = model.getAlternativeVersionId()
        text = model.getValue()
        setDiskBase(key, text)
        return window.ostia.fs.write(fp, text)
      },
    }).catch(saveFailed)
    if (!ok) {
      setUnsavedPath(fp)
      return
    }
    const written = await window.ostia.fs.version(fp)
    if (written !== null && diskBase.get(key) === text) diskVersions.set(key, written)
    savedVersions.set(model.uri.toString(), version)
    documentSaved(model)
    useEditorStatus.getState().setDirty(fp, isDirty(model))
    setUnsavedPath(null)
    setDiskBar(null)
  }
  const save = (force = false): Promise<void> => {
    const model = editor.getModel()
    if (!model) return Promise.resolve()
    const fp = pathOf(model)
    return trackSave(fp, saveModel(model, fp, force))
  }
  saveRef.current = save
  return save
}

interface DiskCheckParams {
  editor: monaco.editor.IStandaloneCodeEditor
  reducedMotionRef: MutableRefObject<boolean>
  reloadRef: MutableRefObject<ReloadFromDisk>
  checkDiskRef: MutableRefObject<() => Promise<void>>
  diskBarRef: MutableRefObject<DiskBar | null>
  setDiskBar: (bar: DiskBar | null) => void
}

export function createDiskCheck({
  editor,
  reducedMotionRef,
  reloadRef,
  checkDiskRef,
  diskBarRef,
  setDiskBar,
}: DiskCheckParams): () => void {
  let highlight: { clear: () => void } | null = null
  let highlightTimer: ReturnType<typeof setTimeout> | undefined
  const showChanged = (lines: { start: number; end: number } | null): void => {
    highlight?.clear()
    clearTimeout(highlightTimer)
    if (!lines) return
    const className = reducedMotionRef.current
      ? 'editor-reload-highlight editor-reload-highlight-static'
      : 'editor-reload-highlight'
    highlight = editor.createDecorationsCollection([
      {
        range: {
          startLineNumber: lines.start,
          startColumn: 1,
          endLineNumber: lines.end,
          endColumn: 1,
        },
        options: { isWholeLine: true, className },
      },
    ])
    highlightTimer = setTimeout(() => {
      highlight?.clear()
      highlight = null
    }, RELOAD_HIGHLIGHT_MS)
  }

  const reloadFrom = (model: monaco.editor.ITextModel, text: string, version?: string): void => {
    const changed = changedLines(model.getValue(), text)
    const edit = minimalLineEdit(model.getValue(), text)
    if (edit) {
      const view = editor.saveViewState()
      editor.pushUndoStop()
      model.pushEditOperations([], [edit], () => null)
      editor.pushUndoStop()
      editor.restoreViewState(view)
    }
    setDiskBase(model.uri.toString(), text)
    if (version !== undefined) remoteVersions.set(model.uri.toString(), version)
    markSaved(model, pathOf(model))
    showChanged(changed)
  }
  reloadRef.current = reloadFrom

  let checking: Promise<void> | null = null
  let again = false
  const checkRemote = async (model: monaco.editor.ITextModel, fp: string): Promise<void> => {
    const key = model.uri.toString()
    if (!remoteVersions.has(key)) return
    const outcome = await checkRemoteText(
      window.ostia.remoteFiles,
      fp,
      remoteVersions.get(key) ?? null,
    )
    if (editor.getModel() !== model) return
    if (outcome.kind === 'deleted') {
      remoteVersions.set(key, null)
      setDiskBar({ kind: 'deleted' })
    } else if (outcome.kind === 'changed') {
      if (!isDirty(model)) {
        reloadFrom(model, outcome.disk, outcome.version)
        setDiskBar(null)
        return
      }
      const shown = diskBarRef.current
      if (shown?.kind === 'changed' && shown.version === outcome.version) return
      setDiskBar({ kind: 'changed', disk: outcome.disk, version: outcome.version })
    }
  }

  const checkDisk = async (): Promise<void> => {
    const model = editor.getModel()
    if (!model) return
    if (isRemotePath(pathOf(model))) {
      await checkRemote(model, pathOf(model))
      return
    }
    const key = model.uri.toString()
    const res = await window.ostia.fs.read(pathOf(model))
    if (editor.getModel() !== model) return
    if (!res.ok && res.error !== 'missing') return
    const onDisk = res.ok ? res.text : null
    if (onDisk === diskBase.get(key)) return
    if (onDisk === null) {
      setDiskBase(key, null)
      setDiskBar({ kind: 'deleted' })
      return
    }
    if (!isDirty(model)) {
      reloadFrom(model, onDisk)
      if (res.ok) diskVersions.set(key, res.version)
      setDiskBar(null)
      return
    }
    setDiskBar({ kind: 'changed', disk: onDisk })
  }
  checkDiskRef.current = () => {
    if (checking) {
      again = true
      return checking
    }
    checking = checkDisk().finally(() => {
      checking = null
      if (again) {
        again = false
        void checkDiskRef.current()
      }
    })
    return checking
  }
  return () => clearTimeout(highlightTimer)
}
