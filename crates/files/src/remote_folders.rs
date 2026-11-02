use std::sync::Arc;

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use ostia_base::js::utf16_len;
use ostia_base::random::random_bytes;
use ostia_contract::remote_folders::{
    REMOTE_FILE_MAX_BYTES, REMOTE_FOLDERS_PER_WORKSPACE, REMOTE_HOST_PATTERN,
    REMOTE_VERSION_PATTERN, REMOTE_WRITE_ANY, REMOTE_WRITE_NEW, RemoteFailure, RemoteFilesOp,
    RemoteFilesRequest, RemoteFolder, RemoteListResult, RemoteReadResult, RemoteStatResult,
    RemoteWriteResult, is_inside_root, normalize_remote_listing, normalize_remote_path,
    normalize_remote_read, normalize_remote_stat, normalize_remote_write, parse_remote_path,
    utf8_length,
};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};

pub const REMOTE_REQUEST_TIMEOUT_MS: u64 = 30_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteExtension {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteFolderConfirm {
    pub ext_id: String,
    pub workspace_id: String,
    pub ext_name: String,
    pub host: String,
    pub path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteRefusal {
    Sandboxed,
    Scratch,
}

impl RemoteRefusal {
    fn as_str(self) -> &'static str {
        match self {
            Self::Sandboxed => "sandboxed",
            Self::Scratch => "scratch",
        }
    }
}

#[derive(Clone)]
pub struct RemoteFoldersDeps {
    pub window_of_workspace: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    pub refusal: Arc<dyn Fn(&str) -> Option<RemoteRefusal> + Send + Sync>,
    pub confirm: Arc<dyn Fn(RemoteFolderConfirm) -> BoxFuture<'static, bool> + Send + Sync>,
    pub request: Arc<
        dyn Fn(&str, RemoteFilesRequest) -> BoxFuture<'static, Result<Value, String>> + Send + Sync,
    >,
    pub closed: Arc<dyn Fn(RemoteFolder) + Send + Sync>,
    pub publish: Arc<dyn Fn() + Send + Sync>,
    pub new_id: Option<Arc<dyn Fn() -> String + Send + Sync>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum OpenFolderResult {
    Opened {
        ok: bool,
        #[serde(rename = "folderId")]
        folder_id: String,
    },
    Refused {
        ok: bool,
        error: String,
        message: String,
    },
}

fn opened(folder_id: String) -> OpenFolderResult {
    OpenFolderResult::Opened {
        ok: true,
        folder_id,
    }
}

fn refused(error: &str, message: &str) -> OpenFolderResult {
    OpenFolderResult::Refused {
        ok: false,
        error: error.to_owned(),
        message: message.to_owned(),
    }
}

fn random_id() -> String {
    random_bytes::<6>()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn failed(error: &'static str) -> RemoteFailure {
    RemoteFailure::of(error)
}

struct Located {
    folder: RemoteFolder,
    path: String,
}

enum Opening {
    Done(OpenFolderResult),
    Confirming {
        approval: BoxFuture<'static, bool>,
        folder: RemoteFolder,
    },
}

#[derive(Clone)]
pub struct RemoteFolders {
    deps: RemoteFoldersDeps,
    folders: Arc<Mutex<Vec<RemoteFolder>>>,
}

impl RemoteFolders {
    pub fn new(deps: RemoteFoldersDeps) -> Self {
        Self {
            deps,
            folders: Arc::default(),
        }
    }

    fn snapshot(&self) -> Vec<RemoteFolder> {
        self.folders.lock().clone()
    }

    fn in_workspace(&self, workspace_id: &str) -> Vec<RemoteFolder> {
        self.snapshot()
            .into_iter()
            .filter(|folder| folder.workspace_id == workspace_id)
            .collect()
    }

    fn window_of(&self, workspace_id: &str) -> Option<String> {
        (self.deps.window_of_workspace)(workspace_id)
    }

    fn begin_open(&self, ext: &RemoteExtension, params: &Value) -> Opening {
        let workspace_id = params
            .get("workspaceId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if workspace_id.is_empty() || self.window_of(workspace_id).is_none() {
            return Opening::Done(refused(
                "unknown-workspace",
                "workspaceId is not an open workspace",
            ));
        }
        if let Some(restricted) = (self.deps.refusal)(workspace_id) {
            let name = restricted.as_str();
            return Opening::Done(refused(
                name,
                &format!("a {name} workspace has no remote folders"),
            ));
        }
        let Some(host) = params
            .get("host")
            .and_then(Value::as_str)
            .filter(|host| REMOTE_HOST_PATTERN.is_match(host))
        else {
            return Opening::Done(refused("invalid-params", "host must be a plain host name"));
        };
        let Some(root) = normalize_remote_path(params.get("path").unwrap_or(&Value::Null)) else {
            return Opening::Done(refused(
                "invalid-params",
                "path must be absolute, without ..",
            ));
        };
        let here = self.in_workspace(workspace_id);
        if let Some(existing) = here
            .iter()
            .find(|f| f.ext_id == ext.id && f.host == host && f.root == root)
        {
            return Opening::Done(opened(existing.id.clone()));
        }
        if here.len() >= REMOTE_FOLDERS_PER_WORKSPACE {
            return Opening::Done(refused(
                "too-many",
                &format!("a workspace holds {REMOTE_FOLDERS_PER_WORKSPACE} remote folders"),
            ));
        }
        let approval = (self.deps.confirm)(RemoteFolderConfirm {
            ext_id: ext.id.clone(),
            workspace_id: workspace_id.to_owned(),
            ext_name: ext.name.clone(),
            host: host.to_owned(),
            path: root.clone(),
        });
        Opening::Confirming {
            approval,
            folder: RemoteFolder {
                id: String::new(),
                workspace_id: workspace_id.to_owned(),
                ext_id: ext.id.clone(),
                ext_name: ext.name.clone(),
                host: host.to_owned(),
                root,
            },
        }
    }

    pub fn open(
        &self,
        ext: &RemoteExtension,
        params: &Value,
    ) -> BoxFuture<'static, OpenFolderResult> {
        match self.begin_open(ext, params) {
            Opening::Done(result) => std::future::ready(result).boxed(),
            Opening::Confirming { approval, folder } => {
                let this = self.clone();
                async move {
                    if !approval.await {
                        return refused("denied", "the human did not open the folder");
                    }
                    if this.window_of(&folder.workspace_id).is_none() {
                        return refused("unknown-workspace", "the workspace closed");
                    }
                    let id = this
                        .deps
                        .new_id
                        .as_ref()
                        .map_or_else(random_id, |make| make());
                    let folder = RemoteFolder { id, ..folder };
                    {
                        let mut folders = this.folders.lock();
                        match folders.iter().position(|f| f.id == folder.id) {
                            Some(at) => folders[at] = folder.clone(),
                            None => folders.push(folder.clone()),
                        }
                    }
                    (this.deps.publish)();
                    opened(folder.id)
                }
                .boxed()
            }
        }
    }

    pub fn owner_changed(&self, workspace_id: &str) {
        if !self.in_workspace(workspace_id).is_empty() {
            (self.deps.publish)();
        }
    }

    pub fn for_window(&self, window_id: &str) -> Vec<RemoteFolder> {
        self.snapshot()
            .into_iter()
            .filter(|f| self.window_of(&f.workspace_id).as_deref() == Some(window_id))
            .collect()
    }

    fn close_where(&self, matches: impl Fn(&RemoteFolder) -> bool, tell: bool) -> usize {
        let wanted: Vec<RemoteFolder> = self.snapshot().into_iter().filter(matches).collect();
        let gone: Vec<RemoteFolder> = {
            let mut folders = self.folders.lock();
            wanted
                .into_iter()
                .filter(|folder| {
                    folders
                        .iter()
                        .position(|f| f.id == folder.id)
                        .map(|at| folders.remove(at))
                        .is_some()
                })
                .collect()
        };
        let count = gone.len();
        if tell {
            for folder in gone {
                (self.deps.closed)(folder);
            }
        }
        if count > 0 {
            (self.deps.publish)();
        }
        count
    }

    pub fn close_by_extension(&self, ext_id: &str, folder_id: &str) -> bool {
        self.close_where(|f| f.id == folder_id && f.ext_id == ext_id, false) > 0
    }

    pub fn close_by_window(&self, window_id: &str, folder_id: &str) -> bool {
        self.close_where(
            |f| f.id == folder_id && self.window_of(&f.workspace_id).as_deref() == Some(window_id),
            true,
        ) > 0
    }

    pub fn workspace_closed(&self, workspace_id: &str) {
        self.close_where(|f| f.workspace_id == workspace_id, true);
    }

    pub fn extension_gone(&self, ext_id: &str) {
        self.close_where(|f| f.ext_id == ext_id, false);
    }

    fn locate(&self, window_id: &str, raw: &Value) -> Result<Located, RemoteFailure> {
        let parsed = parse_remote_path(raw).ok_or_else(|| failed("invalid-path"))?;
        let folder = self
            .snapshot()
            .into_iter()
            .find(|f| f.id == parsed.folder_id)
            .filter(|f| self.window_of(&f.workspace_id).as_deref() == Some(window_id))
            .ok_or_else(|| failed("unknown-folder"))?;
        if !is_inside_root(&folder.root, &parsed.path) {
            return Err(failed("outside"));
        }
        Ok(Located {
            folder,
            path: parsed.path,
        })
    }

    async fn ask(
        &self,
        at: Located,
        op: RemoteFilesOp,
        content: Option<String>,
        base_version: Option<String>,
    ) -> Value {
        let request = RemoteFilesRequest {
            op,
            folder_id: at.folder.id,
            root: at.folder.root,
            path: at.path,
            content,
            base_version,
        };
        match (self.deps.request)(&at.folder.ext_id, request).await {
            Ok(answer) => answer,
            Err(_) => json!({"ok": false, "error": "unavailable"}),
        }
    }

    pub async fn list(&self, window_id: &str, raw: &Value) -> RemoteListResult {
        match self.locate(window_id, raw) {
            Err(failure) => RemoteListResult::Failure(failure),
            Ok(at) => {
                normalize_remote_listing(&self.ask(at, RemoteFilesOp::List, None, None).await)
            }
        }
    }

    pub async fn stat(&self, window_id: &str, raw: &Value) -> RemoteStatResult {
        match self.locate(window_id, raw) {
            Err(failure) => RemoteStatResult::Failure(failure),
            Ok(at) => normalize_remote_stat(&self.ask(at, RemoteFilesOp::Stat, None, None).await),
        }
    }

    pub async fn read(&self, window_id: &str, raw: &Value) -> RemoteReadResult {
        match self.locate(window_id, raw) {
            Err(failure) => RemoteReadResult::Failure(failure),
            Ok(at) => normalize_remote_read(&self.ask(at, RemoteFilesOp::Read, None, None).await),
        }
    }

    pub async fn write(
        &self,
        window_id: &str,
        raw: &Value,
        content: &Value,
        base_version: &Value,
    ) -> RemoteWriteResult {
        let at = match self.locate(window_id, raw) {
            Ok(at) => at,
            Err(failure) => return RemoteWriteResult::Failure(failure),
        };
        let Some(content) = content.as_str().filter(|text| !text.contains('\0')) else {
            return RemoteWriteResult::Failure(failed("binary"));
        };
        if utf16_len(content) > REMOTE_FILE_MAX_BYTES
            || utf8_length(content) > REMOTE_FILE_MAX_BYTES
        {
            return RemoteWriteResult::Failure(failed("too-large"));
        }
        let version = base_version.as_str().filter(|version| {
            *version == REMOTE_WRITE_ANY
                || *version == REMOTE_WRITE_NEW
                || REMOTE_VERSION_PATTERN.is_match(version)
        });
        let Some(version) = version else {
            return RemoteWriteResult::Failure(failed("failed"));
        };
        let answer = self
            .ask(
                at,
                RemoteFilesOp::Write,
                Some(content.to_owned()),
                Some(version.to_owned()),
            )
            .await;
        normalize_remote_write(&answer)
    }
}
