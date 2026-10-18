import { useFlipped } from '@/lib/app/useFlipped'
import { isRemotePath } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { EditorAlerts } from './EditorAlerts'
import { EditorModes, type OptionViewer } from './EditorModes'
import { LanguageNotice, LargeFileNotice } from './LanguageNotice'
import { RemoteFileBar } from './RemoteFileBar'
import { NoticeAppearing } from './noticeAppearing'
import { useEditorView } from './useEditorView'

export function EditorView({
  workspaceId,
  paneId,
  filePath,
  optionViewer,
}: {
  workspaceId: string
  paneId: string
  filePath?: string
  optionViewer?: OptionViewer
}): JSX.Element {
  const {
    hostRef,
    blocked,
    large,
    remoteProblem,
    visible,
    markdown,
    preview,
    setPreview,
    previewText,
    previewSelectionRef,
    sendSelectionRef,
    selectionSend,
    running,
    runnable,
    overlayRef,
    setRunChoice,
    diskBar,
    setDiskBar,
    editorRef,
    pathRef,
    reloadRef,
    saveRef,
    waitedBy,
    padFull,
    unsavedPath,
    external,
  } = useEditorView({ workspaceId, paneId, filePath })
  const remote = isRemotePath(filePath)
  const fixedBarAppearing = useFlipped({
    bar: Boolean(filePath && (remote || (!blocked && large))),
  }).has('bar')

  return (
    <>
      <NoticeAppearing.Provider value={fixedBarAppearing}>
        {filePath && remote ? <RemoteFileBar filePath={filePath} problem={remoteProblem} /> : null}
        {filePath && !blocked && !remote && large ? <LargeFileNotice /> : null}
      </NoticeAppearing.Provider>
      {filePath && !blocked && !remote && !large ? (
        <LanguageNotice paneId={paneId} filePath={filePath} />
      ) : null}
      <div
        ref={hostRef}
        className="editor-host"
        style={blocked ? { display: 'none' } : undefined}
      />
      <EditorModes
        workspaceId={workspaceId}
        paneId={paneId}
        filePath={filePath}
        visible={visible}
        markdown={markdown}
        preview={preview}
        setPreview={setPreview}
        previewText={previewText}
        previewSelectionRef={previewSelectionRef}
        sendSelectionRef={sendSelectionRef}
        selectionSend={selectionSend}
        running={running}
        runnable={runnable}
        optionViewer={blocked ? undefined : optionViewer}
        overlayRef={overlayRef}
        setRunChoice={setRunChoice}
      />
      <EditorAlerts
        workspaceId={workspaceId}
        paneId={paneId}
        blocked={blocked}
        diskBar={diskBar}
        setDiskBar={setDiskBar}
        editorRef={editorRef}
        pathRef={pathRef}
        reloadRef={reloadRef}
        saveRef={saveRef}
        waitedBy={waitedBy}
        padFull={padFull}
        unsavedPath={unsavedPath}
        external={external}
      />
      {selectionSend.panel}
      {selectionSend.status}
    </>
  )
}
