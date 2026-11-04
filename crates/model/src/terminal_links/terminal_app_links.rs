use std::sync::Arc;

use ostia_contract::external_links::{find_app_links, link_kind};

use crate::terminal::ostia_terminal::TerminalRange;
use crate::terminal_links::terminal_file_links::{
    LinkDecorations, TerminalBuffer, match_ends, read_logical_line,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LinkEvent {
    pub ctrl: bool,
    pub meta: bool,
    pub shift: bool,
    pub alt: bool,
    pub detail: u32,
    pub trusted: bool,
}

pub trait WebLinkHandler: Send + Sync {
    fn activate(&self, event: LinkEvent, uri: &str, range: TerminalRange);
    fn hover(&self, event: LinkEvent, uri: &str, range: TerminalRange);
    fn leave(&self, event: LinkEvent, uri: &str, range: TerminalRange);
}

pub trait HintSink: Send + Sync {
    fn show(&self, range: TerminalRange, uri: &str);
    fn hide(&self);
}

pub type ActivateLink = Box<dyn Fn(LinkEvent, &str, TerminalRange) + Send + Sync>;

struct HintedLinkHandler {
    activate: ActivateLink,
    hint: Arc<dyn HintSink>,
}

impl WebLinkHandler for HintedLinkHandler {
    fn activate(&self, event: LinkEvent, uri: &str, range: TerminalRange) {
        (self.activate)(event, uri, range);
    }

    fn hover(&self, _event: LinkEvent, uri: &str, range: TerminalRange) {
        if link_kind(uri).is_some() {
            self.hint.show(range, uri);
        }
    }

    fn leave(&self, _event: LinkEvent, _uri: &str, _range: TerminalRange) {
        self.hint.hide();
    }
}

pub fn hinted_link_handler(
    activate: ActivateLink,
    hint: Arc<dyn HintSink>,
) -> Arc<dyn WebLinkHandler> {
    Arc::new(HintedLinkHandler { activate, hint })
}

pub struct AppLink {
    pub range: TerminalRange,
    pub text: String,
    pub decorations: LinkDecorations,
    deps: Arc<dyn WebLinkHandler>,
}

impl AppLink {
    pub fn activate(&self, event: LinkEvent) {
        self.deps.activate(event, &self.text, self.range);
    }

    pub fn hover(&self, event: LinkEvent) {
        self.deps.hover(event, &self.text, self.range);
    }

    pub fn leave(&self, event: LinkEvent) {
        self.deps.leave(event, &self.text, self.range);
    }
}

pub struct AppLinkProvider {
    term: Arc<dyn TerminalBuffer>,
    deps: Arc<dyn WebLinkHandler>,
}

pub fn create_app_link_provider(
    term: Arc<dyn TerminalBuffer>,
    deps: Arc<dyn WebLinkHandler>,
) -> AppLinkProvider {
    AppLinkProvider { term, deps }
}

impl AppLinkProvider {
    pub fn provide_links(&self, row: i64) -> Option<Vec<AppLink>> {
        let line = read_logical_line(self.term.as_ref(), row);
        let links: Vec<AppLink> = find_app_links(&line.text)
            .into_iter()
            .filter_map(|found| {
                let (start, end) = match_ends(&line.cells, found.start, found.end, row)?;
                Some(AppLink {
                    range: TerminalRange { start, end },
                    text: found.url,
                    decorations: LinkDecorations {
                        pointer_cursor: true,
                        underline: true,
                    },
                    deps: self.deps.clone(),
                })
            })
            .collect();
        (!links.is_empty()).then_some(links)
    }
}
