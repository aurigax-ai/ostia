use std::future::Future;
use std::sync::LazyLock;

use ostia_base::js::{JS_SPACE_CLASS, js_trim, static_regex};
use ostia_contract::dict::{Dict, fmt};
use ostia_contract::windows_api::{QuitAnswer, RunningGroup};
use regex::Regex;
use serde_json::{Value, json};
use unicode_segmentation::UnicodeSegmentation;

pub const MAX_GROUPS: usize = 3;
pub const MAX_ITEMS_PER_GROUP: usize = 5;
pub const MAX_NAME_COLUMNS: usize = 40;

const WIDE_RANGES: [(u32, u32); 11] = [
    (0x1100, 0x115f),
    (0x1f1e6, 0x1f1ff),
    (0x2600, 0x27bf),
    (0x2e80, 0xa4cf),
    (0xac00, 0xd7a3),
    (0xf900, 0xfaff),
    (0xfe30, 0xfe6f),
    (0xff00, 0xff60),
    (0xffe0, 0xffe6),
    (0x1f300, 0x1faff),
    (0x20000, 0x3fffd),
];

static SPACES: LazyLock<Regex> = LazyLock::new(|| static_regex(&format!("[{JS_SPACE_CLASS}]+")));

fn t<'a>(text: &'a Value, key: &str) -> &'a str {
    text.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn columns(grapheme: &str) -> usize {
    let point = grapheme.chars().next().map_or(0, u32::from);
    if WIDE_RANGES
        .iter()
        .any(|&(from, to)| point >= from && point <= to)
    {
        2
    } else {
        1
    }
}

fn clip(name: &str) -> String {
    let spaced = SPACES.replace_all(name, " ");
    let flat = js_trim(&spaced);
    let graphemes: Vec<&str> = flat.graphemes(true).collect();
    if graphemes.iter().map(|g| columns(g)).sum::<usize>() <= MAX_NAME_COLUMNS {
        return flat.to_owned();
    }
    let mut used = 1;
    let mut kept = String::new();
    for grapheme in graphemes {
        used += columns(grapheme);
        if used > MAX_NAME_COLUMNS {
            break;
        }
        kept.push_str(grapheme);
    }
    kept.push('…');
    kept
}

fn capped(lines: Vec<String>, max: usize, more: impl Fn(usize) -> String) -> Vec<String> {
    if lines.len() > max + 1 {
        let hidden = lines.len() - max;
        let mut shown: Vec<String> = lines.into_iter().take(max).collect();
        shown.push(more(hidden));
        shown
    } else {
        lines
    }
}

fn group_lines(text: &Value, group: &RunningGroup) -> Vec<String> {
    let named = |template: &str, name: &str| {
        let clipped = clip(name);
        let shown = if clipped.is_empty() {
            t(text, "unknown")
        } else {
            clipped.as_str()
        };
        format!("  {}", fmt(template, &json!({ "name": shown })))
    };
    let mut items: Vec<String> = Vec::new();
    items.extend(group.commands.iter().map(|c| named(t(text, "command"), c)));
    items.extend(group.agents.iter().map(|a| named(t(text, "agent"), a)));
    items.extend(group.files.iter().map(|f| {
        let base = f.rsplit('/').next().unwrap_or_default();
        named(t(text, "file"), if base.is_empty() { f } else { base })
    }));
    if group.scratch_files > 0 {
        items.push(format!(
            "  {}",
            fmt(t(text, "scratch"), &json!({ "count": group.scratch_files }))
        ));
    }
    if group.unanswered {
        items.push(format!("  {}", t(text, "unanswered")));
    }
    let mut lines = vec![clip(&group.workspace)];
    lines.extend(capped(items, MAX_ITEMS_PER_GROUP, |hidden| {
        format!("  {}", fmt(t(text, "more"), &json!({ "count": hidden })))
    }));
    lines
}

pub fn capped_lost_lines(text: &Value, groups: &[RunningGroup]) -> Vec<String> {
    let mut shown: Vec<String> = groups
        .iter()
        .take(MAX_GROUPS)
        .flat_map(|g| group_lines(text, g))
        .collect();
    if groups.len() <= MAX_GROUPS {
        return shown;
    }
    let hidden = groups.len() - MAX_GROUPS;
    shown.push(if hidden == 1 {
        t(text, "moreWorkspacesOne").to_owned()
    } else {
        fmt(t(text, "moreWorkspaces"), &json!({ "count": hidden }))
    });
    shown
}

fn kept_lines(text: &Value, kept_shells: usize) -> Vec<String> {
    if kept_shells == 0 {
        return Vec::new();
    }
    let count = if kept_shells == 1 {
        t(text, "keptShellsOne").to_owned()
    } else {
        fmt(t(text, "keptShells"), &json!({ "count": kept_shells }))
    };
    vec![count, t(text, "keptBody").to_owned()]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageBoxKind {
    Warning,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageBoxOptions {
    pub kind: MessageBoxKind,
    pub title: String,
    pub message: String,
    pub detail: String,
    pub buttons: Vec<String>,
    pub default_id: usize,
    pub cancel_id: usize,
    pub no_link: bool,
}

pub fn quit_prompt_options(
    groups: &[RunningGroup],
    kept_shells: usize,
    text: &Value,
) -> MessageBoxOptions {
    let lost: Vec<String> = if groups.is_empty() {
        Vec::new()
    } else {
        let mut lines = vec![t(text, "message").to_owned(), String::new()];
        lines.extend(capped_lost_lines(text, groups));
        lines
    };
    let kept = kept_lines(text, kept_shells);
    let mut detail = lost.clone();
    if !lost.is_empty() && !kept.is_empty() {
        detail.push(String::new());
    }
    detail.extend(kept);
    let offered = kept_shells > 0;
    let heading = if offered && groups.is_empty() {
        t(text, "keptTitle")
    } else {
        t(text, "title")
    };
    let buttons: &[&str] = if offered {
        &["cancel", "end", "keep"]
    } else {
        &["cancel", "quit"]
    };
    MessageBoxOptions {
        kind: MessageBoxKind::Warning,
        title: heading.to_owned(),
        message: heading.to_owned(),
        detail: detail.join("\n"),
        buttons: buttons.iter().map(|key| t(text, key).to_owned()).collect(),
        default_id: if offered { 2 } else { 0 },
        cancel_id: 0,
        no_link: true,
    }
}

pub trait MessageDialog {
    fn show(&self, options: MessageBoxOptions) -> impl Future<Output = usize> + Send;
}

pub struct NativeQuitConfirm<S, D> {
    strings: S,
    dialog: D,
}

pub fn native_quit_confirm<S, D>(strings: S, dialog: D) -> NativeQuitConfirm<S, D>
where
    S: Fn() -> Dict,
    D: MessageDialog,
{
    NativeQuitConfirm { strings, dialog }
}

impl<S, D> NativeQuitConfirm<S, D>
where
    S: Fn() -> Dict,
    D: MessageDialog,
{
    pub async fn confirm(&self, groups: &[RunningGroup], kept_shells: usize) -> QuitAnswer {
        let dict = (self.strings)();
        let text = &dict["native"]["quit"];
        let response = self
            .dialog
            .show(quit_prompt_options(groups, kept_shells, text))
            .await;
        match response {
            1 => QuitAnswer::Quit,
            2 if kept_shells > 0 => QuitAnswer::KeepShells,
            _ => QuitAnswer::Cancel,
        }
    }
}
