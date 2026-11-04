use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use ostia_base::host::Host;
use ostia_base::js::{is_js_space, js_trim, utf16_len};
use ostia_base::node_path;
use ostia_base::path_guard::resolve_safe;
use parking_lot::Mutex;
use serde_json::Value;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::fs_text::stamp_of;
use crate::fuzzy_paths::fuzzy_match;
use crate::ripgrep::{
    FileList, MATCH_LIMIT, RgFailure, RgFailureCode, TextQuery, TextResults, list_files,
    search_text,
};
use crate::search::FileMatches;

pub const QUERY_MAX: usize = 1000;
pub const LINE_LIMIT: usize = 30;
const NAME_LIMIT: usize = 50;
const PDF_LIMIT: usize = 50;
const FILE_LIST_TTL: Duration = Duration::from_millis(10_000);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchRequest {
    pub root: String,
    pub text: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub include_ignored: bool,
    pub names_only: bool,
    pub lines_only: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchNameHit {
    pub path: String,
    pub dir: bool,
    pub positions: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SearchPdf {
    pub path: String,
    pub size: u64,
    pub mtime_ms: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SearchResults {
    pub root: String,
    pub names: Vec<SearchNameHit>,
    pub files: Vec<FileMatches>,
    pub pdfs: Vec<SearchPdf>,
    pub matches: usize,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchError {
    OutsideRoots,
    InvalidPattern,
    RgMissing,
    Failed,
    Cancelled,
}

impl SearchError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OutsideRoots => "outside-roots",
            Self::InvalidPattern => "invalid-pattern",
            Self::RgMissing => "rg-missing",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum SearchOutcome {
    Ok(SearchResults),
    Failed { error: SearchError, message: String },
}

impl SearchOutcome {
    fn failed(error: SearchError, message: &str) -> Self {
        Self::Failed {
            error,
            message: message.to_owned(),
        }
    }
}

impl From<RgFailure> for SearchOutcome {
    fn from(failure: RgFailure) -> Self {
        let error = match failure.error {
            RgFailureCode::RgMissing => SearchError::RgMissing,
            RgFailureCode::InvalidPattern => SearchError::InvalidPattern,
            RgFailureCode::Failed => SearchError::Failed,
            RgFailureCode::Cancelled => SearchError::Cancelled,
        };
        Self::Failed {
            error,
            message: failure.message,
        }
    }
}

pub fn parse_search_request(raw: &Value) -> Option<SearchRequest> {
    let record = raw.as_object()?;
    let root = record
        .get("root")?
        .as_str()
        .filter(|root| !root.is_empty())?;
    let text = record.get("text")?.as_str()?;
    if js_trim(text).is_empty() || utf16_len(text) > QUERY_MAX {
        return None;
    }
    let flag = |name: &str| record.get(name) == Some(&Value::Bool(true));
    let names_only = flag("namesOnly");
    Some(SearchRequest {
        root: root.to_owned(),
        text: text.to_owned(),
        regex: flag("regex"),
        case_sensitive: flag("caseSensitive"),
        whole_word: flag("wholeWord"),
        include_ignored: flag("includeIgnored"),
        names_only,
        lines_only: flag("linesOnly") && !names_only,
    })
}

pub fn folder_paths(files: &[String]) -> Vec<String> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut folders = Vec::new();
    for file in files {
        let mut from = 0;
        while let Some(found) = file[from..].find('/') {
            let slash = from + found;
            if slash == 0 {
                break;
            }
            if seen.insert(&file[..slash]) {
                folders.push(file[..slash].to_owned());
            }
            from = slash + 1;
        }
    }
    folders
}

pub fn name_hits(
    text: &str,
    files: &[String],
    limit: usize,
    files_only: bool,
) -> Vec<SearchNameHit> {
    let trimmed_end = text.trim_end_matches(is_js_space);
    let folders_only = !files_only && trimmed_end.ends_with('/');
    let query = if folders_only {
        trimmed_end.trim_end_matches('/')
    } else {
        text
    };
    if js_trim(query).is_empty() {
        return Vec::new();
    }
    let folders = if files_only {
        Vec::new()
    } else {
        folder_paths(files)
    };
    let plain: &[String] = if folders_only { &[] } else { files };
    let candidates = folders
        .iter()
        .map(|path| (path, true))
        .chain(plain.iter().map(|path| (path, false)));
    let mut hits: Vec<(SearchNameHit, f64)> = Vec::new();
    for (path, dir) in candidates {
        if let Some(hit) = fuzzy_match(query, path) {
            hits.push((
                SearchNameHit {
                    path: path.clone(),
                    dir,
                    positions: hit.positions,
                },
                hit.score,
            ));
        }
    }
    hits.sort_by(|(a, a_score), (b, b_score)| {
        b_score
            .partial_cmp(a_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| utf16_len(&a.path).cmp(&utf16_len(&b.path)))
    });
    hits.into_iter().take(limit).map(|(hit, _)| hit).collect()
}

fn pdf_files(root: &Path, files: &[String], limit: usize) -> Vec<SearchPdf> {
    let mut pdfs = Vec::new();
    for path in files {
        if pdfs.len() >= limit {
            break;
        }
        if !path.to_lowercase().ends_with(".pdf") {
            continue;
        }
        if let Ok(stat) = fs::metadata(node_path::join(root, path))
            && stat.is_file()
        {
            pdfs.push(SearchPdf {
                path: path.clone(),
                size: stat.len(),
                mtime_ms: stamp_of(&stat).mtime_ms,
            });
        }
    }
    pdfs
}

type RgResult<T> = Result<T, RgFailure>;
type SharedList = Shared<BoxFuture<'static, RgResult<FileList>>>;

struct CachedList {
    id: u64,
    at: Instant,
    list: SharedList,
}

#[derive(Default)]
struct State {
    next_id: u64,
    lists: HashMap<String, CachedList>,
    running: HashMap<String, (u64, CancellationToken)>,
}

struct Inner {
    bin: PathBuf,
    roots: Vec<String>,
    host: Host,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct WorkspaceSearch {
    inner: Arc<Inner>,
}

struct SlotGuard {
    inner: Arc<Inner>,
    slot: String,
    id: u64,
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        let mut state = self.inner.state.lock();
        if state.running.get(&self.slot).map(|(id, _)| *id) == Some(self.id)
            && let Some((_, token)) = state.running.remove(&self.slot)
        {
            token.cancel();
        }
    }
}

fn failure_of_join(error: &tokio::task::JoinError) -> RgFailure {
    RgFailure {
        error: RgFailureCode::Failed,
        message: error.to_string(),
    }
}

async fn joined<T>(handle: JoinHandle<RgResult<T>>) -> RgResult<T> {
    handle
        .await
        .unwrap_or_else(|error| Err(failure_of_join(&error)))
}

impl Inner {
    fn file_list(self: &Arc<Self>, root: &Path, include_ignored: bool) -> SharedList {
        let key = format!(
            "{}:{}",
            if include_ignored { "all" } else { "tracked" },
            root.to_string_lossy()
        );
        let mut state = self.state.lock();
        if let Some(cached) = state.lists.get(&key)
            && cached.at.elapsed() < FILE_LIST_TTL
        {
            return cached.list.clone();
        }
        state.next_id += 1;
        let id = state.next_id;
        let inner = Arc::clone(self);
        let task_key = key.clone();
        let (bin, root) = (self.bin.clone(), root.to_path_buf());
        let handle = tokio::spawn(async move {
            let result = list_files(&bin, &root, include_ignored, &CancellationToken::new()).await;
            if result.is_err() {
                let mut state = inner.state.lock();
                if state.lists.get(&task_key).map(|cached| cached.id) == Some(id) {
                    state.lists.remove(&task_key);
                }
            }
            result
        });
        let list = joined(handle).boxed().shared();
        state.lists.insert(
            key,
            CachedList {
                id,
                at: Instant::now(),
                list: list.clone(),
            },
        );
        list
    }

    fn claim_slot(self: &Arc<Self>, slot: String) -> (SlotGuard, CancellationToken) {
        let token = CancellationToken::new();
        let mut state = self.state.lock();
        if let Some((_, previous)) = state.running.get(&slot) {
            previous.cancel();
        }
        state.next_id += 1;
        let id = state.next_id;
        state.running.insert(slot.clone(), (id, token.clone()));
        let guard = SlotGuard {
            inner: Arc::clone(self),
            slot,
            id,
        };
        (guard, token)
    }

    fn text_search(
        &self,
        root: &Path,
        req: &SearchRequest,
        token: &CancellationToken,
        limit: usize,
    ) -> JoinHandle<RgResult<TextResults>> {
        let query = TextQuery {
            text: req.text.clone(),
            regex: req.regex,
            case_sensitive: req.case_sensitive,
            whole_word: req.whole_word,
            include_ignored: req.include_ignored,
        };
        let (bin, root, token) = (self.bin.clone(), root.to_path_buf(), token.clone());
        tokio::spawn(async move { search_text(&bin, &root, &query, &token, limit).await })
    }
}

fn is_directory(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|stat| stat.is_dir())
}

impl WorkspaceSearch {
    pub fn new(bin: PathBuf, roots: Vec<String>, host: Host) -> Self {
        Self {
            inner: Arc::new(Inner {
                bin,
                roots,
                host,
                state: Mutex::new(State::default()),
            }),
        }
    }

    pub fn run(&self, caller: u64, raw: &Value) -> BoxFuture<'static, SearchOutcome> {
        let Some(req) = parse_search_request(raw) else {
            return ready(SearchOutcome::failed(SearchError::Failed, "invalid search"));
        };
        let roots: Vec<&str> = self.inner.roots.iter().map(String::as_str).collect();
        let root =
            resolve_safe(&req.root, &roots, &self.inner.host).filter(|root| is_directory(root));
        let Some(root) = root else {
            return ready(SearchOutcome::failed(SearchError::OutsideRoots, ""));
        };
        let kind = if req.names_only {
            "names"
        } else if req.lines_only {
            "lines"
        } else {
            "text"
        };
        let (guard, token) = self.inner.claim_slot(format!("{caller}:{kind}"));
        let inner = Arc::clone(&self.inner);
        let root_text = root.to_string_lossy().into_owned();
        if req.names_only {
            let list = inner.file_list(&root, req.include_ignored);
            return async move {
                let _guard = guard;
                let list = list.await;
                if token.is_cancelled() {
                    return SearchOutcome::failed(SearchError::Cancelled, "");
                }
                match list {
                    Err(failure) => failure.into(),
                    Ok(list) => SearchOutcome::Ok(SearchResults {
                        root: root_text,
                        names: name_hits(&req.text, &list.paths, NAME_LIMIT, true),
                        files: Vec::new(),
                        pdfs: Vec::new(),
                        matches: 0,
                        truncated: list.truncated,
                    }),
                }
            }
            .boxed();
        }
        if req.lines_only {
            let lines = inner.text_search(&root, &req, &token, LINE_LIMIT);
            return async move {
                let _guard = guard;
                match joined(lines).await {
                    Err(failure) => failure.into(),
                    Ok(lines) => SearchOutcome::Ok(SearchResults {
                        root: root_text,
                        names: Vec::new(),
                        files: lines.files,
                        pdfs: Vec::new(),
                        matches: lines.matches,
                        truncated: lines.truncated,
                    }),
                }
            }
            .boxed();
        }
        let list = inner.file_list(&root, req.include_ignored);
        let text = joined(inner.text_search(&root, &req, &token, MATCH_LIMIT));
        async move {
            let _guard = guard;
            let (list, text) = tokio::join!(list, text);
            let text = match text {
                Ok(text) => text,
                Err(failure) => return failure.into(),
            };
            let list = match list {
                Ok(list) => list,
                Err(failure) => return failure.into(),
            };
            SearchOutcome::Ok(SearchResults {
                names: name_hits(&req.text, &list.paths, NAME_LIMIT, false),
                files: text.files,
                pdfs: pdf_files(&root, &list.paths, PDF_LIMIT),
                matches: text.matches,
                truncated: text.truncated,
                root: root_text,
            })
        }
        .boxed()
    }
}

fn ready(outcome: SearchOutcome) -> BoxFuture<'static, SearchOutcome> {
    std::future::ready(outcome).boxed()
}
