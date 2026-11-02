#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::FutureExt;
use ostia_base::WorkspaceId;
use ostia_contract::sandbox::BrowserControl;
use ostia_sandbox::browser_fence::{BrowserFence, BrowserFenceDeps, BrowserPolicy};
use parking_lot::Mutex;

struct Setup {
    fence: BrowserFence,
    asked: Arc<Mutex<Vec<String>>>,
    answer: Arc<AtomicBool>,
}

impl Setup {
    fn allow(&self) {
        self.answer.store(true, Ordering::SeqCst);
    }
}

fn ws(id: &str) -> WorkspaceId {
    WorkspaceId::new(id)
}

fn setup(browser: BrowserControl) -> Setup {
    let domains = Arc::new(Mutex::new(vec![
        "api.github.com".to_owned(),
        "*.example.org".to_owned(),
    ]));
    let asked = Arc::new(Mutex::new(Vec::new()));
    let answer = Arc::new(AtomicBool::new(false));
    let policy_domains = domains.clone();
    let request_asked = asked.clone();
    let request_answer = answer.clone();
    let fence = BrowserFence::new(BrowserFenceDeps {
        policy: Arc::new(move |workspace| {
            (workspace.as_str() == "sbx").then(|| BrowserPolicy {
                browser,
                domains: policy_domains.lock().clone(),
                denied: Vec::new(),
            })
        }),
        request_domain: Arc::new(move |_workspace, host| {
            request_asked.lock().push(host.to_owned());
            let allowed = request_answer.load(Ordering::SeqCst);
            if allowed {
                domains.lock().push(host.to_owned());
            }
            async move { allowed }.boxed()
        }),
    });
    Setup {
        fence,
        asked,
        answer,
    }
}

fn denying_fence(
    domains: &[&str],
    denied: &[&str],
    answer: bool,
) -> (BrowserFence, Arc<Mutex<Vec<String>>>) {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let log = asked.clone();
    let domains: Vec<String> = domains.iter().map(|d| (*d).to_owned()).collect();
    let denied: Vec<String> = denied.iter().map(|d| (*d).to_owned()).collect();
    let fence = BrowserFence::new(BrowserFenceDeps {
        policy: Arc::new(move |_| {
            Some(BrowserPolicy {
                browser: BrowserControl::Allowlist,
                domains: domains.clone(),
                denied: denied.clone(),
            })
        }),
        request_domain: Arc::new(move |_workspace, host| {
            log.lock().push(host.to_owned());
            async move { answer }.boxed()
        }),
    });
    (fence, asked)
}

#[tokio::test]
async fn sbx_c52_holds_a_browse_to_a_host_not_allowed_asks_and_lets_the_retry_through_once_allowed()
{
    let s = setup(BrowserControl::Allowlist);
    let sbx = ws("sbx");
    assert!(s.fence.allowed_now(&sbx, "https://api.github.com/x"));
    assert!(s.fence.allowed_now(&sbx, "https://docs.example.org/"));
    assert!(!s.fence.check(&sbx, "https://example.com/").await);
    assert_eq!(*s.asked.lock(), vec!["example.com".to_owned()]);
    s.allow();
    assert!(s.fence.check(&sbx, "https://example.com/").await);
    assert!(s.fence.allowed_now(&sbx, "https://example.com/page"));
    assert!(s.fence.allowed_now(&ws("plain"), "https://anything.test/"));
}

#[test]
fn sbx_c53_blocks_a_redirect_or_navigation_to_a_host_not_allowed_and_non_web_schemes() {
    let s = setup(BrowserControl::Allowlist);
    let sbx = ws("sbx");
    assert!(!s.fence.allowed_now(&sbx, "https://evil.test/login"));
    assert!(!s.fence.allowed_now(&sbx, "file:///etc/passwd"));
    assert!(!s.fence.allowed_now(&sbx, "http://127.0.0.1:3000/"));
    let open = setup(BrowserControl::Unrestricted);
    assert!(open.fence.allowed_now(&sbx, "https://evil.test/login"));
}

#[tokio::test]
async fn refuses_a_blocked_host_in_the_browser_without_asking_even_when_a_wider_rule_allows_it() {
    let (fence, asked) = denying_fence(
        &["*.example.org"],
        &["ads.example.org", "tracker.test"],
        true,
    );
    let sbx = ws("sbx");
    assert!(fence.allowed_now(&sbx, "https://docs.example.org/"));
    assert!(!fence.allowed_now(&sbx, "https://ads.example.org/pixel"));
    assert!(!fence.check(&sbx, "https://ads.example.org/pixel").await);
    assert!(!fence.check(&sbx, "https://tracker.test/").await);
    assert!(asked.lock().is_empty());
}

#[tokio::test]
async fn refuses_a_url_that_does_not_parse_or_has_a_non_web_scheme_without_asking() {
    let (fence, asked) = denying_fence(&["*.example.org"], &[], true);
    let sbx = ws("sbx");
    for url in [
        "not a url",
        "",
        "file:///etc/passwd",
        "ftp://docs.example.org/",
        "about:blank",
    ] {
        assert!(!fence.allowed_now(&sbx, url), "{url}");
        assert!(!fence.check(&sbx, url).await, "{url}");
    }
    assert!(asked.lock().is_empty());
}

#[tokio::test]
async fn does_not_let_the_retry_through_when_the_human_allows_but_the_policy_still_refuses() {
    let (fence, asked) = denying_fence(&["*.example.org"], &[], true);
    assert!(!fence.check(&ws("sbx"), "https://example.com/").await);
    assert_eq!(*asked.lock(), vec!["example.com".to_owned()]);
}

#[tokio::test]
async fn skips_the_ask_for_a_host_that_is_already_allowed() {
    let (fence, asked) = denying_fence(&["*.example.org"], &[], false);
    assert!(fence.check(&ws("sbx"), "https://docs.example.org/").await);
    assert!(asked.lock().is_empty());
}

#[test]
fn matches_the_port_of_the_url_and_falls_back_to_the_port_of_the_scheme() {
    let (fence, _) = denying_fence(&["api.github.com:443", "dev.test:8080"], &[], false);
    let sbx = ws("sbx");
    assert!(fence.allowed_now(&sbx, "https://api.github.com/"));
    assert!(fence.allowed_now(&sbx, "https://api.github.com:443/"));
    assert!(!fence.allowed_now(&sbx, "http://api.github.com/"));
    assert!(!fence.allowed_now(&sbx, "https://api.github.com:8443/"));
    assert!(fence.allowed_now(&sbx, "http://dev.test:8080/x"));
    assert!(!fence.allowed_now(&sbx, "http://dev.test/x"));
}

#[test]
fn refuses_a_blocked_port_of_an_allowed_host() {
    let (fence, _) = denying_fence(&["dev.test"], &["dev.test:8080"], false);
    let sbx = ws("sbx");
    assert!(fence.allowed_now(&sbx, "http://dev.test/"));
    assert!(!fence.allowed_now(&sbx, "http://dev.test:8080/"));
}

#[test]
fn allows_any_url_in_a_workspace_with_no_policy() {
    let s = setup(BrowserControl::Allowlist);
    for url in ["file:///etc/passwd", "not a url", "http://127.0.0.1/"] {
        assert!(s.fence.allowed_now(&ws("plain"), url), "{url}");
    }
}
