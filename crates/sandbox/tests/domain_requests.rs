#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use futures_util::FutureExt;
use futures_util::future::join_all;
use ostia_base::{PaneId, WorkspaceId};
use ostia_contract::approvals::{ApprovalAnswer, ApprovalOutcome};
use ostia_sandbox::domain_requests::{
    DomainAsk, DomainAskOrigin, DomainRequestError, DomainRequestResult, DomainRequests,
    DomainRequestsDeps,
};
use parking_lot::Mutex;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

struct Asked {
    ask: DomainAsk,
    resolve: Option<oneshot::Sender<ApprovalOutcome>>,
}

struct Setup {
    requests: DomainRequests,
    asks: Arc<Mutex<Vec<Asked>>>,
    stored: Arc<Mutex<Vec<String>>>,
    session: Arc<Mutex<Vec<String>>>,
}

impl Setup {
    fn ask_count(&self) -> usize {
        self.asks.lock().len()
    }

    fn resolve(&self, index: usize, outcome: ApprovalOutcome) {
        let sender = self.asks.lock()[index].resolve.take().unwrap();
        sender.send(outcome).unwrap();
    }

    fn host_of(&self, index: usize) -> String {
        self.asks.lock()[index].ask.host.clone()
    }

    fn request(&self, workspace: &str, host: &str) -> JoinHandle<DomainRequestResult> {
        let requests = self.requests.clone();
        let host = host.to_owned();
        let workspace = ws(workspace);
        tokio::spawn(async move {
            requests
                .request(&workspace, &PaneId::new("pane"), &host)
                .await
        })
    }
}

fn ws(id: &str) -> WorkspaceId {
    WorkspaceId::new(id)
}

fn answer(a: ApprovalAnswer) -> ApprovalOutcome {
    ApprovalOutcome::Answer(a)
}

async fn tick() {
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
}

fn setup(sandboxed: bool, blocked: &[&str]) -> Setup {
    let asks = Arc::new(Mutex::new(Vec::new()));
    let stored = Arc::new(Mutex::new(Vec::new()));
    let session = Arc::new(Mutex::new(Vec::new()));
    let blocked: Vec<String> = blocked.iter().map(|b| (*b).to_owned()).collect();
    let ask_log = asks.clone();
    let stored_log = stored.clone();
    let session_log = session.clone();
    let requests = DomainRequests::new(DomainRequestsDeps {
        is_sandboxed: Arc::new(move |_| sandboxed),
        blocked_domains: Arc::new(move |_| blocked.clone()),
        ask: Arc::new(move |ask| {
            let (resolve, outcome) = oneshot::channel();
            ask_log.lock().push(Asked {
                ask,
                resolve: Some(resolve),
            });
            async move { outcome.await.unwrap_or(answer(ApprovalAnswer::Deny)) }.boxed()
        }),
        allow_workspace: Arc::new(move |_workspace, domain| {
            stored_log.lock().push(domain.to_owned());
        }),
        allow_until_restart: Arc::new(move |_workspace, domain| {
            session_log.lock().push(domain.to_owned());
        }),
        now: Arc::new(|| 1000),
    });
    Setup {
        requests,
        asks,
        stored,
        session,
    }
}

fn granted(domain: &str) -> DomainRequestResult {
    DomainRequestResult::Granted {
        domain: domain.to_owned(),
    }
}

#[tokio::test]
async fn sbx_c38_stores_a_domain_the_human_allows_for_the_workspace_from_an_agent_request() {
    let s = setup(true, &[]);
    let res = s.request("ws", "example.com");
    tick().await;
    assert_eq!(s.ask_count(), 1);
    s.resolve(0, answer(ApprovalAnswer::Workspace));
    assert_eq!(res.await.unwrap(), granted("example.com"));
    assert_eq!(*s.stored.lock(), vec!["example.com".to_owned()]);
}

#[tokio::test]
async fn sbx_c39_keeps_an_until_restart_answer_out_of_the_store() {
    let s = setup(true, &[]);
    let res = s.request("ws", "example.com");
    tick().await;
    s.resolve(0, answer(ApprovalAnswer::Session));
    assert_eq!(res.await.unwrap(), granted("example.com"));
    assert!(s.stored.lock().is_empty());
    assert_eq!(*s.session.lock(), vec!["example.com".to_owned()]);
}

#[tokio::test]
async fn sbx_c40_refuses_a_wildcard_ip_localhost_or_malformed_host_without_a_card() {
    let s = setup(true, &[]);
    for host in ["*", "127.0.0.1", "localhost", "exa mple.com", "*:22"] {
        let result = s.request("ws", host).await.unwrap();
        assert!(
            matches!(
                result,
                DomainRequestResult::Refused {
                    error: DomainRequestError::InvalidDomain,
                    ..
                }
            ),
            "{host}: {result:?}"
        );
    }
    assert_eq!(s.ask_count(), 0);
}

#[tokio::test]
async fn gives_the_reason_of_an_invalid_domain() {
    let s = setup(true, &[]);
    assert_eq!(
        s.request("ws", "*").await.unwrap(),
        DomainRequestResult::Refused {
            error: DomainRequestError::InvalidDomain,
            reason: Some("wildcard-all"),
        }
    );
}

#[tokio::test]
async fn sbx_c41_refuses_a_request_from_a_workspace_that_is_not_sandboxed() {
    let s = setup(false, &[]);
    let result = s.request("ws", "example.com").await.unwrap();
    assert_eq!(
        result,
        DomainRequestResult::Refused {
            error: DomainRequestError::NotSandboxed,
            reason: None,
        }
    );
    assert_eq!(s.ask_count(), 0);
}

#[tokio::test]
async fn checks_the_domain_before_it_checks_the_sandbox() {
    let s = setup(false, &[]);
    let result = s.request("ws", "127.0.0.1").await.unwrap();
    assert!(
        matches!(
            result,
            DomainRequestResult::Refused {
                error: DomainRequestError::InvalidDomain,
                ..
            }
        ),
        "{result:?}"
    );
}

#[tokio::test]
async fn sbx_c42_holds_a_blocked_connection_until_the_human_allows_it() {
    let s = setup(true, &[]);
    let held = s.requests.on_blocked(&ws("ws"), "example.com", Some(443));
    tick().await;
    assert_eq!(s.ask_count(), 1);
    s.resolve(0, answer(ApprovalAnswer::Workspace));
    assert!(held.await);
    assert_eq!(*s.stored.lock(), vec!["example.com".to_owned()]);
}

#[tokio::test]
async fn sbx_c43_shares_one_card_between_connections_to_the_same_host_and_counts_them() {
    let s = setup(true, &[]);
    let held: Vec<_> = (0..21)
        .map(|_| s.requests.on_blocked(&ws("ws"), "example.com", Some(443)))
        .collect();
    assert_eq!(s.ask_count(), 1);
    tick().await;
    assert_eq!(s.ask_count(), 1);
    s.resolve(0, answer(ApprovalAnswer::Session));
    assert_eq!(join_all(held).await, vec![true; 21]);
}

#[tokio::test]
async fn sbx_c44_refuses_a_denied_host_at_once_until_restart_and_the_allow_button_still_works() {
    let s = setup(true, &[]);
    let first = s.requests.on_blocked(&ws("ws"), "example.com", Some(443));
    tick().await;
    s.resolve(0, ApprovalOutcome::Timeout);
    assert!(!first.await);
    assert!(
        !s.requests
            .on_blocked(&ws("ws"), "example.com", Some(443))
            .await
    );
    assert_eq!(s.ask_count(), 1);
    s.requests.allow_from_view(&ws("ws"), "example.com");
    assert_eq!(*s.stored.lock(), vec!["example.com".to_owned()]);
    assert!(
        s.requests
            .on_blocked(&ws("ws"), "example.com", Some(443))
            .await
    );
    assert_eq!(s.ask_count(), 1);
}

#[tokio::test]
async fn refuses_an_agent_request_for_a_host_on_the_blocked_list_without_showing_a_card() {
    let s = setup(true, &["ads.example.com", "*.tracker.test"]);
    for host in [
        "ads.example.com",
        "ADS.example.com:443",
        "pixel.tracker.test",
    ] {
        assert_eq!(
            s.request("ws", host).await.unwrap(),
            DomainRequestResult::Refused {
                error: DomainRequestError::Denied,
                reason: None,
            },
            "{host}"
        );
    }
    assert_eq!(s.ask_count(), 0);
    assert!(s.stored.lock().is_empty());
    let allowed = s.request("ws", "example.com");
    tick().await;
    assert_eq!(s.ask_count(), 1);
    s.resolve(0, answer(ApprovalAnswer::Deny));
    assert_eq!(
        allowed.await.unwrap(),
        DomainRequestResult::Refused {
            error: DomainRequestError::Denied,
            reason: None,
        }
    );
}

#[tokio::test]
async fn refuses_a_denied_agent_request_and_stores_nothing() {
    let s = setup(true, &[]);
    let res = s.request("ws", "example.com");
    tick().await;
    s.resolve(0, answer(ApprovalAnswer::Deny));
    assert_eq!(
        res.await.unwrap(),
        DomainRequestResult::Refused {
            error: DomainRequestError::Denied,
            reason: None,
        }
    );
    assert!(s.stored.lock().is_empty());
    assert!(s.session.lock().is_empty());
}

#[tokio::test]
async fn treats_a_once_an_always_and_an_auto_answer_as_a_refusal() {
    for outcome in [
        answer(ApprovalAnswer::Once),
        answer(ApprovalAnswer::Always),
        ApprovalOutcome::Auto,
        ApprovalOutcome::Timeout,
    ] {
        let s = setup(true, &[]);
        let held = s.requests.on_blocked(&ws("ws"), "example.com", Some(443));
        tick().await;
        s.resolve(0, outcome);
        assert!(!held.await, "{outcome:?}");
        assert!(s.stored.lock().is_empty(), "{outcome:?}");
        assert!(s.session.lock().is_empty(), "{outcome:?}");
    }
}

#[tokio::test]
async fn refuses_a_connection_when_the_ask_is_dropped_without_an_answer() {
    let s = setup(true, &[]);
    let held = s.requests.on_blocked(&ws("ws"), "example.com", Some(443));
    tick().await;
    s.asks.lock()[0].resolve.take();
    assert!(!held.await);
    assert!(s.stored.lock().is_empty());
}

#[tokio::test]
async fn answers_a_host_the_human_allowed_without_a_second_card() {
    let s = setup(true, &[]);
    let first = s.requests.on_blocked(&ws("ws"), "example.com", Some(443));
    tick().await;
    s.resolve(0, answer(ApprovalAnswer::Session));
    assert!(first.await);
    assert!(
        s.requests
            .on_blocked(&ws("ws"), "example.com", Some(443))
            .await
    );
    assert_eq!(s.ask_count(), 1);
}

#[tokio::test]
async fn lowercases_the_host_of_a_blocked_connection_before_it_asks_and_remembers() {
    let s = setup(true, &[]);
    let held = s.requests.on_blocked(&ws("ws"), "EXAMPLE.com", Some(443));
    tick().await;
    assert_eq!(s.host_of(0), "example.com");
    s.resolve(0, answer(ApprovalAnswer::Workspace));
    assert!(held.await);
    assert!(
        s.requests
            .on_blocked(&ws("ws"), "Example.COM", Some(443))
            .await
    );
    assert_eq!(s.ask_count(), 1);
}

#[tokio::test]
async fn names_the_origin_and_the_pane_of_each_kind_of_card() {
    let s = setup(true, &[]);
    let agent = s.request("ws", "agent.test");
    let blocked = s.requests.on_blocked(&ws("ws"), "net.test", None);
    tick().await;
    {
        let asks = s.asks.lock();
        assert_eq!(asks[0].ask.origin, DomainAskOrigin::Agent);
        assert_eq!(asks[0].ask.pane_id, Some(PaneId::new("pane")));
        assert_eq!(asks[0].ask.workspace_id, ws("ws"));
        assert_eq!(asks[1].ask.origin, DomainAskOrigin::Blocked);
        assert_eq!(asks[1].ask.pane_id, None);
        assert_eq!(asks[1].ask.host, "net.test");
    }
    s.resolve(0, answer(ApprovalAnswer::Deny));
    s.resolve(1, answer(ApprovalAnswer::Deny));
    agent.await.unwrap();
    blocked.await;
}

#[tokio::test]
async fn shares_one_card_between_an_agent_request_and_a_blocked_connection_to_the_same_host() {
    let s = setup(true, &[]);
    let agent = s.request("ws", "example.com");
    tick().await;
    let blocked = s.requests.on_blocked(&ws("ws"), "example.com", Some(443));
    assert_eq!(s.ask_count(), 1);
    s.resolve(0, answer(ApprovalAnswer::Workspace));
    assert_eq!(agent.await.unwrap(), granted("example.com"));
    assert!(blocked.await);
}

#[tokio::test]
async fn keeps_a_card_for_each_workspace() {
    let s = setup(true, &[]);
    let a = s.requests.on_blocked(&ws("a"), "example.com", Some(443));
    let b = s.requests.on_blocked(&ws("b"), "example.com", Some(443));
    tick().await;
    assert_eq!(s.ask_count(), 2);
    s.resolve(0, answer(ApprovalAnswer::Session));
    s.resolve(1, ApprovalOutcome::Timeout);
    assert!(a.await);
    assert!(!b.await);
    assert!(
        s.requests
            .on_blocked(&ws("a"), "example.com", Some(443))
            .await
    );
    assert!(
        !s.requests
            .on_blocked(&ws("b"), "example.com", Some(443))
            .await
    );
    assert_eq!(s.ask_count(), 2);
}

#[tokio::test]
async fn asks_again_after_the_card_is_answered() {
    let s = setup(true, &[]);
    let first = s.requests.on_blocked(&ws("ws"), "example.com", Some(443));
    tick().await;
    s.resolve(0, answer(ApprovalAnswer::Session));
    assert!(first.await);
    let again = s.request("ws", "example.com");
    tick().await;
    assert_eq!(s.ask_count(), 2);
    s.resolve(1, answer(ApprovalAnswer::Deny));
    again.await.unwrap();
}

#[tokio::test]
async fn forgets_the_answers_of_a_workspace_and_asks_again() {
    let s = setup(true, &[]);
    let denied = s.requests.on_blocked(&ws("ws"), "bad.test", Some(443));
    let allowed = s.requests.on_blocked(&ws("ws"), "good.test", Some(443));
    tick().await;
    s.resolve(0, ApprovalOutcome::Timeout);
    s.resolve(1, answer(ApprovalAnswer::Session));
    assert!(!denied.await);
    assert!(allowed.await);
    s.requests.forget(&ws("ws"));
    let bad = s.requests.on_blocked(&ws("ws"), "bad.test", Some(443));
    let good = s.requests.on_blocked(&ws("ws"), "good.test", Some(443));
    tick().await;
    assert_eq!(s.ask_count(), 4);
    s.resolve(2, answer(ApprovalAnswer::Session));
    s.resolve(3, answer(ApprovalAnswer::Session));
    assert!(bad.await);
    assert!(good.await);
}

#[tokio::test]
async fn leaves_the_answers_of_another_workspace_when_one_is_forgotten() {
    let s = setup(true, &[]);
    let held = s.requests.on_blocked(&ws("keep"), "example.com", Some(443));
    tick().await;
    s.resolve(0, answer(ApprovalAnswer::Session));
    assert!(held.await);
    s.requests.forget(&ws("other"));
    assert!(
        s.requests
            .on_blocked(&ws("keep"), "example.com", Some(443))
            .await
    );
    assert_eq!(s.ask_count(), 1);
}

#[tokio::test]
async fn lowercases_the_host_of_an_allow_from_the_view() {
    let s = setup(true, &[]);
    s.requests.allow_from_view(&ws("ws"), "Example.COM");
    assert_eq!(*s.stored.lock(), vec!["example.com".to_owned()]);
    assert!(
        s.requests
            .on_blocked(&ws("ws"), "example.com", Some(443))
            .await
    );
    assert_eq!(s.ask_count(), 0);
}
