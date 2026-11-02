use std::future::Future;
use std::path::Path;
use std::sync::Arc;

use ostia_base::node_path;
use serde_json::Value;

use crate::{FileOpError, FileOpResult};

pub trait FileOpsBackend: Send + Sync {
    fn create(
        &self,
        dir: &Value,
        name: &Value,
        kind: &Value,
    ) -> impl Future<Output = FileOpResult> + Send;
    fn rename(&self, path: &Value, name: &Value) -> impl Future<Output = FileOpResult> + Send;
    fn move_entries(&self, paths: &Value, dir: &Value)
    -> impl Future<Output = FileOpResult> + Send;
    fn copy(&self, paths: &Value, dir: &Value) -> impl Future<Output = FileOpResult> + Send;
    fn trash(&self, paths: &Value) -> impl Future<Output = FileOpResult> + Send;
    fn import_into(
        &self,
        paths: &Value,
        dir: &Value,
        move_entries: bool,
    ) -> impl Future<Output = FileOpResult> + Send;
    fn draggable(&self, path: &Value) -> impl Future<Output = Option<String>> + Send;
}

pub type WindowOfWorkspace = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;
pub type SandboxRefusal = Arc<dyn Fn(&str, &str) -> Option<String> + Send + Sync>;

pub struct FileGuardDeps<B> {
    pub file_ops: B,
    pub window_of_workspace: WindowOfWorkspace,
    pub sandbox_refusal: SandboxRefusal,
}

pub struct FileGuard<B> {
    deps: FileGuardDeps<B>,
}

pub fn guard_file_ops<B: FileOpsBackend>(deps: FileGuardDeps<B>) -> FileGuard<B> {
    FileGuard { deps }
}

fn refused(error: FileOpError) -> FileOpResult {
    FileOpResult::Err {
        error,
        paths: None,
        partial: None,
    }
}

fn as_list(paths: &Value) -> Vec<Value> {
    match paths {
        Value::Array(items) => items.clone(),
        other => vec![other.clone()],
    }
}

impl<B: FileOpsBackend> FileGuard<B> {
    fn refusal(
        &self,
        sender_id: &str,
        workspace_id: &Value,
        targets: &Value,
    ) -> Option<FileOpResult> {
        let Some(workspace_id) = workspace_id.as_str() else {
            return Some(refused(FileOpError::Outside));
        };
        if (self.deps.window_of_workspace)(workspace_id).as_deref() != Some(sender_id) {
            return Some(refused(FileOpError::Outside));
        }
        let mut paths = Vec::new();
        for target in as_list(targets) {
            let Some(text) = target.as_str().filter(|text| Path::new(text).is_absolute()) else {
                return Some(refused(FileOpError::Outside));
            };
            let resolved = node_path::normalize(Path::new(text));
            paths.push(resolved.to_string_lossy().into_owned());
        }
        paths
            .iter()
            .any(|path| (self.deps.sandbox_refusal)(workspace_id, path).is_some())
            .then(|| refused(FileOpError::Sandboxed))
    }

    pub async fn create(
        &self,
        sender_id: &str,
        workspace_id: &Value,
        dir: &Value,
        name: &Value,
        kind: &Value,
    ) -> FileOpResult {
        match self.refusal(sender_id, workspace_id, dir) {
            Some(result) => result,
            None => self.deps.file_ops.create(dir, name, kind).await,
        }
    }

    pub async fn rename(
        &self,
        sender_id: &str,
        workspace_id: &Value,
        path: &Value,
        name: &Value,
    ) -> FileOpResult {
        match self.refusal(sender_id, workspace_id, path) {
            Some(result) => result,
            None => self.deps.file_ops.rename(path, name).await,
        }
    }

    pub async fn move_entries(
        &self,
        sender_id: &str,
        workspace_id: &Value,
        paths: &Value,
        dir: &Value,
    ) -> FileOpResult {
        let mut targets = as_list(paths);
        targets.push(dir.clone());
        match self.refusal(sender_id, workspace_id, &Value::Array(targets)) {
            Some(result) => result,
            None => self.deps.file_ops.move_entries(paths, dir).await,
        }
    }

    pub async fn copy(
        &self,
        sender_id: &str,
        workspace_id: &Value,
        paths: &Value,
        dir: &Value,
    ) -> FileOpResult {
        match self.refusal(sender_id, workspace_id, dir) {
            Some(result) => result,
            None => self.deps.file_ops.copy(paths, dir).await,
        }
    }

    pub async fn trash(
        &self,
        sender_id: &str,
        workspace_id: &Value,
        paths: &Value,
    ) -> FileOpResult {
        match self.refusal(sender_id, workspace_id, paths) {
            Some(result) => result,
            None => self.deps.file_ops.trash(paths).await,
        }
    }

    pub async fn import_into(
        &self,
        sender_id: &str,
        workspace_id: &Value,
        paths: &Value,
        dir: &Value,
        move_entries: &Value,
    ) -> FileOpResult {
        match self.refusal(sender_id, workspace_id, dir) {
            Some(result) => result,
            None => {
                let move_entries = move_entries.as_bool() == Some(true);
                self.deps
                    .file_ops
                    .import_into(paths, dir, move_entries)
                    .await
            }
        }
    }

    pub async fn draggable(
        &self,
        sender_id: &str,
        workspace_id: &Value,
        path: &Value,
    ) -> Option<String> {
        match self.refusal(sender_id, workspace_id, path) {
            None => self.deps.file_ops.draggable(path).await,
            Some(_) => None,
        }
    }
}
