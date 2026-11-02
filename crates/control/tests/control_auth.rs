#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use ostia_base::{ExternalId, PaneId, WindowId, WorkspaceId};
use ostia_contract::capabilities::Capability;
use ostia_control::{
    AuthedConn, CapabilityStore, ControlAuth, ControlAuthParts, IdRegistry, PaneInput,
    ScriptTokenGrant,
};
use parking_lot::Mutex;
use serde_json::json;

#[derive(Default)]
struct Grants(Mutex<HashMap<ExternalId, HashSet<Capability>>>);

impl Grants {
    fn grant(&self, external_id: &ExternalId, cap: Capability) {
        self.0
            .lock()
            .entry(external_id.clone())
            .or_default()
            .insert(cap);
    }
}

impl CapabilityStore for Grants {
    fn init_caps(&self, external_id: &ExternalId) {
        self.0
            .lock()
            .entry(external_id.clone())
            .or_insert_with(|| HashSet::from([Capability::ReadBoard]));
    }

    fn set_caps(&self, external_id: &ExternalId, caps: &[Capability]) {
        self.0
            .lock()
            .insert(external_id.clone(), caps.iter().copied().collect());
    }

    fn has_cap(&self, external_id: &ExternalId, cap: Capability) -> bool {
        self.0
            .lock()
            .get(external_id)
            .is_some_and(|caps| caps.contains(&cap))
    }
}

type Filter = Arc<dyn Fn(&AuthedConn, Capability) -> bool + Send + Sync>;

struct Fixture {
    auth: ControlAuth,
    registry: IdRegistry,
    grants: Arc<Grants>,
    now: Arc<AtomicI64>,
}

fn fixture_with(script: Option<ScriptTokenGrant>, cap_filter: Filter) -> Fixture {
    let registry = IdRegistry::new(&[7; 32]);
    let grants = Arc::new(Grants::default());
    let now = Arc::new(AtomicI64::new(1_000));
    let script = Mutex::new(script);
    let clock_now = Arc::clone(&now);
    let auth = ControlAuth::new(ControlAuthParts {
        registry: registry.clone(),
        caps: grants.clone(),
        script_tokens: Arc::new(move |token| {
            if token != "ostia_script" {
                return None;
            }
            script.lock().as_ref().map(|grant| ScriptTokenGrant {
                id: grant.id.clone(),
                caps: grant.caps.clone(),
                expires_at_ms: grant.expires_at_ms,
            })
        }),
        cap_filter,
        approver: None,
        clock: Arc::new(move || clock_now.load(Ordering::SeqCst)),
    });
    Fixture {
        auth,
        registry,
        grants,
        now,
    }
}

fn fixture() -> Fixture {
    fixture_with(None, Arc::new(|_, _| true))
}

fn script_fixture(expires_at_ms: Option<i64>) -> Fixture {
    fixture_with(
        Some(ScriptTokenGrant {
            id: "script-1".to_owned(),
            caps: vec![Capability::ReadBoard, Capability::Process],
            expires_at_ms,
        }),
        Arc::new(|_, _| true),
    )
}

fn pane(
    registry: &IdRegistry,
    window: &str,
    workspace: &str,
    pane: &str,
) -> ostia_control::PaneIdentity {
    registry.register_pane(PaneInput {
        window_id: WindowId::new(window),
        workspace_id: WorkspaceId::new(workspace),
        pane_id: PaneId::new(pane),
    })
}

#[test]
fn authenticates_a_valid_token_minted_via_register_pane() {
    let fx = fixture();
    let identity = pane(&fx.registry, "w1", "s1", "p1");
    let conn = fx
        .auth
        .authenticate(&json!({"token": identity.token}))
        .unwrap();
    assert_eq!(conn.external_id, identity.external_id);
    assert_eq!(conn.pane_id, PaneId::new("p1"));
    assert_eq!(conn.workspace_id, WorkspaceId::new("s1"));
}

#[test]
fn rejects_an_absent_token() {
    let fx = fixture();
    assert!(fx.auth.authenticate(&json!({})).is_none());
}

#[test]
fn rejects_a_non_string_token() {
    let fx = fixture();
    assert!(fx.auth.authenticate(&json!({"token": 123})).is_none());
}

#[test]
fn rejects_an_unknown_token() {
    let fx = fixture();
    assert!(fx.auth.authenticate(&json!({"token": "bogus"})).is_none());
}

#[test]
fn conn_has_cap_is_true_for_a_default_cap_and_false_for_an_ungranted_elevated_cap_until_granted() {
    let fx = fixture();
    let identity = pane(&fx.registry, "w2", "s2", "p2");
    let conn = fx
        .auth
        .authenticate(&json!({"token": identity.token}))
        .unwrap();
    assert!(fx.auth.conn_has_cap(&conn, Capability::ReadBoard));
    assert!(!fx.auth.conn_has_cap(&conn, Capability::Shell));
    fx.grants.grant(&conn.external_id, Capability::Shell);
    assert!(fx.auth.conn_has_cap(&conn, Capability::Shell));
}

#[test]
fn a_pane_connection_has_no_script_session() {
    let fx = fixture();
    let identity = pane(&fx.registry, "w1", "s1", "p1");
    let conn = fx
        .auth
        .authenticate(&json!({"token": identity.token}))
        .unwrap();
    assert_eq!(conn.script_session, None);
}

#[test]
fn authenticates_a_script_token_with_empty_pane_and_workspace_and_a_session_token() {
    let fx = script_fixture(None);
    let conn = fx
        .auth
        .authenticate(&json!({"token": "ostia_script"}))
        .unwrap();
    assert_eq!(conn.external_id, ExternalId::new("script-1"));
    assert_eq!(conn.pane_id, PaneId::default());
    assert_eq!(conn.workspace_id, WorkspaceId::default());
    let session = conn.script_session.clone().unwrap();
    assert_eq!(session, fx.registry.register_script("script-1").token);
    assert!(fx.registry.resolve_token(&session).is_some());
}

#[test]
fn a_script_token_gets_exactly_the_caps_of_its_grant() {
    let fx = script_fixture(None);
    let conn = fx
        .auth
        .authenticate(&json!({"token": "ostia_script"}))
        .unwrap();
    assert!(fx.auth.conn_has_cap(&conn, Capability::ReadBoard));
    assert!(fx.auth.conn_has_cap(&conn, Capability::Process));
    assert!(!fx.auth.conn_has_cap(&conn, Capability::Shell));
}

#[test]
fn a_script_session_token_does_not_authenticate_as_a_pane() {
    let fx = script_fixture(None);
    let conn = fx
        .auth
        .authenticate(&json!({"token": "ostia_script"}))
        .unwrap();
    let session = conn.script_session.unwrap();
    assert!(fx.auth.authenticate(&json!({"token": session})).is_none());
}

#[test]
fn a_script_token_is_not_expired_without_an_expiry() {
    let fx = script_fixture(None);
    let conn = fx
        .auth
        .authenticate(&json!({"token": "ostia_script"}))
        .unwrap();
    fx.now.store(i64::MAX, Ordering::SeqCst);
    assert!(!fx.auth.script_expired(&conn.external_id));
}

#[test]
fn a_script_token_expires_at_its_expiry_time() {
    let fx = script_fixture(Some(5_000));
    let conn = fx
        .auth
        .authenticate(&json!({"token": "ostia_script"}))
        .unwrap();
    fx.now.store(4_999, Ordering::SeqCst);
    assert!(!fx.auth.script_expired(&conn.external_id));
    fx.now.store(5_000, Ordering::SeqCst);
    assert!(fx.auth.script_expired(&conn.external_id));
    fx.now.store(9_000, Ordering::SeqCst);
    assert!(fx.auth.script_expired(&conn.external_id));
}

#[test]
fn authenticating_again_without_an_expiry_clears_the_old_expiry() {
    let registry_script = Arc::new(Mutex::new(Some(5_000_i64)));
    let registry = IdRegistry::new(&[7; 32]);
    let grants = Arc::new(Grants::default());
    let now = Arc::new(AtomicI64::new(6_000));
    let expiry = Arc::clone(&registry_script);
    let clock_now = Arc::clone(&now);
    let auth = ControlAuth::new(ControlAuthParts {
        registry,
        caps: grants,
        script_tokens: Arc::new(move |token| {
            (token == "ostia_script").then(|| ScriptTokenGrant {
                id: "script-1".to_owned(),
                caps: vec![Capability::ReadBoard],
                expires_at_ms: *expiry.lock(),
            })
        }),
        cap_filter: Arc::new(|_, _| true),
        approver: None,
        clock: Arc::new(move || clock_now.load(Ordering::SeqCst)),
    });
    let conn = auth
        .authenticate(&json!({"token": "ostia_script"}))
        .unwrap();
    assert!(auth.script_expired(&conn.external_id));
    *registry_script.lock() = None;
    auth.authenticate(&json!({"token": "ostia_script"}))
        .unwrap();
    assert!(!auth.script_expired(&conn.external_id));
}

#[test]
fn script_expired_is_false_for_an_identity_that_never_authenticated_as_a_script() {
    let fx = fixture();
    assert!(!fx.auth.script_expired(&ExternalId::new("nobody")));
}

#[test]
fn a_script_token_the_check_refuses_is_rejected() {
    let fx = fixture();
    assert!(
        fx.auth
            .authenticate(&json!({"token": "ostia_script"}))
            .is_none()
    );
}

#[test]
fn the_cap_filter_can_refuse_a_cap_the_connection_holds() {
    let fx = fixture_with(None, Arc::new(|_, cap| cap != Capability::ReadBoard));
    let identity = pane(&fx.registry, "w1", "s1", "p1");
    let conn = fx
        .auth
        .authenticate(&json!({"token": identity.token}))
        .unwrap();
    assert!(fx.grants.has_cap(&conn.external_id, Capability::ReadBoard));
    assert!(!fx.auth.cap_allowed_here(&conn, Capability::ReadBoard));
    assert!(!fx.auth.conn_has_cap(&conn, Capability::ReadBoard));
    assert!(fx.auth.cap_allowed_here(&conn, Capability::Shell));
}

#[test]
fn the_cap_filter_sees_the_connection_it_is_asked_about() {
    let seen: Arc<Mutex<Vec<ExternalId>>> = Arc::default();
    let log = Arc::clone(&seen);
    let fx = fixture_with(
        None,
        Arc::new(move |conn, _| {
            log.lock().push(conn.external_id.clone());
            true
        }),
    );
    let identity = pane(&fx.registry, "w1", "s1", "p1");
    let conn = fx
        .auth
        .authenticate(&json!({"token": identity.token}))
        .unwrap();
    fx.auth.conn_has_cap(&conn, Capability::ReadBoard);
    assert_eq!(*seen.lock(), vec![identity.external_id]);
}
