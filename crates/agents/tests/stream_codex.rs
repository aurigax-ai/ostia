#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use ostia_agents::agent_stream::{StreamEnd, StreamEvent};
use ostia_agents::stream_codex::{
    CodexConnect, CodexNotice, CodexRequestError, CodexRpc, CodexSource, CodexSourceDeps,
    codex_source,
};
use ostia_agents::stream_source::{Emit, StreamSource};
use serde_json::{Value, json};
use tokio::sync::Notify;

fn ev(value: Value) -> StreamEvent {
    serde_json::from_value(value).unwrap()
}

fn evs(values: Vec<Value>) -> Vec<StreamEvent> {
    values.into_iter().map(ev).collect()
}

#[derive(Default)]
struct Script {
    resume: VecDeque<Result<Value, String>>,
    list: VecDeque<Result<Value, String>>,
}

struct FakeRpc {
    script: Mutex<Script>,
    calls: Mutex<Vec<(String, Value)>>,
    closes: AtomicUsize,
    ended: Arc<Notify>,
}

impl FakeRpc {
    fn new(script: Script) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(script),
            calls: Mutex::default(),
            closes: AtomicUsize::new(0),
            ended: Arc::new(Notify::new()),
        })
    }

    fn calls_of(&self, method: &str) -> Vec<Value> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == method)
            .map(|(_, params)| params.clone())
            .collect()
    }

    fn methods(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|(name, _)| name.clone())
            .collect()
    }
}

impl CodexRpc for FakeRpc {
    fn request(
        &self,
        method: &str,
        params: Value,
    ) -> BoxFuture<'static, Result<Value, CodexRequestError>> {
        self.calls.lock().unwrap().push((method.to_owned(), params));
        let mut script = self.script.lock().unwrap();
        let queue = if method == "thread/resume" {
            &mut script.resume
        } else {
            &mut script.list
        };
        let fallback = if method == "thread/resume" {
            Ok(json!({}))
        } else {
            Ok(json!({"data": []}))
        };
        let reply = queue
            .pop_front()
            .unwrap_or(fallback)
            .map_err(CodexRequestError::new);
        async move { reply }.boxed()
    }

    fn close(&self) {
        self.closes.fetch_add(1, Ordering::SeqCst);
    }

    fn closed(&self) -> BoxFuture<'static, ()> {
        let ended = Arc::clone(&self.ended);
        async move { ended.notified().await }.boxed()
    }
}

type Batches = Arc<Mutex<Vec<Vec<StreamEvent>>>>;

fn sink() -> (Emit, Batches) {
    let batches: Batches = Arc::default();
    let held = Arc::clone(&batches);
    (
        Arc::new(move |events| held.lock().unwrap().push(events)),
        batches,
    )
}

struct Rig {
    rpc: Arc<FakeRpc>,
    source: CodexSource,
    notice: Arc<Mutex<Option<CodexNotice>>>,
    ended: Arc<Mutex<Vec<StreamEnd>>>,
}

impl Rig {
    fn notify(&self, method: &str, params: Value) {
        let notice = self.notice.lock().unwrap().clone().unwrap();
        notice(method, &params);
    }
}

fn rig(script: Script) -> Rig {
    let rpc = FakeRpc::new(script);
    let notice: Arc<Mutex<Option<CodexNotice>>> = Arc::default();
    let ended: Arc<Mutex<Vec<StreamEnd>>> = Arc::default();
    let connect_rpc = Arc::clone(&rpc);
    let connect_slot = Arc::clone(&notice);
    let connect: CodexConnect = Box::new(move |on_notice| {
        *connect_slot.lock().unwrap() = Some(on_notice);
        let client: Arc<dyn CodexRpc> = connect_rpc.clone();
        async move { Ok(client) }.boxed()
    });
    let closed_slot = Arc::clone(&ended);
    let source = codex_source(CodexSourceDeps {
        thread_id: "th1".to_owned(),
        connect,
        closed: Box::new(move |reason| closed_slot.lock().unwrap().push(reason)),
    });
    Rig {
        rpc,
        source,
        notice,
        ended,
    }
}

fn no_rollout() -> Result<Value, String> {
    Err("No Rollout found for thread th1".to_owned())
}

fn user_turn(id: &str, user: &str, reply: &str, status: &str) -> Value {
    json!({
        "id": id,
        "status": status,
        "items": [
            {"type": "userMessage", "id": format!("u-{id}"), "content": [{"type": "text", "text": user}]},
            {"type": "agentMessage", "id": format!("a-{id}"), "text": reply}
        ]
    })
}

fn turn_events(id: &str, user: &str, reply: &str) -> Vec<Value> {
    vec![
        json!({"type": "turn.started", "turn": id}),
        json!({"type": "prompt", "turn": id, "id": format!("u-{id}"), "text": user}),
        json!({"type": "text", "turn": id, "id": format!("a-{id}"), "text": reply}),
        json!({"type": "turn.ended", "turn": id, "status": "done"}),
    ]
}

fn listing(turns: Vec<Value>) -> Result<Value, String> {
    Ok(json!({"data": turns}))
}

async fn settle() {
    for _ in 0..30 {
        tokio::task::yield_now().await;
    }
}

async fn tick(ms: u64) {
    tokio::time::advance(Duration::from_millis(ms)).await;
    settle().await;
}

#[tokio::test(start_paused = true)]
async fn resumes_the_thread_and_lists_the_stored_turns_oldest_first() {
    let r = rig(Script {
        list: VecDeque::from([listing(vec![
            user_turn("t2", "second", "reply two", "completed"),
            user_turn("t1", "first", "reply one", "completed"),
        ])]),
        ..Script::default()
    });
    let backfill = r.source.backfill(5).await.unwrap();
    let mut expected = turn_events("t1", "first", "reply one");
    expected.extend(turn_events("t2", "second", "reply two"));
    assert_eq!(backfill.events, evs(expected));
    assert!(!backfill.truncated);
    assert_eq!(
        r.rpc.calls_of("thread/resume"),
        vec![json!({"threadId": "th1", "excludeTurns": true})]
    );
    assert_eq!(
        r.rpc.calls_of("thread/turns/list"),
        vec![json!({
            "threadId": "th1",
            "limit": 5,
            "itemsView": "full",
            "sortDirection": "desc"
        })]
    );
    assert_eq!(r.rpc.methods(), ["thread/resume", "thread/turns/list"]);
}

#[tokio::test(start_paused = true)]
async fn keeps_only_the_last_turns_that_were_asked_for() {
    let r = rig(Script {
        list: VecDeque::from([listing(vec![
            user_turn("t2", "second", "reply two", "completed"),
            user_turn("t1", "first", "reply one", "completed"),
        ])]),
        ..Script::default()
    });
    let backfill = r.source.backfill(1).await.unwrap();
    assert_eq!(
        backfill.events,
        evs(turn_events("t2", "second", "reply two"))
    );
}

#[tokio::test(start_paused = true)]
async fn drops_the_trailing_message_of_a_turn_that_is_still_running() {
    let r = rig(Script {
        list: VecDeque::from([listing(vec![user_turn(
            "t3",
            "go",
            "partial",
            "inProgress",
        )])]),
        ..Script::default()
    });
    let backfill = r.source.backfill(5).await.unwrap();
    assert_eq!(
        backfill.events,
        evs(vec![
            json!({"type": "turn.started", "turn": "t3"}),
            json!({"type": "prompt", "turn": "t3", "id": "u-t3", "text": "go"}),
        ])
    );
}

#[tokio::test(start_paused = true)]
async fn keeps_the_items_of_a_running_turn_that_does_not_end_in_a_message() {
    let turn = json!({
        "id": "t4",
        "status": "inProgress",
        "items": [
            {"type": "userMessage", "id": "u4", "content": [{"type": "text", "text": "list"}]},
            {"type": "commandExecution", "id": "c1", "command": "ls", "status": "completed",
             "exitCode": 0, "aggregatedOutput": "a b"}
        ]
    });
    let r = rig(Script {
        list: VecDeque::from([listing(vec![turn])]),
        ..Script::default()
    });
    let backfill = r.source.backfill(5).await.unwrap();
    assert_eq!(
        backfill.events,
        evs(vec![
            json!({"type": "turn.started", "turn": "t4"}),
            json!({"type": "prompt", "turn": "t4", "id": "u4", "text": "list"}),
            json!({"type": "tool", "turn": "t4", "id": "c1", "kind": "command",
                   "name": "shell", "input": "ls"}),
            json!({"type": "tool.result", "turn": "t4", "id": "c1", "output": "a b", "exitCode": 0}),
        ])
    );
}

#[tokio::test(start_paused = true)]
async fn backfills_nothing_when_the_thread_has_no_rollout_yet() {
    let r = rig(Script {
        resume: VecDeque::from([no_rollout()]),
        list: VecDeque::from([no_rollout()]),
    });
    let backfill = r.source.backfill(5).await.unwrap();
    assert!(backfill.events.is_empty());
    assert!(!backfill.truncated);
}

#[tokio::test(start_paused = true)]
async fn fails_the_backfill_when_resuming_fails_for_another_reason() {
    let r = rig(Script {
        resume: VecDeque::from([Err("boom".to_owned())]),
        ..Script::default()
    });
    assert!(r.source.backfill(5).await.is_err());
}

#[tokio::test(start_paused = true)]
async fn fails_the_backfill_when_listing_fails_for_another_reason() {
    let r = rig(Script {
        list: VecDeque::from([Err("boom".to_owned())]),
        ..Script::default()
    });
    assert!(r.source.backfill(5).await.is_err());
}

#[tokio::test(start_paused = true)]
async fn holds_notices_that_arrive_before_live_and_sends_them_in_one_batch() {
    let r = rig(Script::default());
    r.source.backfill(5).await.unwrap();
    r.notify(
        "turn/started",
        json!({"threadId": "th1", "turn": {"id": "t9"}}),
    );
    r.notify(
        "item/agentMessage/delta",
        json!({"threadId": "th1", "turnId": "t9", "itemId": "a9", "delta": "hel"}),
    );
    let (emit, batches) = sink();
    r.source.live(emit);
    assert_eq!(
        *batches.lock().unwrap(),
        vec![evs(vec![
            json!({"type": "turn.started", "turn": "t9"}),
            json!({"type": "text", "turn": "t9", "id": "a9", "text": "hel", "append": true}),
        ])]
    );
}

#[tokio::test(start_paused = true)]
async fn drops_a_held_notice_that_the_backfill_already_showed() {
    let r = rig(Script {
        list: VecDeque::from([listing(vec![user_turn("t1", "first", "one", "completed")])]),
        ..Script::default()
    });
    r.source.backfill(5).await.unwrap();
    r.notify(
        "turn/started",
        json!({"threadId": "th1", "turn": {"id": "t1"}}),
    );
    let (emit, batches) = sink();
    r.source.live(emit);
    assert!(batches.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn sends_a_notice_straight_on_once_live() {
    let r = rig(Script::default());
    r.source.backfill(5).await.unwrap();
    let (emit, batches) = sink();
    r.source.live(emit);
    r.notify(
        "turn/started",
        json!({"threadId": "th1", "turn": {"id": "t5"}}),
    );
    assert_eq!(
        *batches.lock().unwrap(),
        vec![evs(vec![json!({"type": "turn.started", "turn": "t5"})])]
    );
}

#[tokio::test(start_paused = true)]
async fn ignores_notices_for_another_thread_and_notices_with_no_events() {
    let r = rig(Script::default());
    r.source.backfill(5).await.unwrap();
    let (emit, batches) = sink();
    r.source.live(emit);
    r.notify(
        "turn/started",
        json!({"threadId": "other", "turn": {"id": "t5"}}),
    );
    r.notify("turn/started", json!("not a record"));
    r.notify("something/else", json!({"threadId": "th1"}));
    r.notify(
        "item/agentMessage/delta",
        json!({"threadId": "th1", "delta": ""}),
    );
    assert!(batches.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn sends_a_turn_start_once_and_every_appended_delta() {
    let r = rig(Script::default());
    r.source.backfill(5).await.unwrap();
    let (emit, batches) = sink();
    r.source.live(emit);
    let start = json!({"threadId": "th1", "turn": {"id": "t5"}});
    let delta = json!({"threadId": "th1", "turnId": "t5", "itemId": "a5", "delta": "x"});
    r.notify("turn/started", start.clone());
    r.notify("turn/started", start);
    r.notify("item/agentMessage/delta", delta.clone());
    r.notify("item/agentMessage/delta", delta);
    let sent = batches.lock().unwrap();
    assert_eq!(sent.len(), 3);
    assert_eq!(
        sent[0],
        evs(vec![json!({"type": "turn.started", "turn": "t5"})])
    );
    assert_eq!(sent[1], sent[2]);
}

#[tokio::test(start_paused = true)]
async fn does_not_repeat_a_turn_start_or_end_that_the_backfill_showed() {
    let r = rig(Script {
        list: VecDeque::from([listing(vec![user_turn("t1", "first", "one", "completed")])]),
        ..Script::default()
    });
    r.source.backfill(5).await.unwrap();
    let (emit, batches) = sink();
    r.source.live(emit);
    r.notify(
        "turn/started",
        json!({"threadId": "th1", "turn": {"id": "t1"}}),
    );
    r.notify(
        "turn/completed",
        json!({"threadId": "th1", "turn": {"id": "t1", "status": "completed"}}),
    );
    assert!(batches.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn does_not_subscribe_again_when_the_thread_resumed() {
    let r = rig(Script::default());
    r.source.backfill(5).await.unwrap();
    let (emit, _batches) = sink();
    r.source.live(emit);
    tick(5000).await;
    assert_eq!(r.rpc.calls_of("thread/resume").len(), 1);
}

#[tokio::test(start_paused = true)]
async fn does_not_retry_before_live_starts() {
    let r = rig(Script {
        resume: VecDeque::from([no_rollout()]),
        list: VecDeque::from([no_rollout()]),
    });
    r.source.backfill(5).await.unwrap();
    tick(5000).await;
    assert_eq!(r.rpc.methods(), ["thread/resume", "thread/turns/list"]);
}

#[tokio::test(start_paused = true)]
async fn resubscribes_after_a_second_and_sends_the_turns_it_missed() {
    let r = rig(Script {
        resume: VecDeque::from([no_rollout(), Ok(json!({}))]),
        list: VecDeque::from([
            no_rollout(),
            listing(vec![user_turn("t1", "first", "one", "completed")]),
        ]),
    });
    r.source.backfill(5).await.unwrap();
    let (emit, batches) = sink();
    r.source.live(emit);
    tick(999).await;
    assert_eq!(r.rpc.calls_of("thread/resume").len(), 1);
    assert!(batches.lock().unwrap().is_empty());
    tick(1).await;
    assert_eq!(
        r.rpc.methods(),
        [
            "thread/resume",
            "thread/turns/list",
            "thread/resume",
            "thread/turns/list"
        ]
    );
    assert_eq!(
        r.rpc.calls_of("thread/turns/list")[1],
        json!({"threadId": "th1", "limit": 5, "itemsView": "full", "sortDirection": "desc"})
    );
    assert_eq!(
        *batches.lock().unwrap(),
        vec![evs(turn_events("t1", "first", "one"))]
    );
    tick(5000).await;
    assert_eq!(r.rpc.calls_of("thread/resume").len(), 2);
}

#[tokio::test(start_paused = true)]
async fn resubscribes_at_once_when_the_thread_status_changes() {
    let r = rig(Script {
        resume: VecDeque::from([no_rollout(), Ok(json!({}))]),
        list: VecDeque::from([
            no_rollout(),
            listing(vec![user_turn("t1", "first", "one", "completed")]),
        ]),
    });
    r.source.backfill(5).await.unwrap();
    let (emit, batches) = sink();
    r.source.live(emit);
    tick(100).await;
    r.notify("thread/status/changed", json!({"threadId": "th1"}));
    tick(0).await;
    assert_eq!(r.rpc.calls_of("thread/resume").len(), 2);
    assert_eq!(
        *batches.lock().unwrap(),
        vec![evs(turn_events("t1", "first", "one"))]
    );
    tick(5000).await;
    assert_eq!(r.rpc.calls_of("thread/resume").len(), 2);
}

#[tokio::test(start_paused = true)]
async fn ignores_a_status_change_before_live_starts() {
    let r = rig(Script {
        resume: VecDeque::from([no_rollout()]),
        list: VecDeque::from([no_rollout()]),
    });
    r.source.backfill(5).await.unwrap();
    r.notify("thread/status/changed", json!({"threadId": "th1"}));
    tick(5000).await;
    assert_eq!(r.rpc.calls_of("thread/resume").len(), 1);
}

#[tokio::test(start_paused = true)]
async fn gives_up_as_unavailable_after_three_hundred_failed_tries() {
    let r = rig(Script {
        resume: std::iter::repeat_n(no_rollout(), 400).collect(),
        list: VecDeque::from([no_rollout()]),
    });
    r.source.backfill(5).await.unwrap();
    let (emit, _batches) = sink();
    r.source.live(emit);
    for _ in 0..299 {
        tick(1000).await;
    }
    assert!(r.ended.lock().unwrap().is_empty());
    tick(1000).await;
    assert_eq!(*r.ended.lock().unwrap(), vec![StreamEnd::Unavailable]);
    assert_eq!(r.rpc.calls_of("thread/resume").len(), 301);
    tick(5000).await;
    assert_eq!(*r.ended.lock().unwrap(), vec![StreamEnd::Unavailable]);
    assert_eq!(r.rpc.calls_of("thread/resume").len(), 301);
}

#[tokio::test(start_paused = true)]
async fn reports_agent_closed_when_the_connection_ends() {
    let r = rig(Script::default());
    r.source.backfill(5).await.unwrap();
    r.rpc.ended.notify_one();
    settle().await;
    assert_eq!(*r.ended.lock().unwrap(), vec![StreamEnd::AgentClosed]);
}

#[tokio::test(start_paused = true)]
async fn reports_nothing_when_the_connection_ends_after_close() {
    let r = rig(Script::default());
    r.source.backfill(5).await.unwrap();
    r.source.close();
    r.rpc.ended.notify_one();
    settle().await;
    assert!(r.ended.lock().unwrap().is_empty());
    assert_eq!(r.rpc.closes.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn stops_a_pending_retry_when_closed() {
    let r = rig(Script {
        resume: VecDeque::from([no_rollout()]),
        list: VecDeque::from([no_rollout()]),
    });
    r.source.backfill(5).await.unwrap();
    let (emit, _batches) = sink();
    r.source.live(emit);
    r.source.close();
    tick(5000).await;
    assert_eq!(r.rpc.calls_of("thread/resume").len(), 1);
}

#[tokio::test(start_paused = true)]
async fn stops_delivering_notices_when_closed() {
    let r = rig(Script::default());
    r.source.backfill(5).await.unwrap();
    let (emit, batches) = sink();
    r.source.live(emit);
    r.source.close();
    r.notify(
        "turn/started",
        json!({"threadId": "th1", "turn": {"id": "t7"}}),
    );
    assert!(batches.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn closing_before_a_backfill_closes_no_connection() {
    let r = rig(Script::default());
    r.source.close();
    assert_eq!(r.rpc.closes.load(Ordering::SeqCst), 0);
}
