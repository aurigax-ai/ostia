#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashSet;
use std::sync::Arc;

use ostia_base::random::random_bytes;
use ostia_base::{ExternalId, PaneId, WindowId, WorkspaceId};
use ostia_control::identity::stable_pane_external_id;
use ostia_control::{IdRegistry, IdentityKind, PaneIdentity, PaneInput};
use ostia_panes::pane_names::PaneNames;
use regex::Regex;
use serde_json::json;

fn uuid_pattern() -> Regex {
    Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap()
}

fn token_pattern() -> Regex {
    Regex::new(r"^[0-9a-f]{64}$").unwrap()
}

fn registry() -> IdRegistry {
    IdRegistry::new(&random_bytes::<32>())
}

fn input(window: &str, workspace: &str, pane: &str) -> PaneInput {
    PaneInput {
        window_id: WindowId::new(window),
        workspace_id: WorkspaceId::new(workspace),
        pane_id: PaneId::new(pane),
    }
}

fn pane(id: &str) -> PaneId {
    PaneId::new(id)
}

fn panes(ids: &[&str]) -> Vec<PaneId> {
    ids.iter().map(|id| PaneId::new(*id)).collect()
}

fn pane_ids(identities: &[PaneIdentity]) -> Vec<String> {
    let mut ids: Vec<String> = identities
        .iter()
        .map(|identity| identity.pane_id.to_string())
        .collect();
    ids.sort();
    ids
}

#[test]
fn mints_a_uuid_external_id_and_a_64_hex_char_token() {
    let registry = registry();
    let id = registry.register_pane(input("w-mint", "s-mint", "p-mint"));
    assert!(uuid_pattern().is_match(id.external_id.as_str()));
    assert!(token_pattern().is_match(&id.token));
}

#[test]
fn is_idempotent_per_pane_id_re_registering_returns_the_same_identity_but_updates_window_id_and_workspace_id()
 {
    let registry = registry();
    let first = registry.register_pane(input("w-idem-1", "s-idem-1", "p-idem"));
    let second = registry.register_pane(input("w-idem-2", "s-idem-2", "p-idem"));

    assert_eq!(second.external_id, first.external_id);
    assert_eq!(second.token, first.token);
    assert_eq!(second.window_id, WindowId::new("w-idem-2"));
    assert_eq!(second.workspace_id, WorkspaceId::new("s-idem-2"));

    let held = registry.get_by_pane_id(&pane("p-idem")).unwrap();
    assert_eq!(held.window_id, WindowId::new("w-idem-2"));
    assert_eq!(held.workspace_id, WorkspaceId::new("s-idem-2"));
}

#[test]
fn keeps_the_known_workspace_id_when_re_registered_without_one_pty_attach_after_pane_created() {
    let registry = registry();
    registry.register_pane(input("w-keep", "s-keep", "p-keep"));
    let again = registry.register_pane(input("w-keep-2", "", "p-keep"));
    assert_eq!(again.workspace_id, WorkspaceId::new("s-keep"));
    assert_eq!(again.window_id, WindowId::new("w-keep-2"));
}

#[test]
fn resolve_external_resolve_token_get_by_pane_id_all_round_trip_to_the_same_identity() {
    let registry = registry();
    let id = registry.register_pane(input("w-rt", "s-rt", "p-rt"));

    assert_eq!(registry.resolve_external(&id.external_id), Some(id.clone()));
    assert_eq!(registry.resolve_token(&id.token), Some(id.clone()));
    assert_eq!(registry.get_by_pane_id(&id.pane_id), Some(id));
}

#[test]
fn two_different_panes_get_distinct_external_ids_and_distinct_tokens() {
    let registry = registry();
    let a = registry.register_pane(input("w-dist", "s-dist", "p-dist-a"));
    let b = registry.register_pane(input("w-dist", "s-dist", "p-dist-b"));

    assert_ne!(a.external_id, b.external_id);
    assert_ne!(a.token, b.token);
}

#[test]
fn remove_pane_clears_all_three_indexes() {
    let registry = registry();
    let id = registry.register_pane(input("w-rm", "s-rm", "p-rm"));
    assert_eq!(registry.get_by_pane_id(&pane("p-rm")), Some(id.clone()));

    registry.remove_pane(&pane("p-rm"));

    assert_eq!(registry.resolve_external(&id.external_id), None);
    assert_eq!(registry.resolve_token(&id.token), None);
    assert_eq!(registry.get_by_pane_id(&pane("p-rm")), None);
}

#[test]
fn remove_pane_on_an_unknown_pane_id_is_a_no_op_does_not_throw() {
    let registry = registry();
    let kept = registry.register_pane(input("w", "s", "p-kept"));
    registry.remove_pane(&pane("p-never-registered"));
    assert_eq!(registry.get_by_pane_id(&pane("p-kept")), Some(kept));
}

#[test]
fn remove_window_wid_removes_exactly_the_panes_for_that_window_and_leaves_others() {
    let registry = registry();
    let w1a = registry.register_pane(input("w-multi-1", "s-multi", "p-multi-1a"));
    let w1b = registry.register_pane(input("w-multi-1", "s-multi", "p-multi-1b"));
    let w2a = registry.register_pane(input("w-multi-2", "s-multi", "p-multi-2a"));

    registry.remove_window(&WindowId::new("w-multi-1"));

    assert_eq!(registry.get_by_pane_id(&pane("p-multi-1a")), None);
    assert_eq!(registry.get_by_pane_id(&pane("p-multi-1b")), None);
    assert_eq!(registry.resolve_external(&w1a.external_id), None);
    assert_eq!(registry.resolve_external(&w1b.external_id), None);

    assert_eq!(
        registry.get_by_pane_id(&pane("p-multi-2a")),
        Some(w2a.clone())
    );
    assert_eq!(registry.resolve_external(&w2a.external_id), Some(w2a));
}

#[test]
fn rehome_panes_moves_a_pane_to_another_window_and_keeps_its_token() {
    let registry = registry();
    let moving = registry.register_pane(input("w-src", "s-move", "p-move"));
    let token = moving.token.clone();

    registry.rehome_panes(&panes(&["p-move", "p-unknown"]), &WindowId::new("w-dst"));

    let held = registry.get_by_pane_id(&pane("p-move")).unwrap();
    assert_eq!(held.window_id, WindowId::new("w-dst"));
    assert_eq!(registry.resolve_token(&token), Some(held.clone()));
    registry.remove_window(&WindowId::new("w-src"));
    assert_eq!(registry.get_by_pane_id(&pane("p-move")), Some(held));
}

#[test]
fn panes_owned_by_refuses_a_pane_another_window_owns() {
    let registry = registry();
    registry.register_pane(input("w-own-1", "s-own", "p-own-1"));
    registry.register_pane(input("w-own-2", "s-own", "p-own-2"));

    assert!(registry.panes_owned_by(
        &panes(&["p-own-1", "p-never-registered"]),
        &WindowId::new("w-own-1")
    ));
    assert!(!registry.panes_owned_by(&panes(&["p-own-1", "p-own-2"]), &WindowId::new("w-own-1")));
}

#[test]
fn moves_every_pane_of_a_merged_workspace_to_the_target_and_keeps_their_tokens() {
    let registry = registry();
    let a = registry.register_pane(input("w-merge", "s-merge-src", "p-merge-a"));
    let b = registry.register_pane(input("w-merge", "s-merge-src", "p-merge-b"));
    registry.register_pane(input("w-merge", "s-merge-dst", "p-merge-c"));

    let moved = registry.rehome_workspace(
        &WorkspaceId::new("s-merge-src"),
        &WorkspaceId::new("s-merge-dst"),
    );

    assert_eq!(pane_ids(&moved), ["p-merge-a", "p-merge-b"]);
    assert_eq!(
        registry
            .get_by_pane_id(&pane("p-merge-a"))
            .unwrap()
            .workspace_id,
        WorkspaceId::new("s-merge-dst")
    );
    assert_eq!(
        registry
            .get_by_pane_id(&pane("p-merge-b"))
            .unwrap()
            .workspace_id,
        WorkspaceId::new("s-merge-dst")
    );
    assert_eq!(
        registry.resolve_token(&a.token).unwrap().pane_id,
        pane("p-merge-a")
    );
    assert_eq!(
        registry.resolve_token(&b.token).unwrap().pane_id,
        pane("p-merge-b")
    );
}

#[test]
fn knows_which_workspace_holds_the_manager_pane() {
    let registry = registry();
    registry.register_pane(input("w-mgr", "s-mgr", "p-mgr"));
    registry.register_pane(input("w-mgr", "s-plain", "p-plain"));
    registry.mark_manager(&pane("p-mgr"));

    assert!(registry.workspace_has_manager(&WorkspaceId::new("s-mgr")));
    assert!(!registry.workspace_has_manager(&WorkspaceId::new("s-plain")));
}

#[test]
fn ksh_c72_gives_a_reattached_pane_its_stable_id_and_a_fresh_token_and_revokes_the_one_before() {
    let salt = random_bytes::<32>();
    let registry = IdRegistry::new(&salt);
    let minted = registry.register_pane(input("w9", "ws9", "kept-1"));
    let first = registry.adopt_pane(input("w9", "ws9", "kept-1"));
    let second = registry.adopt_pane(input("w9", "ws9", "kept-1"));

    assert_eq!(
        second.external_id,
        stable_pane_external_id(&salt, &pane("kept-1"))
    );
    let tokens: HashSet<&String> = [&minted.token, &first.token, &second.token].into();
    assert_eq!(tokens.len(), 3);
    assert_eq!(registry.resolve_token(&second.token), Some(second.clone()));
    assert_eq!(registry.resolve_token(&first.token), None);
    assert_eq!(registry.resolve_token(&minted.token), None);
    assert_eq!(
        registry
            .resolve_external(&second.external_id)
            .unwrap()
            .pane_id,
        pane("kept-1")
    );
    registry.remove_pane(&pane("kept-1"));
    assert_eq!(registry.get_by_pane_id(&pane("kept-1")), None);
}

#[test]
fn gives_a_pane_the_same_external_id_after_a_restart_but_a_fresh_token() {
    let salt = random_bytes::<32>();
    let registry = IdRegistry::new(&salt);
    let before = registry.register_pane(input("w-1", "s-r", "pane-ab12cd-3"));
    registry.remove_window(&WindowId::new("w-1"));

    let restarted = IdRegistry::new(&salt);
    let after = restarted.register_pane(input("w-2", "s-r", "pane-ab12cd-3"));

    assert_eq!(after.external_id, before.external_id);
    assert!(uuid_pattern().is_match(after.external_id.as_str()));
    assert_ne!(after.token, before.token);
    assert_eq!(restarted.resolve_token(&before.token), None);
    assert_eq!(restarted.resolve_external(&before.external_id), Some(after));
}

#[test]
fn derives_different_external_ids_for_different_panes_and_different_installs() {
    let salt = random_bytes::<32>();
    let a = stable_pane_external_id(&salt, &pane("pane-ab12cd-1"));
    let b = stable_pane_external_id(&salt, &pane("pane-ab12cd-2"));
    let other_install = stable_pane_external_id(&random_bytes::<32>(), &pane("pane-ab12cd-1"));

    assert!(uuid_pattern().is_match(a.as_str()));
    assert_ne!(a, b);
    assert_ne!(a, other_install);
}

#[test]
fn keeps_minting_random_external_ids_for_extensions() {
    let registry = registry();
    let first = registry.register_extension("ext.stable-check").external_id;
    let second = registry.register_extension("ext.stable-check").external_id;
    assert!(uuid_pattern().is_match(first.as_str()));
    assert_ne!(second, first);
}

fn names_registry() -> (IdRegistry, PaneNames) {
    let names = PaneNames::new();
    let drop_names = names.clone();
    let registry = IdRegistry::with_name_drop(
        &random_bytes::<32>(),
        Arc::new(move |pane_id: &PaneId| {
            drop_names.drop_name(pane_id.as_str());
        }),
    );
    (registry, names)
}

#[test]
fn drops_the_name_when_the_pane_identity_is_removed_pane_closed() {
    let (registry, names) = names_registry();
    registry.register_pane(input("w1", "s1", "close-me"));
    names.claim_name("close-me", &json!("closing"), None);
    registry.remove_pane(&pane("close-me"));
    assert_eq!(names.pane_named("closing"), None);
}

#[test]
fn drops_every_name_of_a_window_that_closed_and_keeps_the_other_windows() {
    let (registry, names) = names_registry();
    registry.register_pane(input("win-a", "s1", "in-a"));
    registry.register_pane(input("win-b", "s2", "in-b"));
    names.claim_name("in-a", &json!("name-a"), None);
    names.claim_name("in-b", &json!("name-b"), None);
    registry.remove_window(&WindowId::new("win-a"));
    assert_eq!(names.pane_named("name-a"), None);
    assert_eq!(names.pane_named("name-b"), Some("in-b".to_owned()));
}

#[test]
fn drops_the_name_of_a_kept_shell_that_reattaches_under_a_new_identity() {
    let (registry, names) = names_registry();
    registry.register_pane(input("w1", "s1", "kept-1"));
    names.claim_name("kept-1", &json!("kept-name"), None);
    registry.adopt_pane(input("w2", "s1", "kept-1"));
    assert_eq!(names.pane_named("kept-name"), None);
}

#[test]
fn keeps_the_name_when_the_window_only_reloads_and_registers_its_panes_again() {
    let (registry, names) = names_registry();
    registry.register_pane(input("w1", "s1", "reload-1"));
    names.claim_name("reload-1", &json!("reloaded"), None);
    registry.register_pane(input("w1", "s1", "reload-1"));
    assert_eq!(names.pane_named("reloaded"), Some("reload-1".to_owned()));
}

#[test]
fn moves_panes_to_another_workspace_and_skips_unknown_ones() {
    let registry = registry();
    let a = registry.register_pane(input("w", "s-from", "p-a"));
    registry.register_pane(input("w", "s-from", "p-b"));

    let moved =
        registry.move_to_workspace(&panes(&["p-a", "p-unknown"]), &WorkspaceId::new("s-to"));

    assert_eq!(pane_ids(&moved), ["p-a"]);
    assert_eq!(
        registry.get_by_pane_id(&pane("p-a")).unwrap().workspace_id,
        WorkspaceId::new("s-to")
    );
    assert_eq!(
        registry.get_by_pane_id(&pane("p-b")).unwrap().workspace_id,
        WorkspaceId::new("s-from")
    );
    assert_eq!(
        registry.resolve_token(&a.token).unwrap().pane_id,
        pane("p-a")
    );
}

#[test]
fn rehome_panes_returns_only_the_panes_it_knows() {
    let registry = registry();
    registry.register_pane(input("w-src", "s", "p-known"));
    let moved = registry.rehome_panes(&panes(&["p-known", "p-unknown"]), &WindowId::new("w-dst"));
    assert_eq!(pane_ids(&moved), ["p-known"]);
}

#[test]
fn panes_owned_by_is_true_for_no_panes() {
    let registry = registry();
    assert!(registry.panes_owned_by(&[], &WindowId::new("w")));
}

#[test]
fn lists_the_pane_identities_and_finds_the_window_of_a_workspace() {
    let registry = registry();
    registry.register_pane(input("w-list-1", "s-list-1", "p-list-1"));
    registry.register_pane(input("w-list-2", "s-list-2", "p-list-2"));
    registry.register_extension("ext.not-a-pane");
    registry.register_script("script-not-a-pane");

    assert_eq!(
        pane_ids(&registry.pane_identities()),
        ["p-list-1", "p-list-2"]
    );
    assert_eq!(
        registry.window_of_workspace(&WorkspaceId::new("s-list-2")),
        Some(WindowId::new("w-list-2"))
    );
    assert_eq!(
        registry.window_of_workspace(&WorkspaceId::new("s-unknown")),
        None
    );
}

#[test]
fn marks_only_a_known_pane_as_manager() {
    let registry = registry();
    registry.register_pane(input("w", "s", "p-plain"));
    assert_eq!(registry.mark_manager(&pane("p-unknown")), None);
    let marked = registry.mark_manager(&pane("p-plain")).unwrap();
    assert!(marked.manager);
    assert!(registry.get_by_pane_id(&pane("p-plain")).unwrap().manager);
}

#[test]
fn registering_an_extension_again_revokes_the_token_before() {
    let registry = registry();
    let first = registry.register_extension("ext.again");
    let second = registry.register_extension("ext.again");

    assert_eq!(first.kind, IdentityKind::Extension);
    assert_eq!(first.ext_id.as_deref(), Some("ext.again"));
    assert_eq!(first.pane_id, PaneId::default());
    assert_eq!(registry.resolve_token(&first.token), None);
    assert_eq!(registry.resolve_external(&first.external_id), None);
    assert_eq!(registry.resolve_token(&second.token), Some(second));
}

#[test]
fn removes_an_extension_only_when_the_external_id_matches() {
    let registry = registry();
    let identity = registry.register_extension("ext.guarded");

    registry.remove_extension("ext.guarded", Some(&ExternalId::new("someone-else")));
    assert_eq!(
        registry.resolve_token(&identity.token),
        Some(identity.clone())
    );

    registry.remove_extension("ext.unknown", None);
    assert_eq!(
        registry.resolve_token(&identity.token),
        Some(identity.clone())
    );

    registry.remove_extension("ext.guarded", Some(&identity.external_id));
    assert_eq!(registry.resolve_token(&identity.token), None);
    assert_eq!(registry.resolve_external(&identity.external_id), None);

    let again = registry.register_extension("ext.guarded");
    registry.remove_extension("ext.guarded", None);
    assert_eq!(registry.resolve_token(&again.token), None);
}

#[test]
fn registering_a_script_is_idempotent_and_uses_the_script_id_as_external_id() {
    let registry = registry();
    let first = registry.register_script("script-1");
    let second = registry.register_script("script-1");

    assert_eq!(first.kind, IdentityKind::Script);
    assert_eq!(first.external_id, ExternalId::new("script-1"));
    assert!(token_pattern().is_match(&first.token));
    assert_eq!(second, first);
    assert_eq!(
        registry.resolve_external(&ExternalId::new("script-1")),
        Some(first)
    );
}

#[test]
fn removes_a_script_and_revokes_its_token() {
    let registry = registry();
    let identity = registry.register_script("script-2");
    registry.remove_script("script-never-registered");
    assert_eq!(
        registry.resolve_token(&identity.token),
        Some(identity.clone())
    );

    registry.remove_script("script-2");

    assert_eq!(registry.resolve_token(&identity.token), None);
    assert_eq!(registry.resolve_external(&identity.external_id), None);
    let fresh = registry.register_script("script-2");
    assert_ne!(fresh.token, identity.token);
}

#[test]
fn a_stable_pane_external_id_is_the_same_as_the_ts_one() {
    assert_eq!(
        stable_pane_external_id(&[1; 32], &pane("p1")).as_str(),
        "3de081bb-401f-43a7-8d3d-ff492a3f06fc"
    );
}

#[test]
fn debug_output_hides_the_token() {
    let registry = registry();
    let id = registry.register_pane(input("w", "s", "p-debug"));
    assert!(!format!("{id:?}").contains(&id.token));
}

#[test]
fn lists_panes_and_finds_a_workspace_window_in_registration_order() {
    let registry = registry();
    let ids: Vec<String> = (0..40).map(|index| format!("p-order-{index}")).collect();
    for (index, id) in ids.iter().enumerate() {
        let window = if index == 0 { "w-first" } else { "w-later" };
        registry.register_pane(input(window, "s-order", id));
    }
    let listed: Vec<String> = registry
        .pane_identities()
        .iter()
        .map(|identity| identity.pane_id.to_string())
        .collect();
    assert_eq!(listed, ids);
    assert_eq!(
        registry.window_of_workspace(&WorkspaceId::new("s-order")),
        Some(WindowId::new("w-first"))
    );
    registry.remove_pane(&pane("p-order-0"));
    assert_eq!(
        registry.window_of_workspace(&WorkspaceId::new("s-order")),
        Some(WindowId::new("w-later"))
    );
}
