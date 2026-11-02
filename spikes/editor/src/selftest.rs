use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::base::input::{AddCursorBelow, Delete, RopeExt};
use gpui_kit::component::input::EditorState;
use gpui_kit::*;
use lsp_types::{CompletionContext, CompletionResponse, CompletionTriggerKind, Position};
use serde_json::Value;

use crate::lsp::{LspClient, ServerLaunch};
use crate::provider::ServerDocument;

pub const ENV: &str = "SPIKE_SELFTEST";

async fn pause(cx: &mut AsyncWindowContext, milliseconds: u64) {
    cx.background_executor()
        .timer(Duration::from_millis(milliseconds))
        .await;
}

fn line_texts(
    editor: &Entity<EditorState>,
    rows: &[usize],
    cx: &mut AsyncWindowContext,
) -> Vec<String> {
    cx.update(|_, cx| {
        let text = editor.read(cx).text();
        rows.iter()
            .map(|row| text.slice_line(*row).to_string())
            .collect()
    })
    .unwrap_or_default()
}

pub async fn editing(
    left: Entity<EditorState>,
    right: Option<Entity<EditorState>>,
    cx: &mut AsyncWindowContext,
) {
    pause(cx, 4000).await;
    multi_cursor(&left, cx).await;
    find_replace(&left, cx).await;
    if let Some(right) = right {
        scroll_sync(&left, &right, cx).await;
    }
    cx.update(|_, cx| cx.quit()).ok();
}

async fn multi_cursor(left: &Entity<EditorState>, cx: &mut AsyncWindowContext) {
    let rows = [9, 10, 11, 12, 13];
    let before = line_texts(left, &rows, cx);
    cx.update(|window, cx| {
        left.update(cx, |state, cx| {
            state.set_cursor_position(Position::new(10, 3), window, cx)
        });
    })
    .ok();
    pause(cx, 500).await;
    for _ in 0..2 {
        cx.update(|window, cx| window.dispatch_action(Box::new(AddCursorBelow), cx))
            .ok();
        pause(cx, 300).await;
    }
    cx.update(|window, cx| window.dispatch_action(Box::new(Delete), cx))
        .ok();
    pause(cx, 500).await;
    let after = line_texts(left, &rows, cx);
    let shorter: Vec<usize> = before
        .iter()
        .zip(&after)
        .map(|(before, after)| before.len().saturating_sub(after.len()))
        .collect();
    eprintln!("multi_cursor rows=9..13 chars_removed_per_row={shorter:?} expect=[0,1,1,1,0]");
}

async fn find_replace(left: &Entity<EditorState>, cx: &mut AsyncWindowContext) {
    let started = Instant::now();
    let matches = cx
        .update(|_, cx| {
            left.update(cx, |state, cx| {
                state.set_search_query("compute", false, cx);
            });
        })
        .ok();
    pause(cx, 1500).await;
    let count = cx
        .update(|_, cx| left.read(cx).search_session().matcher.len())
        .unwrap_or(0);
    let find_ms = started.elapsed().as_millis();
    let replace_started = Instant::now();
    let replaced = cx
        .update(|window, cx| {
            left.update(cx, |state, cx| {
                state.replace_all_search_matches("calc", window, cx)
            })
        })
        .unwrap_or(0);
    let replace_ms = replace_started.elapsed().as_millis();
    pause(cx, 1500).await;
    let first = line_texts(left, &[0], cx);
    eprintln!(
        "find_replace ran={} matches={count} find_ms={find_ms} replaced={replaced} replace_ms={replace_ms} first_line={first:?}",
        matches.is_some()
    );
}

async fn scroll_sync(
    left: &Entity<EditorState>,
    right: &Entity<EditorState>,
    cx: &mut AsyncWindowContext,
) {
    for target in [-30000.0_f32, -90000.0, -1000.0] {
        cx.update(|_, cx| {
            left.update(cx, |state, cx| {
                state.set_scroll_offset(point(px(0.), px(target)), cx)
            });
        })
        .ok();
        pause(cx, 1500).await;
        let offsets = cx
            .update(|_, cx| {
                (
                    left.read(cx).scroll_offset(),
                    right.read(cx).scroll_offset(),
                )
            })
            .ok();
        eprintln!("scroll_sync target_y={target} left_right={offsets:?}");
    }
}

pub async fn language_server(left: Entity<EditorState>, file: String, cx: &mut AsyncWindowContext) {
    let env = |name: &str| std::env::var(name).unwrap_or_default();
    let mut command = env("SPIKE_LSP_COMMAND")
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let program = command.remove(0);
    let launch = ServerLaunch {
        program,
        args: command,
        root: env("SPIKE_LSP_ROOT"),
        initialization_options: serde_json::from_str(&env("SPIKE_LSP_INIT")).unwrap_or(Value::Null),
    };
    let uri = format!("file://{file}");
    let language_id = env("SPIKE_LSP_LANGUAGE_ID");
    let text = std::fs::read_to_string(&file).unwrap_or_default();
    let started = Instant::now();
    let client = cx
        .background_executor()
        .spawn({
            let uri = uri.clone();
            async move {
                let client = LspClient::start(&launch)?;
                client.open_document(&uri, &language_id, &text)?;
                anyhow::Ok(client)
            }
        })
        .await;
    let client = match client {
        Ok(client) => Arc::new(client),
        Err(error) => {
            eprintln!("lsp start_failed={error:#}");
            cx.update(|_, cx| cx.quit()).ok();
            return;
        }
    };
    eprintln!("lsp initialized_ms={}", started.elapsed().as_millis());
    let provider = Rc::new(ServerDocument::new(client.clone(), uri));
    cx.update(|_, cx| {
        left.update(cx, |state, _| {
            let lsp = state.lsp_mut();
            lsp.completion_provider = Some(provider.clone());
            lsp.hover_provider = Some(provider.clone());
        });
    })
    .ok();
    let position = |name: &str| {
        let value = env(name);
        let (line, column) = value.split_once(':').unwrap_or(("0", "0"));
        Position::new(line.parse().unwrap_or(0), column.parse().unwrap_or(0))
    };
    let completion_at = position("SPIKE_LSP_COMPLETE");
    let hover_at = position("SPIKE_LSP_HOVER");

    let completion_started = Instant::now();
    let completion = cx
        .update(|window, cx| {
            let state = left.read(cx);
            let text = state.text().clone();
            let offset = text.position_to_offset(&completion_at);
            let provider = state.lsp().completion_provider.clone()?;
            Some(provider.completions(
                &text,
                offset,
                CompletionContext {
                    trigger_kind: CompletionTriggerKind::INVOKED,
                    trigger_character: None,
                },
                window,
                cx,
            ))
        })
        .ok()
        .flatten();
    if let Some(task) = completion {
        match task.await {
            Ok(response) => {
                let items = match response {
                    CompletionResponse::Array(items) => items,
                    CompletionResponse::List(list) => list.items,
                };
                let labels: Vec<&str> = items
                    .iter()
                    .take(5)
                    .map(|item| item.label.as_str())
                    .collect();
                eprintln!(
                    "lsp completion_ms={} items={} first={labels:?}",
                    completion_started.elapsed().as_millis(),
                    items.len()
                );
            }
            Err(error) => eprintln!("lsp completion_failed={error:#}"),
        }
    }

    let hover_started = Instant::now();
    let hover = cx
        .update(|window, cx| {
            let state = left.read(cx);
            let text = state.text().clone();
            let offset = text.position_to_offset(&hover_at);
            let provider = state.lsp().hover_provider.clone()?;
            Some(provider.hover(&text, offset, window, cx))
        })
        .ok()
        .flatten();
    if let Some(task) = hover {
        match task.await {
            Ok(Some(hover)) => {
                let contents = serde_json::to_string(&hover.contents).unwrap_or_default();
                let shown: String = contents.chars().take(160).collect();
                eprintln!(
                    "lsp hover_ms={} contents={shown}",
                    hover_started.elapsed().as_millis()
                );
            }
            Ok(None) => eprintln!("lsp hover=none"),
            Err(error) => eprintln!("lsp hover_failed={error:#}"),
        }
    }
    cx.update(|_, cx| cx.quit()).ok();
}

async fn next_frame(cx: &mut AsyncWindowContext) {
    let done = Rc::new(Cell::new(false));
    let flag = done.clone();
    cx.on_next_frame(move |_, _| flag.set(true));
    while !done.get() {
        cx.background_executor()
            .timer(Duration::from_micros(500))
            .await;
    }
}

fn summary(label: &str, mut milliseconds: Vec<f64>) {
    milliseconds.sort_by(f64::total_cmp);
    let last = milliseconds.len().saturating_sub(1);
    let at = |share: usize| milliseconds.get((milliseconds.len() * share / 100).min(last));
    eprintln!(
        "latency {label} n={} p50_ms={:.1?} p95_ms={:.1?} max_ms={:.1?}",
        milliseconds.len(),
        at(50),
        at(95),
        milliseconds.last()
    );
}

pub async fn latency(left: Entity<EditorState>, cx: &mut AsyncWindowContext) {
    pause(cx, 5000).await;
    cx.update(|window, cx| {
        left.update(cx, |state, cx| {
            state.set_cursor_position(Position::new(20, 0), window, cx)
        });
    })
    .ok();
    next_frame(cx).await;
    pause(cx, 500).await;
    let mut typing = Vec::new();
    for _ in 0..100 {
        let started = Instant::now();
        cx.update(|window, cx| {
            left.update(cx, |state, cx| state.insert("a", window, cx));
        })
        .ok();
        next_frame(cx).await;
        typing.push(started.elapsed().as_secs_f64() * 1000.0);
        pause(cx, 20).await;
    }
    summary("typing_to_frame", typing);
    let mut scrolling = Vec::new();
    for _ in 0..60 {
        let started = Instant::now();
        cx.update(|_, cx| {
            left.update(cx, |state, cx| {
                let offset = state.scroll_offset();
                state.set_scroll_offset(point(offset.x, offset.y - px(4000.)), cx)
            });
        })
        .ok();
        next_frame(cx).await;
        scrolling.push(started.elapsed().as_secs_f64() * 1000.0);
        pause(cx, 20).await;
    }
    summary("scroll_step_to_frame", scrolling);
    cx.update(|_, cx| cx.quit()).ok();
}
