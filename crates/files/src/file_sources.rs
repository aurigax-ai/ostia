use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use ostia_base::host::Host;
use ostia_base::js::locale_compare;
use ostia_base::path_guard::resolve_safe;
use ostia_contract::files_api::{FsBinaryResult, FsEntry, FsKind, FsTextResult};
use serde_json::Value;

use crate::archives::{Archives, FileStat};
use crate::fs_binary::read_binary_confined;
use crate::fs_range::{FsRangeResult, read_range_confined};
use crate::fs_text::{read_text_confined, stamp_of, version_confined};

pub type Confine = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;
pub type Browsable = Arc<dyn Fn(&str) -> bool + Send + Sync>;
pub type Roots = Arc<dyn Fn() -> Vec<String> + Send + Sync>;
pub type BrowsableSource = Arc<dyn Fn() -> Browsable + Send + Sync>;

pub trait FileSource: Send + Sync {
    fn watchable(&self) -> bool;
    fn confine(&self, path: &str) -> Option<String>;
    fn list<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Vec<FsEntry>>;
    fn kind<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Option<FsKind>>;
    fn read_text<'a>(&'a self, path: &'a str, max: u64) -> BoxFuture<'a, FsTextResult>;
    fn read_binary<'a>(&'a self, path: &'a str, max: u64) -> BoxFuture<'a, FsBinaryResult>;
    fn read_range<'a>(
        &'a self,
        path: &'a str,
        start: i64,
        end: i64,
    ) -> BoxFuture<'a, Option<FsRangeResult>>;
    fn version<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Option<String>>;
    fn describe<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Option<FileStat>>;
}

pub trait VirtualSource: FileSource {
    fn handles(&self, path: &str) -> bool;
}

struct LocalSource {
    roots: Roots,
    confine: Confine,
    browsable: BrowsableSource,
    host: Host,
}

impl LocalSource {
    fn safe_path(&self, path: &str) -> Option<PathBuf> {
        (self.confine)(path).map(PathBuf::from)
    }

    async fn stat_of(&self, path: &str) -> Option<fs::Metadata> {
        let safe = self.safe_path(path)?;
        tokio::task::spawn_blocking(move || fs::metadata(safe).ok())
            .await
            .ok()
            .flatten()
    }
}

fn list_dir(dir: PathBuf, browsable: Browsable) -> Vec<FsEntry> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<FsEntry> = read
        .filter_map(|item| {
            let item = item.ok()?;
            let kind = item.file_type().ok()?;
            let name = item.file_name().to_string_lossy().into_owned();
            let archive = kind.is_file() && browsable(&name);
            Some(FsEntry {
                dir: !archive && kind.is_dir(),
                archive,
                name,
                link: None,
                encrypted: false,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| locale_compare(&a.name, &b.name))
    });
    entries
}

impl FileSource for LocalSource {
    fn watchable(&self) -> bool {
        true
    }

    fn confine(&self, path: &str) -> Option<String> {
        (self.confine)(path)
    }

    fn list<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Vec<FsEntry>> {
        async move {
            let roots = (self.roots)();
            let roots: Vec<&str> = roots.iter().map(String::as_str).collect();
            let Some(safe) = resolve_safe(path, &roots, &self.host) else {
                return Vec::new();
            };
            let browsable = (self.browsable)();
            tokio::task::spawn_blocking(move || list_dir(safe, browsable))
                .await
                .unwrap_or_default()
        }
        .boxed()
    }

    fn kind<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Option<FsKind>> {
        async move {
            let found = self.stat_of(path).await?;
            if found.is_file() {
                Some(FsKind::File)
            } else if found.is_dir() {
                Some(FsKind::Dir)
            } else {
                None
            }
        }
        .boxed()
    }

    fn read_text<'a>(&'a self, path: &'a str, max: u64) -> BoxFuture<'a, FsTextResult> {
        async move {
            let confine = self.confine.clone();
            let path = Value::String(path.to_owned());
            tokio::task::spawn_blocking(move || {
                read_text_confined(&path, |p| confine(p).map(PathBuf::from), max)
            })
            .await
            .unwrap_or(FsTextResult::Unreadable)
        }
        .boxed()
    }

    fn read_binary<'a>(&'a self, path: &'a str, max: u64) -> BoxFuture<'a, FsBinaryResult> {
        async move {
            let confine = self.confine.clone();
            let path = path.to_owned();
            tokio::task::spawn_blocking(move || {
                read_binary_confined(&path, |p| confine(p).map(PathBuf::from), max)
            })
            .await
            .unwrap_or(FsBinaryResult::Unreadable)
        }
        .boxed()
    }

    fn read_range<'a>(
        &'a self,
        path: &'a str,
        start: i64,
        end: i64,
    ) -> BoxFuture<'a, Option<FsRangeResult>> {
        async move {
            let confine = self.confine.clone();
            Some(read_range_confined(path, start, end, |p| confine(p).map(PathBuf::from)).await)
        }
        .boxed()
    }

    fn version<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Option<String>> {
        async move {
            let confine = self.confine.clone();
            let path = Value::String(path.to_owned());
            tokio::task::spawn_blocking(move || {
                version_confined(&path, |p| confine(p).map(PathBuf::from))
            })
            .await
            .ok()
            .flatten()
        }
        .boxed()
    }

    fn describe<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Option<FileStat>> {
        async move {
            let found = self.stat_of(path).await?;
            found.is_file().then(|| {
                let stamp = stamp_of(&found);
                FileStat {
                    size: stamp.size,
                    modified: stamp.mtime_ms,
                }
            })
        }
        .boxed()
    }
}

impl FileSource for Archives {
    fn watchable(&self) -> bool {
        false
    }

    fn confine(&self, path: &str) -> Option<String> {
        Archives::confine(self, path)
    }

    fn list<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Vec<FsEntry>> {
        Archives::list(self, path).boxed()
    }

    fn kind<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Option<FsKind>> {
        Archives::kind(self, path).boxed()
    }

    fn read_text<'a>(&'a self, path: &'a str, max: u64) -> BoxFuture<'a, FsTextResult> {
        Archives::read_text(self, path, max).boxed()
    }

    fn read_binary<'a>(&'a self, path: &'a str, max: u64) -> BoxFuture<'a, FsBinaryResult> {
        Archives::read_binary(self, path, max).boxed()
    }

    fn read_range<'a>(
        &'a self,
        _path: &'a str,
        _start: i64,
        _end: i64,
    ) -> BoxFuture<'a, Option<FsRangeResult>> {
        async { None }.boxed()
    }

    fn version<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Option<String>> {
        Archives::version(self, path).boxed()
    }

    fn describe<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Option<FileStat>> {
        Archives::describe(self, path).boxed()
    }
}

impl VirtualSource for Archives {
    fn handles(&self, path: &str) -> bool {
        Archives::handles(self, path)
    }
}

pub fn local_source(
    roots: Roots,
    confine: Confine,
    browsable: BrowsableSource,
    host: Host,
) -> Arc<dyn FileSource> {
    Arc::new(LocalSource {
        roots,
        confine,
        browsable,
        host,
    })
}

pub struct FileSources {
    local: Arc<dyn FileSource>,
    virtual_sources: Vec<Arc<dyn VirtualSource>>,
}

impl FileSources {
    pub fn new(local: Arc<dyn FileSource>, virtual_sources: Vec<Arc<dyn VirtualSource>>) -> Self {
        Self {
            local,
            virtual_sources,
        }
    }

    pub fn of(&self, path: &str) -> Arc<dyn FileSource> {
        self.virtual_sources
            .iter()
            .find(|source| source.handles(path))
            .map_or_else(|| self.local.clone(), |source| source.clone())
    }
}
