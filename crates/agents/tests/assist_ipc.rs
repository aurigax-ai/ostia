#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, join_all};
use ostia_agents::assist_ipc::{AssistCallOptions, AssistHost, AssistRouter, AssistSender};
use ostia_contract::assist::AssistPoint;
use parking_lot::Mutex;
use serde_json::{Value, json};

type Listener = Box<dyn FnOnce() + Send>;

struct FakeSender {
    id: u64,
    sent: Mutex<Vec<(String, Value)>>,
    listeners: Mutex<Vec<Listener>>,
    destroyed: Mutex<bool>,
}

impl FakeSender {
    fn new(id: u64) -> Arc<Self> {
        Arc::new(Self {
            id,
            sent: Mutex::new(Vec::new()),
            listeners: Mutex::new(Vec::new()),
            destroyed: Mutex::new(false),
        })
    }

    fn destroy(&self) {
        let listeners: Vec<Listener> = self.listeners.lock().drain(..).collect();
        for listener in listeners {
            listener();
        }
    }

    fn mark_destroyed(&self) {
        *self.destroyed.lock() = true;
    }

    fn sent(&self) -> Vec<(String, Value)> {
        self.sent.lock().clone()
    }

    fn watches(&self) -> usize {
        self.listeners.lock().len()
    }
}

impl AssistSender for FakeSender {
    fn id(&self) -> u64 {
        self.id
    }

    fn send(&self, channel: &str, payload: Value) {
        self.sent.lock().push((channel.to_owned(), payload));
    }

    fn is_destroyed(&self) -> bool {
        *self.destroyed.lock()
    }

    fn on_destroyed(&self, listener: Listener) {
        self.listeners.lock().push(listener);
    }
}

fn as_sender(sender: &Arc<FakeSender>) -> Arc<dyn AssistSender> {
    Arc::clone(sender) as Arc<dyn AssistSender>
}

struct HangingHost {
    calls: Mutex<Vec<(AssistPoint, Value, AssistCallOptions)>>,
}

impl HangingHost {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
        })
    }

    fn options(&self, index: usize) -> AssistCallOptions {
        self.calls.lock()[index].2.clone()
    }

    fn count(&self) -> usize {
        self.calls.lock().len()
    }
}

impl AssistHost for HangingHost {
    fn assist(
        &self,
        point: AssistPoint,
        input: Value,
        opts: AssistCallOptions,
    ) -> BoxFuture<'static, Value> {
        let token = opts.token.clone();
        self.calls.lock().push((point, input, opts));
        async move {
            token.cancelled().await;
            json!({"ok": false, "error": "cancelled"})
        }
        .boxed()
    }
}

struct ChunkingHost {
    chunks: Vec<&'static str>,
}

impl AssistHost for ChunkingHost {
    fn assist(
        &self,
        _point: AssistPoint,
        _input: Value,
        opts: AssistCallOptions,
    ) -> BoxFuture<'static, Value> {
        for chunk in &self.chunks {
            (opts.on_chunk)(chunk);
        }
        async { json!({"ok": true, "result": {"text": "hello"}}) }.boxed()
    }
}

fn router_of(host: Arc<dyn AssistHost>) -> AssistRouter {
    AssistRouter::new(move || Some(Arc::clone(&host)))
}

fn invalid() -> Value {
    json!({"ok": false, "error": "invalid"})
}

fn cancelled() -> Value {
    json!({"ok": false, "error": "cancelled"})
}

#[tokio::test]
async fn forwards_chunks_to_the_window_that_asked_tagged_with_its_request_id_and_counts_them() {
    let router = router_of(Arc::new(ChunkingHost {
        chunks: vec!["hel", "lo"],
    }));
    let sender = FakeSender::new(1);
    let res = router
        .request(
            as_sender(&sender),
            &json!("chat"),
            &json!("r1"),
            json!({"messages": []}),
            None,
        )
        .await;
    assert_eq!(
        res,
        json!({"ok": true, "result": {"text": "hello"}, "chunks": 2})
    );
    assert_eq!(
        sender.sent(),
        vec![
            (
                "assist:chunk".to_owned(),
                json!({"requestId": "r1", "text": "hel"})
            ),
            (
                "assist:chunk".to_owned(),
                json!({"requestId": "r1", "text": "lo"})
            ),
        ]
    );
}

#[tokio::test]
async fn passes_the_model_a_chat_picked_to_the_host_and_nothing_when_none_was_picked() {
    let host = HangingHost::new();
    let router = router_of(Arc::clone(&host) as Arc<dyn AssistHost>);
    let sender = FakeSender::new(1);
    let reference = json!({"extId": "assistant", "provider": "openai", "model": "gpt"});
    let picked = router.request(
        as_sender(&sender),
        &json!("chat"),
        &json!("r1"),
        json!({}),
        Some(reference.clone()),
    );
    let plain = router.request(
        as_sender(&sender),
        &json!("chat"),
        &json!("r2"),
        json!({}),
        None,
    );
    assert_eq!(host.options(0).model, Some(reference));
    assert_eq!(host.options(1).model, None);
    router.cancel(sender.id, &json!("r1"));
    router.cancel(sender.id, &json!("r2"));
    join_all([picked, plain]).await;
}

#[tokio::test]
async fn treats_a_null_model_as_none_picked() {
    let host = HangingHost::new();
    let router = router_of(Arc::clone(&host) as Arc<dyn AssistHost>);
    let sender = FakeSender::new(1);
    let pending = router.request(
        as_sender(&sender),
        &json!("chat"),
        &json!("r1"),
        json!({}),
        Some(Value::Null),
    );
    assert_eq!(host.options(0).model, None);
    router.cancel(sender.id, &json!("r1"));
    pending.await;
}

#[tokio::test]
async fn cancels_only_the_named_request_of_the_same_window() {
    let host = HangingHost::new();
    let router = router_of(Arc::clone(&host) as Arc<dyn AssistHost>);
    let sender = FakeSender::new(1);
    let pending = router.request(
        as_sender(&sender),
        &json!("chat"),
        &json!("r1"),
        json!({}),
        None,
    );
    router.cancel(2, &json!("r1"));
    assert!(!host.options(0).token.is_cancelled());
    router.cancel(1, &json!("r1"));
    assert_eq!(pending.await, cancelled());
    assert_eq!(router.pending(), 0);
}

#[tokio::test]
async fn ignores_a_cancel_whose_request_id_is_not_a_string() {
    let host = HangingHost::new();
    let router = router_of(Arc::clone(&host) as Arc<dyn AssistHost>);
    let sender = FakeSender::new(1);
    let pending = router.request(
        as_sender(&sender),
        &json!("chat"),
        &json!("r1"),
        json!({}),
        None,
    );
    router.cancel(1, &json!(1));
    router.cancel(1, &Value::Null);
    assert!(!host.options(0).token.is_cancelled());
    router.cancel(1, &json!("r1"));
    pending.await;
}

#[tokio::test]
async fn cancels_everything_a_closed_window_left_running() {
    let host = HangingHost::new();
    let router = router_of(Arc::clone(&host) as Arc<dyn AssistHost>);
    let sender = FakeSender::new(1);
    let one = router.request(
        as_sender(&sender),
        &json!("chat"),
        &json!("r1"),
        json!({}),
        None,
    );
    let two = router.request(
        as_sender(&sender),
        &json!("command"),
        &json!("r2"),
        json!({}),
        None,
    );
    sender.destroy();
    assert_eq!(join_all([one, two]).await, vec![cancelled(), cancelled()]);
}

#[tokio::test]
async fn leaves_the_requests_of_other_windows_running_when_one_window_closes() {
    let host = HangingHost::new();
    let router = router_of(Arc::clone(&host) as Arc<dyn AssistHost>);
    let first = FakeSender::new(1);
    let second = FakeSender::new(2);
    let one = router.request(
        as_sender(&first),
        &json!("chat"),
        &json!("r1"),
        json!({}),
        None,
    );
    let two = router.request(
        as_sender(&second),
        &json!("chat"),
        &json!("r1"),
        json!({}),
        None,
    );
    first.destroy();
    assert_eq!(one.await, cancelled());
    assert!(!host.options(1).token.is_cancelled());
    assert_eq!(router.pending(), 1);
    router.cancel(2, &json!("r1"));
    two.await;
}

#[tokio::test]
async fn watches_a_window_once_and_again_after_it_was_destroyed() {
    let host = HangingHost::new();
    let router = router_of(Arc::clone(&host) as Arc<dyn AssistHost>);
    let sender = FakeSender::new(1);
    let one = router.request(
        as_sender(&sender),
        &json!("chat"),
        &json!("r1"),
        json!({}),
        None,
    );
    let two = router.request(
        as_sender(&sender),
        &json!("chat"),
        &json!("r2"),
        json!({}),
        None,
    );
    assert_eq!(sender.watches(), 1);
    sender.destroy();
    join_all([one, two]).await;
    let again = router.request(
        as_sender(&sender),
        &json!("chat"),
        &json!("r3"),
        json!({}),
        None,
    );
    assert_eq!(sender.watches(), 1);
    router.cancel(1, &json!("r3"));
    again.await;
}

#[tokio::test]
async fn sends_and_counts_no_chunk_once_the_window_is_destroyed() {
    let sender = FakeSender::new(1);
    sender.mark_destroyed();
    let router = router_of(Arc::new(ChunkingHost {
        chunks: vec!["a", "b"],
    }));
    let res = router
        .request(
            as_sender(&sender),
            &json!("chat"),
            &json!("r1"),
            json!({}),
            None,
        )
        .await;
    assert_eq!(res, json!({"ok": true, "result": {"text": "hello"}}));
    assert_eq!(sender.sent(), Vec::<(String, Value)>::new());
}

#[tokio::test]
async fn refuses_unknown_points_bad_or_duplicate_ids_and_too_many_requests() {
    let host = HangingHost::new();
    let router = router_of(Arc::clone(&host) as Arc<dyn AssistHost>);
    let sender = FakeSender::new(1);
    let ask =
        |point: Value, id: Value| router.request(as_sender(&sender), &point, &id, json!({}), None);
    assert_eq!(ask(json!("shell"), json!("r1")).await, invalid());
    assert_eq!(ask(json!("chat"), json!("bad id!")).await, invalid());
    assert_eq!(ask(json!("chat"), json!(7)).await, invalid());
    assert_eq!(ask(json!(null), json!("r1")).await, invalid());
    let open: Vec<_> = (0..8)
        .map(|i| ask(json!("chat"), json!(format!("q{i}"))))
        .collect();
    assert_eq!(ask(json!("chat"), json!("q0")).await, invalid());
    assert_eq!(
        ask(json!("chat"), json!("q9")).await,
        json!({"ok": false, "error": "busy"})
    );
    assert_eq!(host.count(), 8);
    for i in 0..8 {
        router.cancel(sender.id, &json!(format!("q{i}")));
    }
    join_all(open).await;
}

#[tokio::test]
async fn counts_the_open_requests_of_each_window_on_its_own_and_frees_a_slot_when_one_ends() {
    let host = HangingHost::new();
    let router = router_of(Arc::clone(&host) as Arc<dyn AssistHost>);
    let first = FakeSender::new(1);
    let second = FakeSender::new(11);
    let open: Vec<_> = (0..8)
        .map(|i| {
            router.request(
                as_sender(&first),
                &json!("chat"),
                &json!(format!("q{i}")),
                json!({}),
                None,
            )
        })
        .collect();
    let other = router.request(
        as_sender(&second),
        &json!("chat"),
        &json!("q0"),
        json!({}),
        None,
    );
    assert_eq!(host.count(), 9);
    router.cancel(1, &json!("q0"));
    let mut open = open.into_iter();
    open.next().unwrap().await;
    let reused = router.request(
        as_sender(&first),
        &json!("chat"),
        &json!("q0"),
        json!({}),
        None,
    );
    assert_eq!(host.count(), 10);
    for i in 0..8 {
        router.cancel(1, &json!(format!("q{i}")));
    }
    router.cancel(11, &json!("q0"));
    join_all(
        open.chain(std::iter::once(other))
            .chain(std::iter::once(reused)),
    )
    .await;
    assert_eq!(router.pending(), 0);
}

#[tokio::test]
async fn answers_unavailable_without_a_host() {
    let router = AssistRouter::new(|| None);
    let sender = FakeSender::new(1);
    let res = router
        .request(
            as_sender(&sender),
            &json!("chat"),
            &json!("r1"),
            json!({}),
            None,
        )
        .await;
    assert_eq!(res, json!({"ok": false, "error": "unavailable"}));
    assert_eq!(sender.watches(), 0);
}

#[tokio::test]
async fn answers_unavailable_before_it_checks_the_point_and_the_id() {
    let router = AssistRouter::new(|| None);
    let sender = FakeSender::new(1);
    let res = router
        .request(
            as_sender(&sender),
            &json!("shell"),
            &json!("bad id!"),
            json!({}),
            None,
        )
        .await;
    assert_eq!(res, json!({"ok": false, "error": "unavailable"}));
}
