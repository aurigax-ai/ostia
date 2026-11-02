#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::PathBuf;

use ostia_contract::capabilities::Capability;
use ostia_extensions::extension_store::{
    ExtensionRecord, ExtensionStore, KindRoles, ViewPriority, effective_record, granted_caps,
    kind_approved, needs_approval,
};
use serde_json::{Value, json};
use tempfile::TempDir;

const ALL_CAPABILITIES: [&str; 27] = [
    "drive-self",
    "read-board",
    "send-other-pane",
    "type-other-pane",
    "read-other-pane",
    "kill-pane",
    "all-workspaces",
    "shell",
    "destructive",
    "phone",
    "gateway",
    "notify",
    "process",
    "vault-read",
    "vault-write",
    "browse",
    "settings-read",
    "settings-write",
    "assist",
    "credentials",
    "language-server",
    "agent-plugin",
    "agent-complete",
    "mcp",
    "read-bus",
    "file-contents",
    "phone-screens",
];

fn cap(name: &str) -> Capability {
    serde_json::from_value(json!(name)).unwrap()
}

fn caps(names: &[&str]) -> Vec<Capability> {
    names.iter().map(|name| cap(name)).collect()
}

fn record(enabled: bool, approved: Option<&[&str]>) -> ExtensionRecord {
    ExtensionRecord {
        enabled,
        approved: approved.map(caps),
        approved_kinds: Vec::new(),
        servers_off: Vec::new(),
    }
}

fn file_in() -> (TempDir, PathBuf) {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("extensions.json");
    (dir, file)
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust")
        .join(name)
}

fn stored(file: &PathBuf) -> Value {
    serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap()
}

#[test]
fn is_the_intersection_of_what_the_manifest_declares_and_what_the_human_approved() {
    assert_eq!(
        granted_caps(
            &caps(&["notify", "browse", "shell"]),
            Some(&caps(&["notify", "shell", "gateway"]))
        ),
        caps(&["notify", "shell"])
    );
}

#[test]
fn grants_nothing_when_nothing_was_ever_approved() {
    assert_eq!(
        granted_caps(&caps(&["notify"]), None),
        Vec::<Capability>::new()
    );
    assert_eq!(
        granted_caps(&caps(&["notify"]), Some(&[])),
        Vec::<Capability>::new()
    );
}

#[test]
fn asks_the_human_only_for_a_user_extension_that_has_never_been_reviewed() {
    assert!(needs_approval(false, None));
    assert!(needs_approval(false, Some(&record(false, None))));
    assert!(!needs_approval(false, Some(&record(false, Some(&[])))));
    assert!(!needs_approval(true, None));
}

#[test]
fn never_asks_the_human_about_a_built_in_even_with_a_record_that_has_no_approval() {
    assert!(!needs_approval(true, Some(&record(false, None))));
    assert!(!needs_approval(
        true,
        Some(&record(true, Some(&["notify"])))
    ));
}

#[test]
fn pre_approves_and_enables_built_ins_and_keeps_user_extensions_off_by_default() {
    let human_granted = ["mcp", "read-bus", "file-contents", "phone-screens"];
    let builtin_default: Vec<&str> = ALL_CAPABILITIES
        .iter()
        .copied()
        .filter(|name| !human_granted.contains(name))
        .collect();
    assert_eq!(
        effective_record(true, None, &[]),
        record(true, Some(&builtin_default))
    );
    let default_approved = effective_record(true, None, &[]).approved.unwrap();
    assert!(!default_approved.contains(&cap("phone-screens")));
    assert!(!default_approved.contains(&cap("mcp")));
    assert!(!default_approved.contains(&cap("file-contents")));
    assert!(!default_approved.contains(&cap("read-bus")));
    assert_eq!(effective_record(false, None, &[]), record(false, None));

    let with_declared = effective_record(true, None, &caps(&["file-contents"]));
    assert!(
        with_declared
            .approved
            .unwrap()
            .contains(&cap("file-contents"))
    );
    assert_eq!(
        effective_record(false, None, &caps(&["file-contents"])),
        record(false, None)
    );

    let saved = record(false, Some(&["notify"]));
    assert_eq!(effective_record(true, Some(&saved), &[]), saved);
    assert_eq!(
        effective_record(true, Some(&saved), &caps(&["file-contents"])),
        record(false, Some(&["notify", "file-contents"]))
    );
    assert_eq!(
        effective_record(false, Some(&saved), &caps(&["file-contents"])),
        saved
    );
    let granted = record(true, Some(&["file-contents"]));
    assert_eq!(
        effective_record(true, Some(&granted), &caps(&["file-contents"])),
        granted
    );
}

#[test]
fn adds_declared_capabilities_to_a_built_in_record_without_approval_and_keeps_its_other_fields() {
    let saved = ExtensionRecord {
        enabled: true,
        approved: None,
        approved_kinds: vec!["demo.grid:view:default:*.csv".to_owned()],
        servers_off: vec!["pyright".to_owned()],
    };
    assert_eq!(
        effective_record(true, Some(&saved), &caps(&["notify", "notify"])),
        ExtensionRecord {
            approved: Some(caps(&["notify", "notify"])),
            ..saved.clone()
        }
    );
    assert_eq!(effective_record(true, Some(&saved), &[]), saved);
}

fn sheet() -> KindRoles {
    KindRoles {
        id: "acme.grid".to_owned(),
        filename_patterns: vec!["*.XLSX".to_owned(), "*.ods".to_owned()],
        view: Some(ViewPriority::Option),
        browse: false,
    }
}

const SHEET_CLAIM: &str = "acme.grid:view:option:*.ods,*.xlsx";

fn with_kinds(claims: &[&str]) -> ExtensionRecord {
    ExtensionRecord {
        approved_kinds: claims.iter().map(|claim| (*claim).to_owned()).collect(),
        ..record(true, Some(&[]))
    }
}

#[test]
fn approves_a_built_in_always_and_a_user_kind_only_for_the_exact_claim() {
    assert!(kind_approved(true, None, &sheet()));
    assert!(!kind_approved(false, None, &sheet()));
    assert!(!kind_approved(
        false,
        Some(&record(true, Some(&[]))),
        &sheet()
    ));
    assert!(kind_approved(
        false,
        Some(&with_kinds(&[SHEET_CLAIM])),
        &sheet()
    ));
}

#[test]
fn waits_for_approval_when_an_update_widens_the_selector_or_adds_a_kind() {
    let approved = with_kinds(&[SHEET_CLAIM]);
    let mut widened = sheet();
    widened.filename_patterns.push("*.csv".to_owned());
    assert!(!kind_approved(false, Some(&approved), &widened));
    let other = KindRoles {
        id: "acme.other".to_owned(),
        ..sheet()
    };
    assert!(!kind_approved(false, Some(&approved), &other));
    let default_priority = KindRoles {
        view: Some(ViewPriority::Default),
        ..sheet()
    };
    assert!(!kind_approved(false, Some(&approved), &default_priority));
}

#[test]
fn builds_the_claim_from_sorted_lower_case_unique_patterns_and_the_roles() {
    let rows = [
        (
            KindRoles {
                filename_patterns: vec!["*.ods".to_owned(), "*.ODS".to_owned(), "*.csv".to_owned()],
                ..sheet()
            },
            "acme.grid:view:option:*.csv,*.ods",
        ),
        (
            KindRoles {
                view: None,
                browse: true,
                ..sheet()
            },
            "acme.grid:browse:*.ods,*.xlsx",
        ),
        (
            KindRoles {
                view: Some(ViewPriority::Default),
                browse: true,
                ..sheet()
            },
            "acme.grid:view:default+browse:*.ods,*.xlsx",
        ),
        (
            KindRoles {
                view: None,
                browse: false,
                ..sheet()
            },
            "acme.grid::*.ods,*.xlsx",
        ),
    ];
    for (kind, claim) in rows {
        assert!(
            kind_approved(false, Some(&with_kinds(&[claim])), &kind),
            "claim {claim}"
        );
        assert!(
            !kind_approved(false, Some(&with_kinds(&["acme.grid:other:*.ods"])), &kind),
            "claim {claim}"
        );
    }
}

#[test]
fn keeps_the_language_servers_the_human_switched_off_and_drops_anything_that_is_not_a_name() {
    let (_dir, file) = file_in();
    ExtensionStore::new(file.clone())
        .set(
            "lsp",
            ExtensionRecord {
                servers_off: vec!["pyright".to_owned()],
                ..record(true, Some(&[]))
            },
        )
        .unwrap();
    assert_eq!(
        ExtensionStore::new(file.clone()).get("lsp"),
        Some(ExtensionRecord {
            servers_off: vec!["pyright".to_owned()],
            ..record(true, Some(&[]))
        })
    );
    fs::write(
        &file,
        json!({"lsp": {"enabled": true, "approved": [], "serversOff": [1, "ok", null]}})
            .to_string(),
    )
    .unwrap();
    assert_eq!(
        ExtensionStore::new(file).get("lsp").unwrap().servers_off,
        ["ok"]
    );
}

#[test]
fn keeps_the_approved_kind_claims_and_drops_anything_that_is_not_a_short_string() {
    let (_dir, file) = file_in();
    ExtensionStore::new(file.clone())
        .set("demo", with_kinds(&["demo.grid:view:default:*.csv"]))
        .unwrap();
    assert_eq!(
        ExtensionStore::new(file.clone())
            .get("demo")
            .unwrap()
            .approved_kinds,
        ["demo.grid:view:default:*.csv"]
    );
    fs::write(
        &file,
        json!({"demo": {"enabled": true, "approved": [], "approvedKinds": [1, "ok", "x".repeat(3000)]}})
            .to_string(),
    )
    .unwrap();
    assert_eq!(
        ExtensionStore::new(file)
            .get("demo")
            .unwrap()
            .approved_kinds,
        ["ok"]
    );
}

#[test]
fn persists_records_and_reads_them_back_in_a_new_instance() {
    let (_dir, file) = file_in();
    ExtensionStore::new(file.clone())
        .set("demo", record(true, Some(&["notify"])))
        .unwrap();
    assert_eq!(
        ExtensionStore::new(file.clone()).get("demo"),
        Some(record(true, Some(&["notify"])))
    );
    assert_eq!(
        stored(&file),
        json!({"demo": {"enabled": true, "approved": ["notify"]}})
    );
}

#[test]
fn deletes_a_record_so_the_extension_needs_approval_again() {
    let (_dir, file) = file_in();
    let store = ExtensionStore::new(file.clone());
    store.set("demo", record(true, Some(&["notify"]))).unwrap();
    store.set("other", record(false, Some(&[]))).unwrap();
    store.delete("demo").unwrap();
    assert_eq!(store.get("demo"), None);
    assert_eq!(ExtensionStore::new(file.clone()).get("demo"), None);
    assert_eq!(
        ExtensionStore::new(file).get("other"),
        Some(record(false, Some(&[])))
    );
}

#[test]
fn drops_unknown_capabilities_and_ignores_prototype_keys_in_a_hand_edited_file() {
    let (_dir, file) = file_in();
    fs::write(
        &file,
        r#"{"demo":{"enabled":true,"approved":["notify","root"]},"__proto__":{"enabled":true,"approved":[]}}"#,
    )
    .unwrap();
    let store = ExtensionStore::new(file);
    assert_eq!(store.get("demo"), Some(record(true, Some(&["notify"]))));
    assert_eq!(store.get("toString"), None);
}

#[test]
fn returns_a_record_named_proto_as_a_plain_entry_like_ts_does() {
    let (_dir, file) = file_in();
    fs::write(
        &file,
        r#"{"__proto__":{"enabled":true,"approved":[]},"constructor":{"enabled":true,"approved":["notify"]}}"#,
    )
    .unwrap();
    let store = ExtensionStore::new(file);
    assert_eq!(store.get("__proto__"), Some(record(true, Some(&[]))));
    assert_eq!(
        store.get("constructor"),
        Some(record(true, Some(&["notify"])))
    );
    assert_eq!(store.get("hasOwnProperty"), None);
}

#[test]
fn returns_none_for_an_unknown_id_and_survives_a_corrupt_file() {
    let (_dir, file) = file_in();
    fs::write(&file, "not json").unwrap();
    assert_eq!(ExtensionStore::new(file).get("demo"), None);
}

#[test]
fn reads_enabled_only_from_true_and_approved_only_from_a_list() {
    let (_dir, file) = file_in();
    fs::write(
        &file,
        json!({
            "yes": {"enabled": true, "approved": []},
            "text": {"enabled": "true", "approved": "all"},
            "one": {"enabled": 1},
            "empty": {},
            "list": [],
            "scalar": 5,
            "nothing": null
        })
        .to_string(),
    )
    .unwrap();
    let store = ExtensionStore::new(file);
    assert_eq!(store.get("yes"), Some(record(true, Some(&[]))));
    assert_eq!(store.get("text"), Some(record(false, None)));
    assert_eq!(store.get("one"), Some(record(false, None)));
    assert_eq!(store.get("empty"), Some(record(false, None)));
    assert_eq!(store.get("list"), Some(record(false, None)));
    assert_eq!(store.get("scalar"), None);
    assert_eq!(store.get("nothing"), None);
}

#[test]
fn starts_empty_when_the_file_is_not_an_object() {
    let (_dir, file) = file_in();
    fs::write(
        &file,
        json!([{"enabled": true, "approved": []}]).to_string(),
    )
    .unwrap();
    assert_eq!(ExtensionStore::new(file.clone()).get("0"), None);
    fs::write(&file, "7").unwrap();
    assert_eq!(ExtensionStore::new(file).get("demo"), None);
}

#[test]
fn limits_server_names_to_forty_units_and_claims_to_2048_units_before_cutting_the_list() {
    let (_dir, file) = file_in();
    let servers: Vec<Value> = std::iter::once(json!("s".repeat(41)))
        .chain(std::iter::once(json!("s".repeat(40))))
        .chain((0..70).map(|n| json!(format!("srv{n}"))))
        .collect();
    let claims: Vec<Value> = [json!("c".repeat(2049)), json!("😀".repeat(1025))]
        .into_iter()
        .chain(std::iter::once(json!("c".repeat(2048))))
        .chain(std::iter::once(json!("😀".repeat(1024))))
        .chain((0..70).map(|n| json!(format!("claim{n}"))))
        .collect();
    fs::write(
        &file,
        json!({"demo": {"enabled": true, "approved": [], "serversOff": servers, "approvedKinds": claims}})
            .to_string(),
    )
    .unwrap();
    let demo = ExtensionStore::new(file).get("demo").unwrap();
    assert_eq!(demo.servers_off.len(), 64);
    assert_eq!(demo.servers_off[0], "s".repeat(40));
    assert_eq!(demo.servers_off[1], "srv0");
    assert_eq!(demo.servers_off[63], "srv62");
    assert_eq!(demo.approved_kinds.len(), 64);
    assert_eq!(demo.approved_kinds[0], "c".repeat(2048));
    assert_eq!(demo.approved_kinds[1], "😀".repeat(1024));
    assert_eq!(demo.approved_kinds[2], "claim0");
    assert_eq!(demo.approved_kinds[63], "claim61");
}

#[test]
fn leaves_empty_kind_and_server_lists_out_of_the_file() {
    let (_dir, file) = file_in();
    let store = ExtensionStore::new(file.clone());
    store.set("demo", record(false, None)).unwrap();
    assert_eq!(
        stored(&file),
        json!({"demo": {"enabled": false, "approved": null}})
    );
    assert_eq!(
        fs::read_to_string(&file).unwrap().find("approvedKinds"),
        None
    );
}

#[test]
fn replaces_a_record_in_place_and_keeps_the_order_of_the_others() {
    let (_dir, file) = file_in();
    let store = ExtensionStore::new(file.clone());
    store.set("a", record(true, Some(&[]))).unwrap();
    store.set("b", record(true, Some(&[]))).unwrap();
    store.set("a", record(false, Some(&["notify"]))).unwrap();
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.find("\"a\"").unwrap() < text.find("\"b\"").unwrap());
    assert_eq!(store.get("a"), Some(record(false, Some(&["notify"]))));
}

#[test]
fn does_not_write_when_deleting_an_id_that_has_no_record() {
    let (_dir, file) = file_in();
    let store = ExtensionStore::new(file.clone());
    store.delete("demo").unwrap();
    assert!(!file.exists());
    store.set("demo", record(true, Some(&[]))).unwrap();
    fs::remove_file(&file).unwrap();
    store.delete("other").unwrap();
    assert!(!file.exists());
}

#[test]
fn reload_reads_the_file_again_and_forgets_what_is_gone_from_it() {
    let (_dir, file) = file_in();
    let store = ExtensionStore::new(file.clone());
    store.set("demo", record(true, Some(&["notify"]))).unwrap();
    fs::write(
        &file,
        json!({"edited": {"enabled": true, "approved": ["shell"]}}).to_string(),
    )
    .unwrap();
    assert_eq!(store.get("demo"), Some(record(true, Some(&["notify"]))));
    store.reload();
    assert_eq!(store.get("demo"), None);
    assert_eq!(store.get("edited"), Some(record(true, Some(&["shell"]))));
}

#[test]
fn keeps_the_change_in_memory_when_the_save_fails() {
    let dir = TempDir::new().unwrap();
    let blocker = dir.path().join("blocker");
    fs::write(&blocker, "file").unwrap();
    let store = ExtensionStore::new(blocker.join("extensions.json"));
    assert!(store.set("demo", record(true, Some(&[]))).is_err());
    assert_eq!(store.get("demo"), Some(record(true, Some(&[]))));
}

#[test]
fn reads_a_file_the_ts_store_wrote_and_writes_the_same_bytes_as_the_ts_store() {
    let (_dir, file) = file_in();
    fs::copy(fixture("extensions-before.json"), &file).unwrap();
    let store = ExtensionStore::new(file.clone());
    assert_eq!(
        store.get("demo"),
        Some(ExtensionRecord {
            enabled: true,
            approved: Some(caps(&["notify", "shell"])),
            approved_kinds: vec!["demo.grid:view:default:*.csv".to_owned()],
            servers_off: vec!["pyright".to_owned()],
        })
    );
    assert_eq!(store.get("plain"), Some(record(false, None)));
    assert_eq!(store.get("gone"), Some(record(true, Some(&[]))));
    store.delete("gone").unwrap();
    assert_eq!(
        fs::read(&file).unwrap(),
        fs::read(fixture("extensions-after.json")).unwrap()
    );
}
