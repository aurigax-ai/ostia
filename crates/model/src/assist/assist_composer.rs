use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ostia_base::js::{is_js_space, js_trim, utf16_len};
use parking_lot::Mutex;

use super::text_diff::diff_words_with_space;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ComposerMode {
    Agent,
    Shell,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ComposerState {
    pub agent: bool,
    pub idle_prompt: bool,
    pub input_ready: bool,
    pub command_ready: bool,
}

pub fn composer_mode_for(state: &ComposerState) -> Option<ComposerMode> {
    if state.agent {
        return state.input_ready.then_some(ComposerMode::Agent);
    }
    if state.idle_prompt {
        return state.command_ready.then_some(ComposerMode::Shell);
    }
    None
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffPart {
    pub at: usize,
    pub text: String,
    pub changed: bool,
}

const WORD_DIFF_MAX_EDITS: usize = 600;

fn split_keeping_spaces(text: &str) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut in_space = false;
    for (at, ch) in text.char_indices() {
        let space = is_js_space(ch);
        if at > start && space != in_space {
            pieces.push(&text[start..at]);
            start = at;
        }
        in_space = space;
    }
    if start < text.len() {
        pieces.push(&text[start..]);
    }
    pieces
}

pub fn word_diff(before: &str, after: &str) -> Vec<DiffPart> {
    let Some(changes) = diff_words_with_space(before, after, Some(WORD_DIFF_MAX_EDITS)) else {
        return vec![DiffPart {
            at: 0,
            text: after.to_owned(),
            changed: true,
        }];
    };
    let mut parts: Vec<DiffPart> = Vec::new();
    let mut at = 0;
    for change in changes {
        if change.removed {
            continue;
        }
        for piece in split_keeping_spaces(&change.value) {
            let changed = change.added && !piece.chars().all(is_js_space);
            match parts.last_mut() {
                Some(last) if last.changed == changed => last.text.push_str(piece),
                _ => parts.push(DiffPart {
                    at,
                    text: piece.to_owned(),
                    changed,
                }),
            }
            at += utf16_len(piece);
        }
    }
    parts
}

#[derive(Clone, Debug, Default)]
pub struct AbortSignal(Arc<AtomicBool>);

impl AbortSignal {
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    fn abort(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[derive(Default)]
pub struct LatestRequest {
    current: Mutex<Option<AbortSignal>>,
}

impl LatestRequest {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn run<F, Fut>(&self, delay: Duration, request: F)
    where
        F: FnOnce(AbortSignal) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let signal = AbortSignal::default();
        if let Some(previous) = self.current.lock().replace(signal.clone()) {
            previous.abort();
        }
        let timer = tokio::time::sleep(delay);
        tokio::spawn(async move {
            timer.await;
            if !signal.is_cancelled() {
                request(signal).await;
            }
        });
    }

    pub fn cancel(&self) {
        if let Some(previous) = self.current.lock().take() {
            previous.abort();
        }
    }
}

pub fn natural_command_query(draft: &str) -> Option<String> {
    let rest = draft.strip_prefix('#')?;
    let body = rest.trim_start_matches(is_js_space);
    if body.len() == rest.len() {
        return None;
    }
    let mut chars = body.chars();
    chars.next()?;
    if utf16_len(chars.as_str()) < 2 {
        return None;
    }
    Some(js_trim(body).to_owned())
}
