#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ostia_approvals::approvals::{ApprovalAsk, ApprovalDeps, Approvals, create_approvals};
use ostia_base::ExternalId;
use ostia_contract::approvals::{
    ApprovalAnswer, ApprovalKind, ApprovalMode, ApprovalOutcome, ApprovalState,
};
use ostia_contract::capabilities::Capability;
use parking_lot::Mutex;
use serde_json::json;
use tokio::task::JoinHandle;

const ONCE: ApprovalOutcome = ApprovalOutcome::Answer(ApprovalAnswer::Once);
const SESSION: ApprovalOutcome = ApprovalOutcome::Answer(ApprovalAnswer::Session);
const ALWAYS: ApprovalOutcome = ApprovalOutcome::Answer(ApprovalAnswer::Always);
const WORKSPACE: ApprovalOutcome = ApprovalOutcome::Answer(ApprovalAnswer::Workspace);
const DENY: ApprovalOutcome = ApprovalOutcome::Answer(ApprovalAnswer::Deny);

fn ask() -> ApprovalAsk {
    ApprovalAsk {
        external_id: ExternalId::new("ext-1"),
        window_id: "7".to_owned(),
        pane_id: "p1".to_owned(),
        workspace_id: "w1".to_owned(),
        caps: vec![Capability::Shell],
        action: "command.exec agent.resume".to_owned(),
        detail: "{}".to_owned(),
        kind: None,
        subject: None,
    }
}

fn with_caps(caps: Vec<Capability>) -> ApprovalAsk {
    ApprovalAsk { caps, ..ask() }
}

fn with_kind(kind: ApprovalKind) -> ApprovalAsk {
    ApprovalAsk {
        caps: vec![],
        kind: Some(kind),
        ..ask()
    }
}

type Published = Arc<Mutex<Vec<(String, ApprovalState)>>>;
type Calls = Arc<Mutex<Vec<(String, Capability)>>>;

struct Rig {
    approvals: Approvals,
    published: Published,
    grants: Calls,
    revokes: Calls,
    reveals: Arc<Mutex<Vec<String>>>,
    always_calls: Arc<Mutex<Vec<Vec<Capability>>>>,
    always_result: Arc<AtomicBool>,
    mode: Arc<Mutex<ApprovalMode>>,
    opened: Arc<Mutex<Vec<String>>>,
    settled: Arc<Mutex<Vec<(String, ApprovalOutcome)>>>,
}

fn setup(mode: ApprovalMode, window_open: bool) -> Rig {
    let published: Published = Arc::default();
    let grants: Calls = Arc::default();
    let revokes: Calls = Arc::default();
    let reveals: Arc<Mutex<Vec<String>>> = Arc::default();
    let always_calls: Arc<Mutex<Vec<Vec<Capability>>>> = Arc::default();
    let always_result = Arc::new(AtomicBool::new(true));
    let current_mode = Arc::new(Mutex::new(mode));
    let opened: Arc<Mutex<Vec<String>>> = Arc::default();
    let settled: Arc<Mutex<Vec<(String, ApprovalOutcome)>>> = Arc::default();
    let approvals = create_approvals(ApprovalDeps {
        mode: Box::new({
            let current_mode = Arc::clone(&current_mode);
            move || *current_mode.lock()
        }),
        publish: Box::new({
            let published = Arc::clone(&published);
            move |window_id, state| {
                published.lock().push((window_id.to_owned(), state.clone()));
                window_open
            }
        }),
        grant: Box::new({
            let grants = Arc::clone(&grants);
            move |external_id, cap| grants.lock().push((external_id.as_str().to_owned(), cap))
        }),
        revoke: Box::new({
            let revokes = Arc::clone(&revokes);
            move |external_id, cap| revokes.lock().push((external_id.as_str().to_owned(), cap))
        }),
        always: Box::new({
            let always_calls = Arc::clone(&always_calls);
            let always_result = Arc::clone(&always_result);
            move |caps| {
                always_calls.lock().push(caps.to_vec());
                always_result.load(Ordering::SeqCst)
            }
        }),
        now: Arc::new(|| 1000),
        timeout_ms: 5000,
        reveal: Box::new({
            let reveals = Arc::clone(&reveals);
            move |window_id| reveals.lock().push(window_id.to_owned())
        }),
        opened: Some(Box::new({
            let opened = Arc::clone(&opened);
            move |request| opened.lock().push(request.id.clone())
        })),
        settled: Some(Box::new({
            let settled = Arc::clone(&settled);
            move |id, outcome| settled.lock().push((id.to_owned(), outcome))
        })),
    });
    Rig {
        approvals,
        published,
        grants,
        revokes,
        reveals,
        always_calls,
        always_result,
        mode: current_mode,
        opened,
        settled,
    }
}

impl Rig {
    async fn request(&self, ask: ApprovalAsk) -> JoinHandle<ApprovalOutcome> {
        let waiting = tokio::spawn(self.approvals.request(ask));
        tokio::task::yield_now().await;
        waiting
    }

    fn pending_id(&self, window_id: &str) -> String {
        self.approvals.state_for(window_id).pending[0].id.clone()
    }

    fn last_published(&self) -> ApprovalState {
        self.published.lock().last().unwrap().1.clone()
    }

    fn answer(&self, window_id: &str, id: &str, value: &str) -> bool {
        self.approvals.answer(window_id, id, &json!(value))
    }
}

#[tokio::test(start_paused = true)]
async fn ask_even_when_approvals_are_on_automatic_and_offer_only_once_or_deny() {
    let rig = setup(ApprovalMode::Allow, true);
    let waiting = rig
        .request(ApprovalAsk {
            caps: vec![],
            action: "account.switch".to_owned(),
            kind: Some(ApprovalKind::AccountSwitch),
            ..ask()
        })
        .await;
    let pending = rig.last_published().pending[0].clone();
    assert_eq!(pending.kind, Some(ApprovalKind::AccountSwitch));
    assert!(!rig.answer("7", &pending.id, "always"));
    assert!(!rig.answer("7", &pending.id, "session"));
    assert!(rig.answer("7", &pending.id, "once"));
    assert_eq!(waiting.await.unwrap(), ONCE);
    assert!(rig.grants.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn mgr_c32_brings_the_pane_window_forward_only_when_a_request_waits_for_the_human() {
    let rig = setup(ApprovalMode::Ask, true);
    let waiting = rig.request(ask()).await;
    assert_eq!(*rig.reveals.lock(), vec!["7".to_owned()]);
    rig.answer("7", "approval-1", "once");
    waiting.await.unwrap();
    rig.reveals.lock().clear();
    *rig.mode.lock() = ApprovalMode::Allow;
    let auto = rig.request(with_caps(vec![Capability::Browse])).await;
    assert_eq!(auto.await.unwrap(), ApprovalOutcome::Auto);
    assert!(rig.reveals.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn holds_the_request_and_shows_it_to_the_pane_window_until_the_human_answers_once() {
    let rig = setup(ApprovalMode::Ask, true);
    let outcome = rig.request(ask()).await;

    let shown = rig.last_published().pending;
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].pane_id, "p1");
    assert_eq!(shown[0].caps, vec![Capability::Shell]);
    let id = rig.pending_id("7");
    assert!(rig.answer("7", &id, "once"));

    assert_eq!(outcome.await.unwrap(), ONCE);
    assert!(rig.grants.lock().is_empty());
    let state = rig.approvals.state_for("7");
    assert!(state.pending.is_empty());
    assert_eq!(state.history.len(), 1);
    assert_eq!(state.history[0].request.id, id);
    assert_eq!(state.history[0].outcome, ONCE);
    assert!(!state.history[0].revocable);
}

#[tokio::test(start_paused = true)]
async fn grants_the_caps_to_the_pane_for_the_session_and_can_revoke_them() {
    let rig = setup(ApprovalMode::Ask, true);
    let outcome = rig
        .request(with_caps(vec![
            Capability::Shell,
            Capability::AllWorkspaces,
        ]))
        .await;
    let id = rig.pending_id("7");
    rig.answer("7", &id, "session");

    assert_eq!(outcome.await.unwrap(), SESSION);
    let expected = vec![
        ("ext-1".to_owned(), Capability::Shell),
        ("ext-1".to_owned(), Capability::AllWorkspaces),
    ];
    assert_eq!(*rig.grants.lock(), expected);
    assert!(rig.approvals.revoke("7", &id));
    assert_eq!(*rig.revokes.lock(), expected);
    assert!(!rig.approvals.revoke("7", &id));
}

#[tokio::test(start_paused = true)]
async fn always_allow_saves_the_caps_as_a_standing_grant_and_lets_the_request_through() {
    let rig = setup(ApprovalMode::Ask, true);
    let outcome = rig
        .request(with_caps(vec![Capability::SendOtherPane]))
        .await;
    let id = rig.pending_id("7");

    assert!(rig.answer("7", &id, "always"));

    assert_eq!(outcome.await.unwrap(), ALWAYS);
    assert_eq!(
        *rig.always_calls.lock(),
        vec![vec![Capability::SendOtherPane]]
    );
    assert_eq!(
        *rig.grants.lock(),
        vec![("ext-1".to_owned(), Capability::SendOtherPane)]
    );
    let record = rig.approvals.state_for("7").history[0].clone();
    assert_eq!(record.outcome, ALWAYS);
    assert!(!record.revocable);
}

#[tokio::test(start_paused = true)]
async fn keeps_the_card_when_the_standing_grant_cannot_be_saved() {
    let rig = setup(ApprovalMode::Ask, true);
    rig.always_result.store(false, Ordering::SeqCst);
    let _waiting = rig.request(ask()).await;
    let id = rig.pending_id("7");

    assert!(!rig.answer("7", &id, "always"));
    let pending: Vec<String> = rig
        .approvals
        .state_for("7")
        .pending
        .iter()
        .map(|p| p.id.clone())
        .collect();
    assert_eq!(pending, vec![id]);
}

#[tokio::test(start_paused = true)]
async fn refuses_always_allow_for_each_row_even_when_the_renderer_sends_it() {
    let rows: Vec<(&str, ApprovalAsk)> = vec![
        ("destructive", with_caps(vec![Capability::Destructive])),
        (
            "credentials",
            with_caps(vec![Capability::Browse, Capability::Credentials]),
        ),
        ("a sandbox domain", with_kind(ApprovalKind::SandboxDomain)),
        ("a secret", with_kind(ApprovalKind::Secret)),
        ("a package", with_kind(ApprovalKind::Package)),
    ];
    for (name, row) in rows {
        let rig = setup(ApprovalMode::Ask, true);
        let _waiting = rig.request(row).await;
        let id = rig.pending_id("7");

        assert!(!rig.answer("7", &id, "always"), "{name}");
        assert!(rig.always_calls.lock().is_empty(), "{name}");
        let pending: Vec<String> = rig
            .approvals
            .state_for("7")
            .pending
            .iter()
            .map(|p| p.id.clone())
            .collect();
        assert_eq!(pending, vec![id], "{name}");
    }
}

#[tokio::test(start_paused = true)]
async fn ignores_answers_from_another_window_and_unknown_answers() {
    let rig = setup(ApprovalMode::Ask, true);
    let outcome = rig.request(ask()).await;
    let id = rig.pending_id("7");

    assert!(!rig.answer("8", &id, "once"));
    assert!(!rig.answer("7", &id, "forever"));
    assert!(rig.approvals.state_for("8").pending.is_empty());
    rig.answer("7", &id, "deny");
    assert_eq!(outcome.await.unwrap(), DENY);
}

#[tokio::test(start_paused = true)]
async fn times_out_to_a_refusal_when_nobody_answers() {
    let rig = setup(ApprovalMode::Ask, true);
    let outcome = rig.request(ask()).await;
    tokio::time::advance(Duration::from_millis(5000)).await;
    assert_eq!(outcome.await.unwrap(), ApprovalOutcome::Timeout);
    assert_eq!(
        rig.approvals.state_for("7").history[0].outcome,
        ApprovalOutcome::Timeout
    );
}

#[tokio::test(start_paused = true)]
async fn refuses_at_once_when_the_pane_window_is_gone() {
    let rig = setup(ApprovalMode::Ask, false);
    let outcome = rig.request(ask()).await;
    assert_eq!(outcome.await.unwrap(), DENY);
}

#[tokio::test(start_paused = true)]
async fn lets_requests_through_in_allow_mode_but_still_records_them_except_destructive() {
    let rig = setup(ApprovalMode::Allow, true);
    let auto = rig.request(ask()).await;
    assert_eq!(auto.await.unwrap(), ApprovalOutcome::Auto);
    assert_eq!(
        rig.approvals.state_for("7").history[0].outcome,
        ApprovalOutcome::Auto
    );

    let destructive = rig.request(with_caps(vec![Capability::Destructive])).await;
    assert_eq!(rig.approvals.state_for("7").pending.len(), 1);
    let id = rig.pending_id("7");
    assert!(!rig.answer("7", &id, "session"));
    rig.answer("7", &id, "deny");
    assert_eq!(destructive.await.unwrap(), DENY);
}

#[tokio::test(start_paused = true)]
async fn refuses_pending_requests_and_ends_session_grants_when_the_pane_goes_away() {
    let rig = setup(ApprovalMode::Ask, true);
    let first = rig.request(ask()).await;
    let first_id = rig.pending_id("7");
    rig.answer("7", &first_id, "session");
    first.await.unwrap();
    let second = rig.request(ask()).await;

    rig.approvals.forget(&ExternalId::new("ext-1"));

    assert_eq!(second.await.unwrap(), DENY);
    let history = rig.approvals.state_for("7").history;
    let record = history.iter().find(|r| r.request.id == first_id).unwrap();
    assert!(!record.revocable);
}

#[tokio::test(start_paused = true)]
async fn moves_pending_cards_and_history_to_the_window_a_pane_moved_to() {
    let rig = setup(ApprovalMode::Ask, true);
    let outcome = rig.request(ask()).await;
    let id = rig.pending_id("7");

    rig.approvals.rehome(&[ExternalId::new("ext-1")], "9");

    assert!(rig.approvals.state_for("7").pending.is_empty());
    let moved: Vec<String> = rig
        .approvals
        .state_for("9")
        .pending
        .iter()
        .map(|p| p.id.clone())
        .collect();
    assert_eq!(moved, vec![id.clone()]);
    let mut windows: Vec<String> = {
        let published = rig.published.lock();
        published
            .iter()
            .rev()
            .take(2)
            .map(|(window_id, _)| window_id.clone())
            .collect()
    };
    windows.sort();
    assert_eq!(windows, vec!["7".to_owned(), "9".to_owned()]);
    assert!(!rig.answer("7", &id, "once"));
    assert!(rig.answer("9", &id, "once"));
    assert_eq!(outcome.await.unwrap(), ONCE);
}

fn domain_ask() -> ApprovalAsk {
    ApprovalAsk {
        caps: vec![],
        kind: Some(ApprovalKind::SandboxDomain),
        subject: Some("example.com".to_owned()),
        action: "reach example.com".to_owned(),
        ..ask()
    }
}

#[tokio::test(start_paused = true)]
async fn sbx_c18_still_shows_a_card_for_a_sandbox_request_when_approvals_mode_is_allow() {
    let rig = setup(ApprovalMode::Allow, true);
    let outcome = rig.request(domain_ask()).await;
    let pending = rig.last_published().pending;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].kind, Some(ApprovalKind::SandboxDomain));
    assert_eq!(pending[0].subject.as_deref(), Some("example.com"));
    assert!(rig.answer("7", &pending[0].id, "workspace"));
    assert_eq!(outcome.await.unwrap(), WORKSPACE);
}

#[tokio::test(start_paused = true)]
async fn sbx_c19_denies_a_sandbox_request_whose_card_times_out() {
    let rig = setup(ApprovalMode::Ask, true);
    let outcome = rig.request(domain_ask()).await;
    tokio::time::advance(Duration::from_millis(5000)).await;
    assert_eq!(outcome.await.unwrap(), ApprovalOutcome::Timeout);
    assert!(rig.grants.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn sbx_c20_never_turns_a_lasting_sandbox_answer_into_a_capability_grant() {
    let rig = setup(ApprovalMode::Ask, true);
    let outcome = rig.request(domain_ask()).await;
    let id = rig.last_published().pending[0].id.clone();
    assert!(!rig.answer("7", &id, "once"));
    assert!(rig.answer("7", &id, "workspace"));
    assert_eq!(outcome.await.unwrap(), WORKSPACE);
    assert!(rig.grants.lock().is_empty());
    let record = rig.last_published().history[0].clone();
    assert_eq!(record.outcome, WORKSPACE);
    assert!(!record.revocable);
    let cap_outcome = rig.request(ask()).await;
    let cap_id = rig.last_published().pending[0].id.clone();
    assert!(!rig.answer("7", &cap_id, "workspace"));
    rig.answer("7", &cap_id, "deny");
    cap_outcome.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn numbers_requests_in_order_and_clips_a_long_detail() {
    let rig = setup(ApprovalMode::Ask, true);
    let first = rig
        .request(ApprovalAsk {
            detail: "a".repeat(700),
            ..ask()
        })
        .await;
    let _second = rig.request(ask()).await;

    let pending = rig.approvals.state_for("7").pending;
    let ids: Vec<&str> = pending.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, vec!["approval-1", "approval-2"]);
    assert_eq!(pending[0].detail.encode_utf16().count(), 600);
    assert!(pending[0].detail.ends_with('…'));
    assert_eq!(pending[1].detail, "{}");
    assert_eq!(pending[0].kind, Some(ApprovalKind::Capability));
    assert_eq!(pending[0].subject, None);
    assert_eq!(pending[0].at, 1000);
    rig.answer("7", "approval-1", "deny");
    first.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn keeps_only_the_newest_hundred_records_newest_first() {
    let rig = setup(ApprovalMode::Allow, true);
    for _ in 0..101 {
        let auto = rig.request(with_caps(vec![Capability::Browse])).await;
        assert_eq!(auto.await.unwrap(), ApprovalOutcome::Auto);
    }
    let history = rig.approvals.state_for("7").history;
    assert_eq!(history.len(), 100);
    assert_eq!(history[0].request.id, "approval-101");
    assert_eq!(history[99].request.id, "approval-2");
    assert!(history.iter().all(|r| !r.revocable));
}

#[tokio::test(start_paused = true)]
async fn tells_the_listeners_when_a_card_opens_and_when_it_settles() {
    let rig = setup(ApprovalMode::Ask, true);
    let waiting = rig.request(ask()).await;
    assert_eq!(*rig.opened.lock(), vec!["approval-1".to_owned()]);
    assert!(rig.settled.lock().is_empty());
    rig.answer("7", "approval-1", "once");
    waiting.await.unwrap();
    assert_eq!(*rig.settled.lock(), vec![("approval-1".to_owned(), ONCE)]);

    *rig.mode.lock() = ApprovalMode::Allow;
    let auto = rig.request(with_caps(vec![Capability::Browse])).await;
    auto.await.unwrap();
    assert_eq!(rig.opened.lock().len(), 1);
    assert_eq!(rig.settled.lock().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn settles_a_card_whose_window_is_gone_without_opening_it_for_the_human() {
    let rig = setup(ApprovalMode::Ask, false);
    let outcome = rig.request(ask()).await;
    assert_eq!(outcome.await.unwrap(), DENY);
    assert_eq!(*rig.opened.lock(), vec!["approval-1".to_owned()]);
    assert_eq!(*rig.settled.lock(), vec![("approval-1".to_owned(), DENY)]);
    assert!(rig.reveals.lock().is_empty());
    assert!(rig.approvals.state_for("7").pending.is_empty());
}

#[tokio::test(start_paused = true)]
async fn refuses_to_revoke_from_another_window_or_an_unknown_record() {
    let rig = setup(ApprovalMode::Ask, true);
    let outcome = rig.request(ask()).await;
    let id = rig.pending_id("7");
    rig.answer("7", &id, "session");
    outcome.await.unwrap();

    assert!(!rig.approvals.revoke("8", &id));
    assert!(!rig.approvals.revoke("7", "approval-99"));
    assert!(rig.revokes.lock().is_empty());
    assert!(rig.approvals.revoke("7", &id));
    assert_eq!(rig.revokes.lock().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_session_answer_to_a_secret_card_grants_no_capability_and_cannot_be_revoked() {
    let rig = setup(ApprovalMode::Ask, true);
    let outcome = rig.request(with_kind(ApprovalKind::Secret)).await;
    let id = rig.pending_id("7");
    assert!(rig.answer("7", &id, "session"));
    assert_eq!(outcome.await.unwrap(), SESSION);
    assert!(rig.grants.lock().is_empty());
    assert!(!rig.approvals.state_for("7").history[0].revocable);
    assert!(!rig.approvals.revoke("7", &id));
}

#[tokio::test(start_paused = true)]
async fn forget_and_rehome_publish_only_to_the_windows_they_changed() {
    let rig = setup(ApprovalMode::Ask, true);
    let outcome = rig.request(ask()).await;
    let id = rig.pending_id("7");
    rig.answer("7", &id, "session");
    outcome.await.unwrap();

    let before = rig.published.lock().len();
    rig.approvals.forget(&ExternalId::new("other"));
    rig.approvals.rehome(&[ExternalId::new("other")], "9");
    rig.approvals.rehome(&[ExternalId::new("ext-1")], "7");
    assert_eq!(rig.published.lock().len(), before);

    rig.approvals.forget(&ExternalId::new("ext-1"));
    let after = rig.published.lock().clone();
    assert_eq!(after.len(), before + 1);
    assert_eq!(after.last().unwrap().0, "7");
}

#[tokio::test(start_paused = true)]
async fn lists_the_open_requests_with_the_window_that_holds_them() {
    let rig = setup(ApprovalMode::Ask, true);
    assert!(rig.approvals.open().is_empty());
    let _waiting = rig.request(ask()).await;
    let open = rig.approvals.open();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].window_id, "7");
    assert_eq!(open[0].request.id, "approval-1");
    rig.approvals.rehome(&[ExternalId::new("ext-1")], "9");
    assert_eq!(rig.approvals.open()[0].window_id, "9");
}
