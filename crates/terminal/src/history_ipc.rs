use std::collections::HashMap;
use std::sync::Arc;

use ostia_base::js::utf16_len;
use parking_lot::Mutex;
use serde_json::Value;

use crate::history_feed::HistoryFeed;
use crate::history_search::{
    HistorySearchOptions, output_text, same_command, search_history, utf16_prefix, utf16_suffix,
};
use crate::pane_histories::PaneHistories;
use crate::pane_history::{HistoryBlock, PaneHistory};
use crate::scrollback_history::{HistoryBlockRange, HistoryPage, HistorySearchResult};

const PAGE_LINES_MAX: u64 = 5000;
const PAGE_CHARS_MAX: usize = 4 * 1024 * 1024;
const LINE_CHARS_MAX: usize = 16_384;
const BLOCK_OUTPUT_CHARS_MAX: usize = 16 * 1024 * 1024;

type WindowOfPane = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;
type FeedOfPane = Arc<dyn Fn(&str) -> Option<HistoryFeed> + Send + Sync>;

#[derive(Clone)]
pub struct HistoryIpcDeps {
    pub histories: Option<PaneHistories>,
    pub window_of_pane: WindowOfPane,
    pub feed_of_pane: FeedOfPane,
}

#[derive(Clone)]
pub struct HistoryIpc {
    deps: HistoryIpcDeps,
    searches: Arc<Mutex<HashMap<String, u64>>>,
}

struct Tail {
    lines: Vec<String>,
    start: u64,
}

impl Tail {
    fn end(&self) -> u64 {
        self.start + u64::try_from(self.lines.len()).unwrap_or(u64::MAX)
    }
}

fn clip_line(line: &str) -> String {
    if utf16_len(line) > LINE_CHARS_MAX {
        format!("{}\x1b[0m…", utf16_prefix(line, LINE_CHARS_MAX))
    } else {
        line.to_string()
    }
}

fn whole_number(raw: &Value, fallback: u64) -> u64 {
    match raw {
        Value::Number(number) => match number.as_f64() {
            Some(value) if value.is_finite() => value.floor().max(0.0) as u64,
            _ => fallback,
        },
        _ => fallback,
    }
}

fn search_options(raw: &Value) -> HistorySearchOptions {
    let flag = |name: &str| raw.get(name).and_then(Value::as_bool) == Some(true);
    HistorySearchOptions {
        case_sensitive: flag("caseSensitive"),
        regex: flag("regex"),
        whole_word: flag("wholeWord"),
    }
}

fn js_slice(lines: &[String], start: i64, end: i64) -> Vec<String> {
    let len = i64::try_from(lines.len()).unwrap_or(i64::MAX);
    let resolve = |index: i64| {
        if index < 0 {
            (len + index).max(0)
        } else {
            index.min(len)
        }
    };
    let from = resolve(start);
    let to = resolve(end);
    if from >= to {
        return Vec::new();
    }
    let from_index = usize::try_from(from).unwrap_or(0);
    let to_index = usize::try_from(to).unwrap_or(0);
    lines[from_index..to_index].to_vec()
}

fn signed(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

struct ResolvedBlock {
    block: HistoryBlock,
    end: Option<u64>,
    end_col: u64,
}

impl HistoryIpc {
    pub fn new(deps: HistoryIpcDeps) -> Self {
        Self {
            deps,
            searches: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn own_history(&self, sender: &str, pane: &Value) -> Option<(String, PaneHistory)> {
        let pane_id = pane.as_str()?;
        if (self.deps.window_of_pane)(pane_id).as_deref() != Some(sender) {
            return None;
        }
        let history = self.deps.histories.as_ref()?.get(pane_id)?;
        Some((pane_id.to_string(), history))
    }

    async fn with_tail(&self, pane_id: &str, history: &PaneHistory) -> Tail {
        let lines = match (self.deps.feed_of_pane)(pane_id) {
            Some(feed) => feed.tail().await,
            None => Vec::new(),
        };
        Tail {
            lines,
            start: history.end(),
        }
    }

    async fn read_lines(
        &self,
        history: &PaneHistory,
        tail: &Tail,
        from: u64,
        stop: u64,
    ) -> Vec<String> {
        let count = stop.min(tail.start).saturating_sub(from);
        let mut lines = history.read(from, count).await;
        let begin = (signed(from) - signed(tail.start)).max(0);
        let finish = signed(stop) - signed(tail.start);
        lines.extend(js_slice(&tail.lines, begin, finish));
        lines
    }

    pub async fn history_read(
        &self,
        sender: &str,
        pane: &Value,
        raw_from: &Value,
        raw_count: &Value,
    ) -> Option<HistoryPage> {
        let (pane_id, history) = self.own_history(sender, pane)?;
        let tail = self.with_tail(&pane_id, &history).await;
        let end = tail.end();
        let first = history.first();
        let from = end.min(first.max(whole_number(raw_from, first)));
        let count = PAGE_LINES_MAX.min(whole_number(raw_count, 0));
        let all = self
            .read_lines(&history, &tail, from, end.min(from.saturating_add(count)))
            .await;
        let mut lines = Vec::new();
        let mut chars = 0usize;
        for line in all {
            let clipped = clip_line(&line);
            chars += utf16_len(&clipped);
            if chars > PAGE_CHARS_MAX && !lines.is_empty() {
                break;
            }
            lines.push(clipped);
        }
        Some(HistoryPage {
            first: history.first(),
            end,
            from,
            lines,
        })
    }

    pub async fn history_search(
        &self,
        sender: &str,
        pane: &Value,
        query: &Value,
        raw_options: &Value,
        raw_live_lines: &Value,
    ) -> Option<HistorySearchResult> {
        let (pane_id, history) = self.own_history(sender, pane)?;
        let query = query.as_str()?;
        let key = format!("{sender}\0{pane_id}");
        let generation = {
            let mut searches = self.searches.lock();
            let next = searches.get(&key).copied().unwrap_or(0) + 1;
            searches.insert(key.clone(), next);
            next
        };
        let tail = self.with_tail(&pane_id, &history).await;
        let live = whole_number(raw_live_lines, 0);
        let until = signed(tail.end()) - signed(live);
        let bounded = u64::try_from(until.max(0)).unwrap_or(0).min(tail.start);
        let searches = self.searches.clone();
        let watched = key.clone();
        let result = search_history(
            &history,
            query,
            &search_options(raw_options),
            bounded,
            &move || searches.lock().get(&watched).copied() != Some(generation),
        )
        .await;
        let mut searches = self.searches.lock();
        if searches.get(&key).copied() == Some(generation) {
            searches.remove(&key);
        }
        result
    }

    async fn block_of(
        &self,
        pane_id: &str,
        history: &PaneHistory,
        seq: &Value,
        command: &Value,
    ) -> Option<ResolvedBlock> {
        let seq_number = seq.as_f64()?;
        let command = command.as_str()?;
        self.with_tail(pane_id, history).await;
        if seq_number < 0.0 || seq_number.fract() != 0.0 {
            return None;
        }
        let seq = seq_number as u64;
        let block = history.block(seq)?;
        if !same_command(block.command.as_deref(), command) {
            return None;
        }
        if let Some(end) = block.end {
            let end_col = block.end_col;
            return Some(ResolvedBlock {
                block,
                end: Some(end),
                end_col,
            });
        }
        let pending = match (self.deps.feed_of_pane)(pane_id) {
            Some(feed) => feed.pending_end(seq).await,
            None => None,
        };
        Some(ResolvedBlock {
            block,
            end: pending.map(|found| found.line),
            end_col: pending.map_or(0, |found| found.end_col),
        })
    }

    pub async fn history_block(
        &self,
        sender: &str,
        pane: &Value,
        seq: &Value,
        command: &Value,
    ) -> Option<HistoryBlockRange> {
        let (pane_id, history) = self.own_history(sender, pane)?;
        let resolved = self.block_of(&pane_id, &history, seq, command).await?;
        Some(HistoryBlockRange {
            start: resolved.block.start,
            end: resolved.end.unwrap_or_else(|| history.end()),
        })
    }

    pub async fn block_output(
        &self,
        sender: &str,
        pane: &Value,
        seq: &Value,
        command: &Value,
    ) -> Option<String> {
        let (pane_id, history) = self.own_history(sender, pane)?;
        let resolved = self.block_of(&pane_id, &history, seq, command).await?;
        let tail = self.with_tail(&pane_id, &history).await;
        let end = tail.end();
        let stop = match resolved.end {
            None => end,
            Some(block_end) => end.min(block_end + 1),
        };
        let lines = self
            .read_lines(&history, &tail, resolved.block.start, stop)
            .await;
        let end_col = resolved
            .end
            .map(|_| usize::try_from(resolved.end_col).unwrap_or(usize::MAX));
        let text = output_text(&lines, end_col);
        if utf16_len(&text) > BLOCK_OUTPUT_CHARS_MAX {
            Some(utf16_suffix(&text, BLOCK_OUTPUT_CHARS_MAX))
        } else {
            Some(text)
        }
    }
}
