use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::{BoxFuture, FutureExt, Shared, join_all};
use ostia_base::js::utf16_len;
use ostia_contract::file_links::{FileLinkMatch, find_file_links, resolve_link_path};
use ostia_contract::utf16_prefix::utf16_prefix;
use parking_lot::Mutex;
use tokio::time::Instant;

use crate::terminal::ostia_terminal::{TerminalPosition, TerminalRange};
use crate::terminal_links::link_modifier::{PathLinkClick, PathLinkTarget};

const STAT_TTL: Duration = Duration::from_millis(5_000);
const STAT_CACHE_MAX: usize = 500;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BufferCell {
    pub chars: String,
    pub width: u8,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BufferRow {
    pub wrapped: bool,
    pub cells: Vec<BufferCell>,
}

pub trait TerminalBuffer: Send + Sync {
    fn len(&self) -> usize;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    fn line(&self, y: usize) -> Option<BufferRow>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogicalLine {
    pub text: String,
    pub cells: Vec<TerminalPosition>,
}

pub fn read_logical_line(term: &dyn TerminalBuffer, row: i64) -> LogicalLine {
    let mut line = LogicalLine {
        text: String::new(),
        cells: Vec::new(),
    };
    let Ok(mut first) = usize::try_from(row - 1) else {
        return line;
    };
    while first > 0 && term.line(first).is_some_and(|row| row.wrapped) {
        first -= 1;
    }
    for y in first..term.len() {
        let Some(buffer_row) = term.line(y) else {
            break;
        };
        if y > first && !buffer_row.wrapped {
            break;
        }
        for (x, cell) in buffer_row.cells.iter().enumerate() {
            if cell.width == 0 {
                continue;
            }
            let chars = if cell.chars.is_empty() {
                " "
            } else {
                cell.chars.as_str()
            };
            let position = TerminalPosition {
                x: x as i64 + 1,
                y: y as i64 + 1,
            };
            line.cells
                .extend(std::iter::repeat_n(position, utf16_len(chars)));
            line.text.push_str(chars);
        }
    }
    line
}

pub fn matches_on_row(
    matches: Vec<FileLinkMatch>,
    cells: &[TerminalPosition],
    row: i64,
) -> Vec<FileLinkMatch> {
    matches
        .into_iter()
        .filter(|found| {
            let start = cells.get(found.start);
            let end = found.end.checked_sub(1).and_then(|last| cells.get(last));
            matches!((start, end), (Some(start), Some(end)) if start.y <= row && end.y >= row)
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathKind {
    File,
    Dir,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileLinkAction {
    OpenFile,
    AdmitFile,
    RevealFolder,
    OpenFolder,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileLinkFacts {
    pub confined: Option<PathKind>,
    pub probed: Option<PathKind>,
    pub revealable: bool,
    pub confined_only: bool,
}

pub fn file_link_action(facts: &FileLinkFacts) -> Option<FileLinkAction> {
    if facts.confined == Some(PathKind::File) {
        return Some(FileLinkAction::OpenFile);
    }
    if facts.confined == Some(PathKind::Dir) && facts.revealable {
        return Some(FileLinkAction::RevealFolder);
    }
    if facts.confined_only {
        return None;
    }
    if facts.confined == Some(PathKind::Dir) || facts.probed == Some(PathKind::Dir) {
        return Some(FileLinkAction::OpenFolder);
    }
    (facts.probed == Some(PathKind::File)).then_some(FileLinkAction::AdmitFile)
}

fn needs_human_click(how: PathLinkTarget, action: FileLinkAction) -> bool {
    if how != PathLinkTarget::Open {
        return how != PathLinkTarget::Show;
    }
    matches!(
        action,
        FileLinkAction::AdmitFile | FileLinkAction::OpenFolder
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OfferFacts {
    pub confined: Option<PathKind>,
    pub confined_only: bool,
}

pub fn path_link_offers(
    action: FileLinkAction,
    facts: OfferFacts,
    in_tree: bool,
) -> Vec<PathLinkTarget> {
    let mut offers = vec![PathLinkTarget::Open];
    if !facts.confined_only && action != FileLinkAction::OpenFolder {
        offers.push(PathLinkTarget::OpenSystem);
    }
    if facts.confined.is_some() && in_tree && action != FileLinkAction::RevealFolder {
        offers.push(PathLinkTarget::Show);
    }
    if !facts.confined_only {
        offers.push(PathLinkTarget::ShowSystem);
    }
    offers
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileLinkTarget {
    pub written: String,
    pub path: String,
    pub line: Option<u64>,
    pub column: Option<u64>,
}

pub struct FileLinkDeps {
    pub cwd: Box<dyn Fn() -> Option<String> + Send + Sync>,
    pub remote: Box<dyn Fn() -> bool + Send + Sync>,
    pub confined_only: Box<dyn Fn() -> bool + Send + Sync>,
    pub revealable: Box<dyn Fn(&str) -> bool + Send + Sync>,
    pub stat: Box<dyn Fn(String) -> BoxFuture<'static, Option<PathKind>> + Send + Sync>,
    pub probe: Box<dyn Fn(String) -> BoxFuture<'static, Option<PathKind>> + Send + Sync>,
    pub activate: Box<dyn Fn(PathLinkTarget, FileLinkAction, FileLinkTarget) + Send + Sync>,
    pub target: Box<dyn Fn(PathLinkClick) -> Option<PathLinkTarget> + Send + Sync>,
    pub hover: Box<dyn Fn(TerminalRange, FileLinkAction, Vec<PathLinkTarget>) + Send + Sync>,
    pub leave: Box<dyn Fn() + Send + Sync>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LinkDecorations {
    pub pointer_cursor: bool,
    pub underline: bool,
}

pub struct TerminalLink {
    pub range: TerminalRange,
    pub text: String,
    pub decorations: LinkDecorations,
    action: FileLinkAction,
    offers: Vec<PathLinkTarget>,
    target: FileLinkTarget,
    deps: Arc<FileLinkDeps>,
}

impl TerminalLink {
    pub fn activate(&self, click: PathLinkClick, trusted: bool) {
        let Some(how) = (self.deps.target)(click) else {
            return;
        };
        if !self.offers.contains(&how) || (self.deps.remote)() {
            return;
        }
        if needs_human_click(how, self.action) && !trusted {
            return;
        }
        (self.deps.activate)(how, self.action, self.target.clone());
    }

    pub fn hover(&self) {
        (self.deps.hover)(self.range, self.action, self.offers.clone());
    }

    pub fn leave(&self) {
        (self.deps.leave)();
    }
}

#[derive(Clone, Copy)]
struct Kinds {
    confined: Option<PathKind>,
    probed: Option<PathKind>,
}

type PendingKinds = Shared<BoxFuture<'static, Kinds>>;

struct CacheEntry {
    kinds: PendingKinds,
    stored_at: Instant,
    used: u64,
}

#[derive(Default)]
struct StatCache {
    entries: HashMap<String, CacheEntry>,
    clock: u64,
}

impl StatCache {
    fn get(&mut self, key: &str) -> Option<PendingKinds> {
        let fresh = self
            .entries
            .get(key)
            .is_some_and(|entry| entry.stored_at.elapsed() < STAT_TTL);
        if !fresh {
            self.entries.remove(key);
            return None;
        }
        self.clock += 1;
        let entry = self.entries.get_mut(key)?;
        entry.used = self.clock;
        Some(entry.kinds.clone())
    }

    fn set(&mut self, key: String, kinds: PendingKinds) {
        self.clock += 1;
        self.entries.insert(
            key,
            CacheEntry {
                kinds,
                stored_at: Instant::now(),
                used: self.clock,
            },
        );
        if self.entries.len() > STAT_CACHE_MAX {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                self.entries.remove(&oldest);
            }
        }
    }
}

pub struct FileLinkProvider {
    term: Arc<dyn TerminalBuffer>,
    deps: Arc<FileLinkDeps>,
    cache: Mutex<StatCache>,
}

pub fn create_file_link_provider(
    term: Arc<dyn TerminalBuffer>,
    deps: FileLinkDeps,
) -> FileLinkProvider {
    FileLinkProvider {
        term,
        deps: Arc::new(deps),
        cache: Mutex::new(StatCache::default()),
    }
}

fn slice_utf16(text: &str, start: usize, end: usize) -> &str {
    let head = utf16_prefix(text, end);
    let skip = utf16_prefix(head, start).len();
    head.get(skip..).unwrap_or_default()
}

async fn ask(deps: Arc<FileLinkDeps>, written: String, path: String, confined_only: bool) -> Kinds {
    let confined = (deps.stat)(path.clone()).await;
    if confined.is_some() || confined_only || !path.starts_with('/') {
        return Kinds {
            confined,
            probed: None,
        };
    }
    Kinds {
        confined,
        probed: (deps.probe)(written).await,
    }
}

impl FileLinkProvider {
    fn kinds_cached(&self, written: &str, path: &str, confined_only: bool) -> PendingKinds {
        let key = format!("{}{path}", if confined_only { 'c' } else { 'p' });
        let mut cache = self.cache.lock();
        if let Some(hit) = cache.get(&key) {
            return hit;
        }
        let kinds = ask(
            self.deps.clone(),
            written.to_owned(),
            path.to_owned(),
            confined_only,
        )
        .boxed()
        .shared();
        cache.set(key, kinds.clone());
        kinds
    }

    pub fn provide_links(&self, row: i64) -> BoxFuture<'static, Option<Vec<TerminalLink>>> {
        if (self.deps.remote)() {
            return std::future::ready(None).boxed();
        }
        let cwd = (self.deps.cwd)();
        let confined_only = (self.deps.confined_only)();
        let line = read_logical_line(self.term.as_ref(), row);
        let matches = matches_on_row(find_file_links(&line.text), &line.cells, row);
        if matches.is_empty() {
            return std::future::ready(None).boxed();
        }
        let pending: Vec<_> = matches
            .into_iter()
            .filter_map(|found| {
                let start = *line.cells.get(found.start)?;
                let end = *line.cells.get(found.end.checked_sub(1)?)?;
                let path = resolve_link_path(&found.path, cwd.as_deref().unwrap_or("~"));
                let kinds = self.kinds_cached(&found.path, &path, confined_only);
                let text = slice_utf16(&line.text, found.start, found.end).to_owned();
                let deps = self.deps.clone();
                Some(async move {
                    let kinds = kinds.await;
                    let revealable = kinds.confined.is_some() && (deps.revealable)(&path);
                    let action = file_link_action(&FileLinkFacts {
                        confined: kinds.confined,
                        probed: kinds.probed,
                        revealable: kinds.confined == Some(PathKind::Dir) && revealable,
                        confined_only,
                    })?;
                    let offers = path_link_offers(
                        action,
                        OfferFacts {
                            confined: kinds.confined,
                            confined_only,
                        },
                        revealable,
                    );
                    Some(TerminalLink {
                        range: TerminalRange { start, end },
                        text,
                        decorations: LinkDecorations {
                            pointer_cursor: true,
                            underline: true,
                        },
                        action,
                        offers,
                        target: FileLinkTarget {
                            written: found.path,
                            path,
                            line: found.line,
                            column: found.column,
                        },
                        deps,
                    })
                })
            })
            .collect();
        async move {
            let links: Vec<TerminalLink> = join_all(pending).await.into_iter().flatten().collect();
            (!links.is_empty()).then_some(links)
        }
        .boxed()
    }
}
