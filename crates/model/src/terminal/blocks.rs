use std::collections::{HashMap, HashSet};

use ostia_base::js::{js_trim, non_empty};

use super::blocks_store::CommandBlock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineSpan {
    pub start: i64,
    pub end: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepDirection {
    Prev,
    Next,
}

pub fn block_span(block: &CommandBlock, cursor_line: i64) -> LineSpan {
    let prompt = block.prompt_line.line;
    let start = if prompt >= 0 {
        prompt
    } else {
        block.output_start_line.line
    };
    let end = match &block.end_line {
        Some(end_line) => end_line.line + i64::from(block.end_col > 0),
        None => cursor_line + 1,
    };
    LineSpan {
        start,
        end: end.max(start + 1),
    }
}

pub fn command_line(block: &CommandBlock) -> i64 {
    let input = block.input_line.as_ref().map_or(-1, |anchor| anchor.line);
    if input >= 0 {
        input
    } else {
        block.prompt_line.line
    }
}

pub fn step_selection<'a>(
    ids: &[&'a str],
    current: Option<&str>,
    dir: StepDirection,
) -> Option<&'a str> {
    let last = ids.len().checked_sub(1)?;
    let found = non_empty(current).and_then(|id| ids.iter().position(|candidate| *candidate == id));
    let Some(idx) = found else {
        return match dir {
            StepDirection::Prev => Some(ids[last]),
            StepDirection::Next => None,
        };
    };
    let next = match dir {
        StepDirection::Prev => idx.saturating_sub(1),
        StepDirection::Next => (idx + 1).min(last),
    };
    Some(ids[next])
}

pub fn scroll_target_for(span: LineSpan, viewport_y: i64, rows: i64) -> Option<i64> {
    let visible = span.start >= viewport_y && span.start < viewport_y + rows;
    (!visible).then_some(span.start)
}

pub fn sticky_block(
    blocks: &[CommandBlock],
    viewport_y: i64,
    cursor_line: i64,
) -> Option<&CommandBlock> {
    for block in blocks.iter().rev() {
        let line = command_line(block);
        if line < 0 || line >= viewport_y {
            continue;
        }
        let LineSpan { end, .. } = block_span(block, cursor_line);
        return (end > viewport_y).then_some(block);
    }
    None
}

pub fn is_idle_prompt<D>(
    drafts: &HashMap<String, D>,
    running: &HashMap<String, String>,
    pane_id: &str,
) -> bool {
    drafts.contains_key(pane_id) && non_empty(running.get(pane_id).map(String::as_str)).is_none()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneOrigin {
    pub workspace_id: String,
    pub workspace_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryEntry {
    pub command: String,
    pub pane_id: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub cwd: Option<String>,
    pub at: i64,
}

pub fn collect_history(
    by_pane: &HashMap<String, Vec<CommandBlock>>,
    origins: &HashMap<String, PaneOrigin>,
) -> Vec<HistoryEntry> {
    let mut pane_ids: Vec<&String> = by_pane.keys().collect();
    pane_ids.sort();
    let mut all: Vec<HistoryEntry> = Vec::new();
    for pane_id in pane_ids {
        let Some(origin) = origins.get(pane_id) else {
            continue;
        };
        for block in by_pane[pane_id].iter().rev() {
            let command = js_trim(&block.command);
            if command.is_empty() {
                continue;
            }
            all.push(HistoryEntry {
                command: command.to_owned(),
                pane_id: pane_id.clone(),
                workspace_id: origin.workspace_id.clone(),
                workspace_name: origin.workspace_name.clone(),
                cwd: block.cwd.clone(),
                at: block.started_at,
            });
        }
    }
    all.sort_by(|a, b| b.at.cmp(&a.at));
    let mut seen: HashSet<String> = HashSet::new();
    all.retain(|entry| seen.insert(entry.command.clone()));
    all
}
