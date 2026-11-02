use std::fs::Metadata;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use ostia_contract::archive_paths::{is_archive_path, parse_archive_path};
use ostia_contract::file_browse::{BROWSE_LIMITS, BrowseLimits};
use ostia_contract::files_api::{
    ArchiveEntryProblem, FsBinaryResult, FsEntry, FsKind, FsTextResult,
};
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use crate::archive_file::{EntryProblem, EntryRead, open_regular};
use crate::archive_tree::{ArchiveTree, EntryRef, build_tree};
use crate::browse_providers::{BrowseKind, BrowseProviders, BrowseTarget, ProviderListing};

const CACHED_ARCHIVES: usize = 16;
const TEXT_SNIFF_BYTES: usize = 8192;

type TreeFuture = Shared<BoxFuture<'static, Option<Arc<ArchiveTree>>>>;

struct Cached {
    archive: String,
    key: String,
    modified: f64,
    cancel: CancellationToken,
    settled: Arc<AtomicBool>,
    tree: TreeFuture,
}

impl Cached {
    fn abort_unsettled(&self) {
        if !self.settled.load(Ordering::SeqCst) {
            self.cancel.cancel();
        }
    }
}

struct Located {
    archive: String,
    entry: String,
    key: String,
    modified: f64,
    kind: BrowseKind,
    tree: Arc<ArchiveTree>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FileStat {
    pub size: u64,
    pub modified: f64,
}

enum Refusal {
    TooLarge(u64),
    Unreadable,
    Archive(ArchiveEntryProblem),
}

impl Refusal {
    fn of(problem: EntryProblem, size: Option<u64>) -> Self {
        match problem {
            EntryProblem::TooLarge => Self::TooLarge(size.unwrap_or(0)),
            EntryProblem::Unreadable => Self::Unreadable,
            EntryProblem::Encrypted => Self::Archive(ArchiveEntryProblem::Encrypted),
            EntryProblem::Link => Self::Archive(ArchiveEntryProblem::Link),
            EntryProblem::UnzipLimit => Self::Archive(ArchiveEntryProblem::UnzipLimit),
            EntryProblem::Gone => Self::Archive(ArchiveEntryProblem::Gone),
        }
    }
}

impl From<Refusal> for FsBinaryResult {
    fn from(refusal: Refusal) -> Self {
        match refusal {
            Refusal::TooLarge(size) => Self::TooLarge { size },
            Refusal::Unreadable => Self::Unreadable,
            Refusal::Archive(reason) => Self::Archive { reason },
        }
    }
}

impl From<Refusal> for FsTextResult {
    fn from(refusal: Refusal) -> Self {
        match refusal {
            Refusal::TooLarge(size) => Self::TooLarge { size },
            Refusal::Unreadable => Self::Unreadable,
            Refusal::Archive(reason) => Self::Archive { reason },
        }
    }
}

fn version_key(stat: &Metadata, kind: &BrowseKind) -> String {
    format!(
        "{}:{}:{}:{}.{:09}:{}:{}",
        stat.dev(),
        stat.ino(),
        stat.size(),
        stat.mtime(),
        stat.mtime_nsec(),
        kind.ext_id,
        kind.kind
    )
}

fn modified_ms(stat: &Metadata) -> f64 {
    stat.mtime() as f64 * 1000.0 + stat.mtime_nsec() as f64 / 1_000_000.0
}

pub type ConfineArchive = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

#[derive(Clone)]
pub struct Archives {
    confine_archive: ConfineArchive,
    providers: Arc<dyn BrowseProviders>,
    limits: BrowseLimits,
    cache: Arc<Mutex<Vec<Cached>>>,
}

impl Archives {
    pub fn new(
        confine_archive: ConfineArchive,
        providers: Arc<dyn BrowseProviders>,
        limits: BrowseLimits,
    ) -> Self {
        Self {
            confine_archive,
            providers,
            limits,
            cache: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn with_default_limits(
        confine_archive: ConfineArchive,
        providers: Arc<dyn BrowseProviders>,
    ) -> Self {
        Self::new(confine_archive, providers, BROWSE_LIMITS)
    }

    pub fn drop_cache(&self) {
        let mut cache = self.cache.lock();
        for cached in cache.iter() {
            cached.abort_unsettled();
        }
        cache.clear();
    }

    fn tree_for(
        &self,
        archive: &str,
        key: &str,
        stat: &Metadata,
        target: BrowseTarget,
    ) -> (TreeFuture, f64) {
        let mut cache = self.cache.lock();
        if let Some(cached) = cache
            .iter()
            .find(|cached| cached.archive == archive && cached.key == key)
        {
            return (cached.tree.clone(), cached.modified);
        }
        if let Some(position) = cache.iter().position(|cached| cached.archive == archive) {
            cache.remove(position).abort_unsettled();
        }
        let cancel = CancellationToken::new();
        let settled = Arc::new(AtomicBool::new(false));
        let listing = self.providers.list(target, self.limits, cancel.clone());
        let limits = self.limits;
        let done = settled.clone();
        let handle = tokio::spawn(async move {
            let tree = match listing.await {
                ProviderListing::Listed { entries, cut } => {
                    Some(Arc::new(build_tree(&entries, &limits, cut)))
                }
                ProviderListing::Failed { .. } => None,
            };
            done.store(true, Ordering::SeqCst);
            tree
        });
        let tree: TreeFuture = async move { handle.await.ok().flatten() }.boxed().shared();
        let modified = modified_ms(stat);
        cache.push(Cached {
            archive: archive.to_owned(),
            key: key.to_owned(),
            modified,
            cancel,
            settled,
            tree: tree.clone(),
        });
        while cache.len() > CACHED_ARCHIVES {
            cache.remove(0).abort_unsettled();
        }
        (tree, modified)
    }

    async fn locate(&self, path: &str) -> Option<Located> {
        let parsed = parse_archive_path(path)?;
        let archive = (self.confine_archive)(&parsed.archive)?;
        let kind = self.providers.kind_for(&archive)?;
        let opened = open_regular(Path::new(&archive))?;
        let key = version_key(&opened.stat, &kind);
        let target = BrowseTarget {
            ext_id: kind.ext_id.clone(),
            kind: kind.kind.clone(),
            size: opened.stat.size(),
            file: Arc::new(opened.file),
        };
        let (tree, modified) = self.tree_for(&archive, &key, &opened.stat, target);
        let tree = tree.await?;
        Some(Located {
            archive,
            entry: parsed.entry,
            key,
            modified,
            kind,
            tree,
        })
    }

    pub fn handles(&self, path: &str) -> bool {
        is_archive_path(Some(path))
    }

    pub fn confine(&self, path: &str) -> Option<String> {
        let parsed = parse_archive_path(path)?;
        (self.confine_archive)(&parsed.archive).map(|_| path.to_owned())
    }

    pub async fn list(&self, path: &str) -> Vec<FsEntry> {
        match self.locate(path).await {
            Some(found) => found
                .tree
                .dirs
                .get(&found.entry)
                .cloned()
                .unwrap_or_default(),
            None => Vec::new(),
        }
    }

    pub async fn kind(&self, path: &str) -> Option<FsKind> {
        let found = self.locate(path).await?;
        if found.tree.dirs.contains_key(&found.entry) {
            Some(FsKind::Dir)
        } else if found.tree.files.contains_key(&found.entry) {
            Some(FsKind::File)
        } else {
            None
        }
    }

    pub async fn version(&self, path: &str) -> Option<String> {
        let found = self.locate(path).await?;
        found
            .tree
            .files
            .contains_key(&found.entry)
            .then(|| format!("archive:{}", found.key))
    }

    pub async fn describe(&self, path: &str) -> Option<FileStat> {
        let found = self.locate(path).await?;
        let entry = found.tree.files.get(&found.entry)?;
        Some(FileStat {
            size: entry.size,
            modified: found.modified,
        })
    }

    pub async fn read(&self, path: &str, max: u64) -> EntryRead {
        let gone = EntryRead::Failed {
            problem: EntryProblem::Gone,
            size: None,
        };
        let Some(found) = self.locate(path).await else {
            return gone;
        };
        let Some(entry) = found.tree.files.get(&found.entry) else {
            return gone;
        };
        if let Some(problem) = refusal_before_read(entry, max) {
            return problem;
        }
        let Some(opened) = open_regular(Path::new(&found.archive)) else {
            return gone;
        };
        if version_key(&opened.stat, &found.kind) != found.key {
            return gone;
        }
        let target = BrowseTarget {
            ext_id: found.kind.ext_id.clone(),
            kind: found.kind.kind.clone(),
            size: opened.stat.size(),
            file: Arc::new(opened.file),
        };
        let result = self
            .providers
            .read(
                target,
                entry.index,
                max,
                self.limits,
                CancellationToken::new(),
            )
            .await;
        match result {
            EntryRead::Failed {
                problem: EntryProblem::TooLarge,
                ..
            } => EntryRead::Failed {
                problem: EntryProblem::TooLarge,
                size: Some(entry.size),
            },
            other => other,
        }
    }

    pub async fn read_binary(&self, path: &str, max: u64) -> FsBinaryResult {
        match self.read(path, max).await {
            EntryRead::Ok { data } => FsBinaryResult::Ok { data },
            EntryRead::Failed { problem, size } => Refusal::of(problem, size).into(),
        }
    }

    pub async fn read_text(&self, path: &str, max: u64) -> FsTextResult {
        match self.read(path, max).await {
            EntryRead::Failed { problem, size } => Refusal::of(problem, size).into(),
            EntryRead::Ok { data } => {
                if data[..data.len().min(TEXT_SNIFF_BYTES)].contains(&0) {
                    return FsTextResult::Binary;
                }
                FsTextResult::Ok {
                    text: String::from_utf8_lossy(&data).into_owned(),
                    version: self.version(path).await.unwrap_or_default(),
                }
            }
        }
    }
}

fn refusal_before_read(entry: &EntryRef, max: u64) -> Option<EntryRead> {
    let failed = |problem, size| Some(EntryRead::Failed { problem, size });
    if entry.encrypted {
        failed(EntryProblem::Encrypted, None)
    } else if entry.link.is_some() {
        failed(EntryProblem::Link, None)
    } else if entry.size > max {
        failed(EntryProblem::TooLarge, Some(entry.size))
    } else {
        None
    }
}
