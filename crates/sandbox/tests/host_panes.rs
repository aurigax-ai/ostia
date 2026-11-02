#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use ostia_sandbox::host_panes::{HostPaneGrants, HostPaneGrantsDeps};

const INSTALL: &str = "'pacman' '-S' 'jq'";

fn grants(now: &Arc<AtomicI64>) -> HostPaneGrants {
    let clock = now.clone();
    HostPaneGrants::new(HostPaneGrantsDeps {
        now: Arc::new(move || clock.load(Ordering::SeqCst)),
        ttl_ms: 60_000,
    })
}

#[test]
fn sbx_c90_opens_a_host_pane_only_for_the_exact_command_the_human_just_approved_once() {
    let now = Arc::new(AtomicI64::new(1000));
    let grants = grants(&now);
    assert_eq!(grants.claim("system", INSTALL), None);
    grants.offer("system", INSTALL);
    assert_eq!(grants.claim("other-ext", INSTALL), None);
    assert_eq!(grants.claim("system", "'pacman' '-S' 'curl'"), None);
    let token = grants.claim("system", INSTALL).unwrap();
    assert!(
        token.len() >= 32
            && token
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)),
        "token {token}"
    );
    assert_eq!(grants.claim("system", INSTALL), None);
    assert!(!grants.consume("bogus"));
    assert!(grants.consume(&token));
    assert!(!grants.consume(&token));
    grants.offer("system", INSTALL);
    now.fetch_add(61_000, Ordering::SeqCst);
    assert_eq!(grants.claim("system", INSTALL), None);
}

#[test]
fn spends_an_offer_on_a_claim_that_names_the_same_extension_and_command_even_when_it_expired() {
    let now = Arc::new(AtomicI64::new(1000));
    let grants = grants(&now);
    grants.offer("system", INSTALL);
    now.fetch_add(61_000, Ordering::SeqCst);
    assert_eq!(grants.claim("system", INSTALL), None);
    now.store(1000, Ordering::SeqCst);
    assert_eq!(grants.claim("system", INSTALL), None);
}

#[test]
fn keeps_an_offer_when_another_extension_or_command_claims() {
    let now = Arc::new(AtomicI64::new(1000));
    let grants = grants(&now);
    grants.offer("system", INSTALL);
    assert_eq!(grants.claim("other-ext", INSTALL), None);
    assert_eq!(grants.claim("system", "'pacman' '-S' 'curl'"), None);
    assert!(grants.claim("system", INSTALL).is_some());
}

#[test]
fn accepts_a_claim_at_the_last_millisecond_of_the_offer_and_refuses_the_next() {
    let now = Arc::new(AtomicI64::new(1000));
    let grants = grants(&now);
    grants.offer("system", INSTALL);
    now.store(61_000, Ordering::SeqCst);
    assert!(grants.claim("system", INSTALL).is_some());
    grants.offer("system", INSTALL);
    now.store(122_001, Ordering::SeqCst);
    assert_eq!(grants.claim("system", INSTALL), None);
}

#[test]
fn refuses_a_token_after_its_time_is_over_and_spends_it() {
    let now = Arc::new(AtomicI64::new(1000));
    let grants = grants(&now);
    grants.offer("system", INSTALL);
    let token = grants.claim("system", INSTALL).unwrap();
    now.store(61_000, Ordering::SeqCst);
    assert!(grants.consume(&token));

    now.store(1000, Ordering::SeqCst);
    grants.offer("system", INSTALL);
    let late = grants.claim("system", INSTALL).unwrap();
    now.store(61_001, Ordering::SeqCst);
    assert!(!grants.consume(&late));
    now.store(1000, Ordering::SeqCst);
    assert!(!grants.consume(&late));
}

#[test]
fn gives_a_different_token_for_each_claim() {
    let now = Arc::new(AtomicI64::new(1000));
    let grants = grants(&now);
    grants.offer("system", INSTALL);
    let first = grants.claim("system", INSTALL).unwrap();
    grants.offer("system", INSTALL);
    let second = grants.claim("system", INSTALL).unwrap();
    assert_ne!(first, second);
    assert!(grants.consume(&second));
    assert!(grants.consume(&first));
}
