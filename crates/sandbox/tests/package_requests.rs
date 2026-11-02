#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt;
use ostia_base::WorkspaceId;
use ostia_contract::approvals::{ApprovalAnswer, ApprovalOutcome};
use ostia_sandbox::package_policy::PackageBlockReason;
use ostia_sandbox::package_requests::{
    PackageAsk, PackageAskKind, PackageRequests, PackageRequestsDeps,
};
use ostia_sandbox::packages::{Ecosystem, PackageRef};
use parking_lot::Mutex;

struct Setup {
    requests: PackageRequests,
    asks: Arc<Mutex<Vec<PackageAsk>>>,
    stored: Arc<Mutex<Vec<String>>>,
    session: Arc<Mutex<Vec<String>>>,
}

fn pkg(name: &str) -> PackageRef {
    PackageRef {
        ecosystem: Ecosystem::Npm,
        name: name.to_owned(),
        version: "1.0.0".to_owned(),
    }
}

fn ws(id: &str) -> WorkspaceId {
    WorkspaceId::new(id)
}

fn setup(outcome: ApprovalOutcome) -> Setup {
    let asks = Arc::new(Mutex::new(Vec::new()));
    let stored = Arc::new(Mutex::new(Vec::new()));
    let session = Arc::new(Mutex::new(Vec::new()));
    let ask_log = asks.clone();
    let stored_log = stored.clone();
    let session_log = session.clone();
    let requests = PackageRequests::new(PackageRequestsDeps {
        ask: Arc::new(move |ask| {
            ask_log.lock().push(ask);
            async move { outcome }.boxed()
        }),
        allow_workspace: Arc::new(move |_workspace, key| stored_log.lock().push(key.to_owned())),
        allow_until_restart: Arc::new(move |_workspace, key| {
            session_log.lock().push(key.to_owned());
        }),
        batch_ms: 100,
    });
    Setup {
        requests,
        asks,
        stored,
        session,
    }
}

async fn advance(ms: u64) {
    tokio::time::advance(Duration::from_millis(ms)).await;
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test(start_paused = true)]
async fn sbx_c84_stores_an_allow_in_this_workspace_so_the_retry_and_later_installs_pass() {
    let s = setup(ApprovalOutcome::Answer(ApprovalAnswer::Workspace));
    s.requests
        .blocked(&ws("ws"), pkg("fresh"), PackageBlockReason::Cooldown);
    advance(150).await;
    assert_eq!(s.asks.lock().len(), 1);
    assert_eq!(*s.stored.lock(), vec!["npm:fresh@1.0.0".to_owned()]);
    s.requests
        .blocked(&ws("ws"), pkg("fresh"), PackageBlockReason::Cooldown);
    advance(150).await;
    assert_eq!(s.asks.lock().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn sbx_c85_warns_about_malware_and_never_stores_a_lasting_allowance_for_it() {
    let s = setup(ApprovalOutcome::Answer(ApprovalAnswer::Workspace));
    s.requests
        .blocked(&ws("ws"), pkg("evil"), PackageBlockReason::Malware);
    advance(150).await;
    assert_eq!(s.asks.lock()[0].kind, PackageAskKind::PackageMalware);
    assert!(s.stored.lock().is_empty());
    assert!(s.session.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn sbx_c86_groups_many_downloads_blocked_at_once_into_one_card_listing_them() {
    let s = setup(ApprovalOutcome::Answer(ApprovalAnswer::Deny));
    for i in 0..30 {
        s.requests.blocked(
            &ws("ws"),
            pkg(&format!("dep-{i}")),
            PackageBlockReason::Cooldown,
        );
    }
    advance(150).await;
    let asks = s.asks.lock();
    assert_eq!(asks.len(), 1);
    assert_eq!(asks[0].packages.len(), 30);
    assert_eq!(asks[0].kind, PackageAskKind::Package);
}

#[tokio::test(start_paused = true)]
async fn waits_for_the_batch_time_before_it_asks() {
    let s = setup(ApprovalOutcome::Answer(ApprovalAnswer::Deny));
    s.requests
        .blocked(&ws("ws"), pkg("fresh"), PackageBlockReason::Cooldown);
    advance(99).await;
    assert!(s.asks.lock().is_empty());
    advance(1).await;
    assert_eq!(s.asks.lock().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn lists_one_item_for_a_version_blocked_twice_in_a_batch() {
    let s = setup(ApprovalOutcome::Answer(ApprovalAnswer::Deny));
    s.requests
        .blocked(&ws("ws"), pkg("fresh"), PackageBlockReason::Cooldown);
    s.requests
        .blocked(&ws("ws"), pkg("fresh"), PackageBlockReason::Cooldown);
    advance(150).await;
    let asks = s.asks.lock();
    assert_eq!(asks.len(), 1);
    assert_eq!(asks[0].packages.len(), 1);
}

#[tokio::test(start_paused = true)]
async fn asks_malware_first_and_on_its_own_card_apart_from_the_other_blocks() {
    let s = setup(ApprovalOutcome::Answer(ApprovalAnswer::Deny));
    s.requests
        .blocked(&ws("ws"), pkg("slow"), PackageBlockReason::Cooldown);
    s.requests
        .blocked(&ws("ws"), pkg("evil"), PackageBlockReason::Malware);
    s.requests
        .blocked(&ws("ws"), pkg("other"), PackageBlockReason::DenyList);
    advance(150).await;
    let asks = s.asks.lock();
    assert_eq!(asks.len(), 2);
    assert_eq!(asks[0].kind, PackageAskKind::PackageMalware);
    assert_eq!(asks[0].packages.len(), 1);
    assert_eq!(asks[0].packages[0].ref_.name, "evil");
    assert_eq!(asks[0].packages[0].reason, PackageBlockReason::Malware);
    assert_eq!(asks[1].kind, PackageAskKind::Package);
    assert_eq!(asks[1].packages.len(), 2);
    assert_eq!(asks[1].workspace_id, ws("ws"));
}

#[tokio::test(start_paused = true)]
async fn allows_until_restart_for_a_session_answer_but_not_for_malware() {
    let s = setup(ApprovalOutcome::Answer(ApprovalAnswer::Session));
    s.requests
        .blocked(&ws("ws"), pkg("fresh"), PackageBlockReason::Cooldown);
    s.requests
        .blocked(&ws("ws"), pkg("evil"), PackageBlockReason::Malware);
    advance(150).await;
    assert_eq!(*s.session.lock(), vec!["npm:fresh@1.0.0".to_owned()]);
    assert!(s.stored.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn allows_until_restart_for_a_once_answer_also_for_malware() {
    let s = setup(ApprovalOutcome::Answer(ApprovalAnswer::Once));
    s.requests
        .blocked(&ws("ws"), pkg("fresh"), PackageBlockReason::Cooldown);
    s.requests
        .blocked(&ws("ws"), pkg("evil"), PackageBlockReason::Malware);
    advance(150).await;
    let mut session = s.session.lock().clone();
    session.sort();
    assert_eq!(
        session,
        vec!["npm:evil@1.0.0".to_owned(), "npm:fresh@1.0.0".to_owned()]
    );
    assert!(s.stored.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn stores_nothing_for_a_deny_a_timeout_an_auto_or_an_always_answer() {
    let answers = [
        ApprovalOutcome::Answer(ApprovalAnswer::Deny),
        ApprovalOutcome::Timeout,
        ApprovalOutcome::Auto,
        ApprovalOutcome::Answer(ApprovalAnswer::Always),
    ];
    for outcome in answers {
        let s = setup(outcome);
        s.requests
            .blocked(&ws("ws"), pkg("fresh"), PackageBlockReason::Cooldown);
        advance(150).await;
        assert_eq!(s.asks.lock().len(), 1, "{outcome:?}");
        assert!(s.stored.lock().is_empty(), "{outcome:?}");
        assert!(s.session.lock().is_empty(), "{outcome:?}");
    }
}

#[tokio::test(start_paused = true)]
async fn does_not_ask_again_for_a_version_the_human_denied() {
    let s = setup(ApprovalOutcome::Answer(ApprovalAnswer::Deny));
    s.requests
        .blocked(&ws("ws"), pkg("fresh"), PackageBlockReason::Cooldown);
    advance(150).await;
    s.requests
        .blocked(&ws("ws"), pkg("fresh"), PackageBlockReason::Cooldown);
    advance(150).await;
    assert_eq!(s.asks.lock().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn keeps_the_batches_and_the_asked_versions_of_each_workspace_apart() {
    let s = setup(ApprovalOutcome::Answer(ApprovalAnswer::Deny));
    s.requests
        .blocked(&ws("a"), pkg("fresh"), PackageBlockReason::Cooldown);
    s.requests
        .blocked(&ws("b"), pkg("fresh"), PackageBlockReason::Cooldown);
    advance(150).await;
    let asks = s.asks.lock();
    assert_eq!(asks.len(), 2);
    let mut ids: Vec<WorkspaceId> = asks.iter().map(|ask| ask.workspace_id.clone()).collect();
    ids.sort_by(|x, y| x.as_str().cmp(y.as_str()));
    assert_eq!(ids, vec![ws("a"), ws("b")]);
}

#[tokio::test(start_paused = true)]
async fn forgets_a_workspace_so_its_pending_batch_is_dropped_and_it_can_ask_again() {
    let s = setup(ApprovalOutcome::Answer(ApprovalAnswer::Deny));
    s.requests
        .blocked(&ws("ws"), pkg("fresh"), PackageBlockReason::Cooldown);
    advance(50).await;
    s.requests.forget(&ws("ws"));
    advance(200).await;
    assert!(s.asks.lock().is_empty());
    s.requests
        .blocked(&ws("ws"), pkg("fresh"), PackageBlockReason::Cooldown);
    advance(150).await;
    assert_eq!(s.asks.lock().len(), 1);
}
