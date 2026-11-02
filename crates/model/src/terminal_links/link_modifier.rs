use ostia_contract::external_links::{LinkKind, link_kind};

use crate::settings::terminal_pane_settings::LinkClick;
use crate::terminal::ostia_terminal::TerminalRange;

pub fn link_modifier_held(ctrl: bool, meta: bool, mac: bool) -> bool {
    if mac { meta } else { ctrl }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WebLinkTarget {
    SameTab,
    NewTab,
    System,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WebLinkClick {
    pub ctrl: bool,
    pub meta: bool,
    pub shift: bool,
    pub detail: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WebLinkClickContext {
    pub mac: bool,
    pub has_selection: bool,
    pub mouse_reporting: bool,
    pub link_click: LinkClick,
}

fn opens_in_system(shift: bool, link_click: LinkClick) -> bool {
    shift == (link_click == LinkClick::App)
}

pub fn web_link_target(click: WebLinkClick, ctx: WebLinkClickContext) -> Option<WebLinkTarget> {
    if link_modifier_held(click.ctrl, click.meta, ctx.mac) {
        return Some(if opens_in_system(click.shift, ctx.link_click) {
            WebLinkTarget::System
        } else {
            WebLinkTarget::NewTab
        });
    }
    if click.ctrl || click.meta || click.shift || click.detail > 1 {
        return None;
    }
    if ctx.has_selection || ctx.mouse_reporting {
        return None;
    }
    Some(WebLinkTarget::SameTab)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathLinkTarget {
    Open,
    OpenSystem,
    Show,
    ShowSystem,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PathLinkClick {
    pub ctrl: bool,
    pub meta: bool,
    pub shift: bool,
    pub alt: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PathLinkContext {
    pub mac: bool,
    pub link_click: LinkClick,
}

pub fn path_link_target(click: PathLinkClick, ctx: PathLinkContext) -> Option<PathLinkTarget> {
    if !link_modifier_held(click.ctrl, click.meta, ctx.mac) {
        return None;
    }
    let system = opens_in_system(click.shift, ctx.link_click);
    Some(match (click.alt, system) {
        (true, true) => PathLinkTarget::ShowSystem,
        (true, false) => PathLinkTarget::Show,
        (false, true) => PathLinkTarget::OpenSystem,
        (false, false) => PathLinkTarget::Open,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalLinkTarget {
    Web(WebLinkTarget),
    App,
}

pub fn terminal_link_target(
    uri: &str,
    click: WebLinkClick,
    ctx: WebLinkClickContext,
) -> Option<TerminalLinkTarget> {
    let kind = link_kind(uri)?;
    let target = web_link_target(click, ctx)?;
    Some(match kind {
        LinkKind::External => TerminalLinkTarget::App,
        LinkKind::Browser => TerminalLinkTarget::Web(target),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LinkSpan {
    pub row: i64,
    pub start: i64,
    pub end: i64,
}

pub fn link_span(range: TerminalRange, viewport_y: i64, cols: i64) -> LinkSpan {
    let end = if range.end.y == range.start.y {
        range.end.x
    } else {
        cols
    };
    LinkSpan {
        row: range.start.y - 1 - viewport_y,
        start: range.start.x - 1,
        end,
    }
}

pub fn link_claims_press(button: i16, claims: impl FnOnce() -> bool) -> bool {
    button == 0 && claims()
}
