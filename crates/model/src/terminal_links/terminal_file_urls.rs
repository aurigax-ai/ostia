use std::sync::Arc;

use futures_util::future::{BoxFuture, FutureExt, Shared, join_all};
use ostia_contract::file_urls::{FileUrlOpener, FileUrlTarget, find_file_urls, opens_file_url};
use parking_lot::Mutex;

use crate::terminal::ostia_terminal::TerminalRange;
use crate::terminal_links::link_modifier::PathLinkTarget;
use crate::terminal_links::pending_cache::PendingCache;
use crate::terminal_links::terminal_app_links::{LinkEvent, WebLinkHandler};
use crate::terminal_links::terminal_file_links::{
    LinkDecorations, TerminalBuffer, match_ends, read_logical_line,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileUrlAction {
    PreviewPage,
    BrowsePage,
    OpenDefault,
}

pub fn file_url_action(target: &FileUrlTarget, previews: bool) -> FileUrlAction {
    if target.opener == FileUrlOpener::DefaultApp {
        return FileUrlAction::OpenDefault;
    }
    if previews {
        FileUrlAction::PreviewPage
    } else {
        FileUrlAction::BrowsePage
    }
}

pub fn file_url_offers(action: FileUrlAction) -> Vec<PathLinkTarget> {
    if action == FileUrlAction::PreviewPage {
        vec![PathLinkTarget::Open, PathLinkTarget::OpenSystem]
    } else {
        vec![PathLinkTarget::Open]
    }
}

pub type CheckFileUrl =
    Box<dyn Fn(String) -> BoxFuture<'static, Option<FileUrlTarget>> + Send + Sync>;
pub type PreviewsFileUrl = Box<dyn Fn(&FileUrlTarget) -> bool + Send + Sync>;
pub type ActivateFileUrl =
    Box<dyn Fn(PathLinkTarget, String, FileUrlTarget, FileUrlAction) + Send + Sync>;
pub type HoverFileUrl = Box<dyn Fn(TerminalRange, FileUrlTarget, FileUrlAction) + Send + Sync>;

pub struct FileUrlDeps {
    pub remote: Box<dyn Fn() -> bool + Send + Sync>,
    pub check: CheckFileUrl,
    pub previews: PreviewsFileUrl,
    pub target: Box<dyn Fn(LinkEvent) -> Option<PathLinkTarget> + Send + Sync>,
    pub activate: ActivateFileUrl,
    pub hover: HoverFileUrl,
    pub leave: Box<dyn Fn() + Send + Sync>,
}

type PendingTarget = Shared<BoxFuture<'static, Option<FileUrlTarget>>>;

struct Inner {
    deps: FileUrlDeps,
    cache: Mutex<PendingCache<PendingTarget>>,
    hovered: Mutex<Option<String>>,
}

#[derive(Clone)]
pub struct FileUrlLinks {
    inner: Arc<Inner>,
}

pub fn create_file_url_links(deps: FileUrlDeps) -> FileUrlLinks {
    FileUrlLinks {
        inner: Arc::new(Inner {
            deps,
            cache: Mutex::new(PendingCache::default()),
            hovered: Mutex::new(None),
        }),
    }
}

impl Inner {
    fn check(&self, url: &str) -> PendingTarget {
        let mut cache = self.cache.lock();
        if let Some(hit) = cache.get(url) {
            return hit;
        }
        let found = (self.deps.check)(url.to_owned()).boxed().shared();
        cache.set(url.to_owned(), found.clone());
        found
    }

    fn action_of(&self, target: &FileUrlTarget) -> FileUrlAction {
        file_url_action(target, (self.deps.previews)(target))
    }
}

pub struct FileUrlLink {
    pub range: TerminalRange,
    pub text: String,
    pub decorations: LinkDecorations,
    links: FileUrlLinks,
}

impl FileUrlLink {
    pub fn activate(&self, event: LinkEvent) {
        self.links.activate(event, &self.text);
    }

    pub fn hover(&self) {
        self.links.hover(self.range, &self.text);
    }

    pub fn leave(&self) {
        self.links.leave();
    }
}

pub struct FileUrlProvider {
    term: Arc<dyn TerminalBuffer>,
    links: FileUrlLinks,
}

impl FileUrlLinks {
    pub fn provider(&self, term: Arc<dyn TerminalBuffer>) -> FileUrlProvider {
        FileUrlProvider {
            term,
            links: self.clone(),
        }
    }

    pub fn activate(&self, event: LinkEvent, url: &str) {
        let inner = &self.inner;
        if !event.trusted || (inner.deps.remote)() || !opens_file_url(url) {
            return;
        }
        let Some(how) = (inner.deps.target)(event) else {
            return;
        };
        let pending = inner.check(url);
        let inner = inner.clone();
        let url = url.to_owned();
        tokio::spawn(async move {
            let Some(target) = pending.await else {
                return;
            };
            let action = inner.action_of(&target);
            if file_url_offers(action).contains(&how) {
                (inner.deps.activate)(how, url, target, action);
            }
        });
    }

    pub fn hover(&self, range: TerminalRange, url: &str) {
        let inner = &self.inner;
        *inner.hovered.lock() = Some(url.to_owned());
        if (inner.deps.remote)() || !opens_file_url(url) {
            return;
        }
        let pending = inner.check(url);
        let inner = inner.clone();
        let url = url.to_owned();
        tokio::spawn(async move {
            let Some(target) = pending.await else {
                return;
            };
            if inner.hovered.lock().as_deref() == Some(url.as_str()) {
                let action = inner.action_of(&target);
                (inner.deps.hover)(range, target, action);
            }
        });
    }

    pub fn leave(&self) {
        *self.inner.hovered.lock() = None;
        (self.inner.deps.leave)();
    }
}

impl FileUrlProvider {
    pub fn provide_links(&self, row: i64) -> BoxFuture<'static, Option<Vec<FileUrlLink>>> {
        let inner = &self.links.inner;
        if (inner.deps.remote)() {
            return std::future::ready(None).boxed();
        }
        let line = read_logical_line(self.term.as_ref(), row);
        let pending: Vec<_> = find_file_urls(&line.text)
            .into_iter()
            .filter_map(|found| {
                let (start, end) = match_ends(&line.cells, found.start, found.end, row)?;
                let check = inner.check(&found.url);
                let links = self.links.clone();
                Some(async move {
                    check.await?;
                    Some(FileUrlLink {
                        range: TerminalRange { start, end },
                        text: found.url,
                        decorations: LinkDecorations {
                            pointer_cursor: true,
                            underline: true,
                        },
                        links,
                    })
                })
            })
            .collect();
        if pending.is_empty() {
            return std::future::ready(None).boxed();
        }
        async move {
            let links: Vec<FileUrlLink> = join_all(pending).await.into_iter().flatten().collect();
            (!links.is_empty()).then_some(links)
        }
        .boxed()
    }
}

fn is_file_url(uri: &str) -> bool {
    uri.as_bytes()
        .get(..5)
        .is_some_and(|head| head.eq_ignore_ascii_case(b"file:"))
}

struct FileUrlHandler {
    links: Arc<dyn WebLinkHandler>,
    file_urls: FileUrlLinks,
}

impl WebLinkHandler for FileUrlHandler {
    fn activate(&self, event: LinkEvent, uri: &str, range: TerminalRange) {
        if is_file_url(uri) {
            self.file_urls.activate(event, uri);
        } else {
            self.links.activate(event, uri, range);
        }
    }

    fn hover(&self, event: LinkEvent, uri: &str, range: TerminalRange) {
        if is_file_url(uri) {
            self.file_urls.hover(range, uri);
        } else {
            self.links.hover(event, uri, range);
        }
    }

    fn leave(&self, event: LinkEvent, uri: &str, range: TerminalRange) {
        if is_file_url(uri) {
            self.file_urls.leave();
        } else {
            self.links.leave(event, uri, range);
        }
    }
}

pub fn with_file_urls(
    links: Arc<dyn WebLinkHandler>,
    file_urls: FileUrlLinks,
) -> Arc<dyn WebLinkHandler> {
    Arc::new(FileUrlHandler { links, file_urls })
}
