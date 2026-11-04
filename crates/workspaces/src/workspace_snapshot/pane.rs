use super::fields::{Record, copy_text, is_true, text};
use super::model::{BrowserProfile, SnapshotPane, SurfaceKind};
use crate::browser_device::parse_browser_device;
use crate::patterns::{is_remote_path, is_view_name, is_view_type};
use crate::stored_resume::parse_resume_failure;
use ostia_contract::agent_resume::parse_stored_resume;

pub fn parse_pane(
    record: &Record,
    id: &str,
    kind: SurfaceKind,
    in_tab: bool,
) -> Option<SnapshotPane> {
    let mut pane = SnapshotPane::new(id, text(record, "title").unwrap_or(id), kind);
    pane.cwd = copy_text(record, "cwd");
    if !text(record, "filePath").is_some_and(is_remote_path) {
        pane.file_path = copy_text(record, "filePath");
    }
    if kind == SurfaceKind::Editor {
        pane.view_type = text(record, "viewType")
            .filter(|view| is_view_type(view))
            .map(str::to_owned);
    }
    pane.url = copy_text(record, "url");
    match kind {
        SurfaceKind::Chat => pane.chat_session_id = copy_text(record, "chatSessionId"),
        SurfaceKind::Agent => pane.agent_session_id = copy_text(record, "agentSessionId"),
        SurfaceKind::Browser => {
            if text(record, "browserProfile") == Some("shared") {
                pane.browser_profile = Some(BrowserProfile::Shared);
            }
            pane.browser_device = record.get("browserDevice").and_then(parse_browser_device);
        }
        SurfaceKind::Terminal | SurfaceKind::Editor | SurfaceKind::Git | SurfaceKind::View => {}
    }
    pane.view_name = text(record, "viewName")
        .filter(|name| is_view_name(name))
        .map(str::to_owned);
    let resume = record.get("resume").and_then(parse_stored_resume);
    let has_resume = resume.is_some();
    pane.agent_running =
        has_resume && is_true(record, "agentRunning") && !is_true(record, "hibernated");
    pane.hibernated = has_resume && is_true(record, "hibernated");
    pane.keep_awake = has_resume && is_true(record, "keepAwake");
    pane.resume = resume;
    pane.resume_failed = if has_resume {
        None
    } else {
        record.get("resumeFailed").and_then(parse_resume_failure)
    };
    pane.locked = is_true(record, "locked");
    pane.default_title = kind == SurfaceKind::Terminal && is_true(record, "defaultTitle");
    pane.title_pinned = is_true(record, "titlePinned");
    pane.collapsed = in_tab && is_true(record, "collapsed");
    if kind == SurfaceKind::View && pane.view_name.is_none() {
        return None;
    }
    Some(pane)
}
