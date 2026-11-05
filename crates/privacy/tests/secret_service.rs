#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::PathBuf;
use std::sync::Arc;

use ostia_contract::approvals::{ApprovalAnswer, ApprovalOutcome};
use ostia_contract::secrets::{SecretEntry, SecretKind, SecretSource};
use ostia_privacy::secret_service::{
    SecretAsk, SecretGetError, SecretService, SecretServiceDeps, VaultKey, VaultScope,
};
use parking_lot::Mutex;
use tempfile::TempDir;

const HEADER: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\nKEYDATA\n";

type Asks = Arc<Mutex<Vec<SecretAsk>>>;
type Reads = Arc<Mutex<Vec<(String, VaultScope, String)>>>;

struct Options {
    outcome: ApprovalOutcome,
    granted: Vec<String>,
    env: Vec<(&'static str, &'static str)>,
    gh_token: Option<&'static str>,
    vault: Vec<(&'static str, VaultScope)>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            outcome: ApprovalOutcome::Answer(ApprovalAnswer::Once),
            granted: Vec::new(),
            env: vec![
                ("GITHUB_TOKEN", "ghp_real"),
                ("PATH", "/usr/bin"),
                ("DB_PASSWORD", "hunter2"),
            ],
            gh_token: None,
            vault: vec![("API_KEY", VaultScope::Global)],
        }
    }
}

struct Fixture {
    home: TempDir,
    service: SecretService,
    asks: Asks,
    reads: Reads,
}

fn home_with_keys() -> TempDir {
    let home = TempDir::new().unwrap();
    let ssh = home.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    fs::write(ssh.join("id_ed25519"), HEADER).unwrap();
    fs::write(ssh.join("id_ed25519.pub"), "ssh-ed25519 AAAA").unwrap();
    fs::write(ssh.join("known_hosts"), "github.com ssh-ed25519 AAAA").unwrap();
    home
}

fn setup(options: Options) -> Fixture {
    let home = home_with_keys();
    let asks: Asks = Arc::new(Mutex::new(Vec::new()));
    let reads: Reads = Arc::new(Mutex::new(Vec::new()));
    let home_path = home.path().to_path_buf();
    let env: HashMap<String, String> = options
        .env
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let vault = options.vault.clone();
    let vault_reads = reads.clone();
    let ask_log = asks.clone();
    let outcome = options.outcome;
    let granted = options.granted.clone();
    let gh_token = options.gh_token;
    let service = SecretService::new(SecretServiceDeps {
        home: Box::new(move || home_path.clone()),
        env: Box::new(move || env.clone()),
        gh_token: Box::new(move || gh_token.map(str::to_owned)),
        vault_list: Box::new(move |_| {
            vault
                .iter()
                .map(|(key, scope)| VaultKey {
                    key: (*key).to_owned(),
                    scope: *scope,
                })
                .collect()
        }),
        vault_get: Box::new(move |key, scope, workspace_id| {
            vault_reads
                .lock()
                .push((key.to_owned(), scope, workspace_id.to_owned()));
            (key == "API_KEY").then(|| "vault-value".to_owned())
        }),
        granted_ids: Box::new(move |_| granted.clone()),
        ask: Box::new(move |ask| {
            ask_log.lock().push(ask);
            Box::pin(async move { outcome })
        }),
    });
    Fixture {
        home,
        service,
        asks,
        reads,
    }
}

fn names(entries: &[SecretEntry]) -> Vec<&str> {
    entries.iter().map(|s| s.name.as_str()).collect()
}

fn by_name<'a>(entries: &'a [SecretEntry], name: &str) -> &'a SecretEntry {
    entries.iter().find(|s| s.name == name).unwrap()
}

fn reasons(asks: &Asks) -> Vec<String> {
    asks.lock().iter().map(|a| a.reason.clone()).collect()
}

fn ssh_dir(fixture: &Fixture) -> PathBuf {
    fixture.home.path().join(".ssh")
}

#[test]
fn sbx_c67_lists_host_ssh_keys_and_token_like_env_vars_as_host_and_the_vault_as_ostia() {
    let fixture = setup(Options::default());
    let list = fixture.service.list("ws");
    let key = by_name(&list, "id_ed25519");
    assert_eq!(
        (key.source, key.kind),
        (SecretSource::Host, SecretKind::SshKey)
    );
    assert_eq!(by_name(&list, "GITHUB_TOKEN").source, SecretSource::Host);
    assert_eq!(by_name(&list, "DB_PASSWORD").source, SecretSource::Host);
    assert_eq!(by_name(&list, "API_KEY").source, SecretSource::Ostia);
    assert!(!names(&list).contains(&"PATH"));
    assert!(!names(&list).contains(&"id_ed25519.pub"));
    assert!(!names(&list).contains(&"known_hosts"));
}

#[test]
fn sbx_c68_marks_host_secrets_read_only_so_nothing_offers_to_edit_or_delete_them() {
    let fixture = setup(Options {
        gh_token: Some("gho_x"),
        ..Options::default()
    });
    let list = fixture.service.list("ws");
    assert!(list.len() >= 5);
    for secret in &list {
        assert_eq!(secret.editable, secret.source == SecretSource::Ostia);
    }
}

#[tokio::test]
async fn sbx_c74_hands_over_a_value_once_after_the_human_allows_it_and_asks_again_next_time() {
    let fixture = setup(Options::default());
    assert_eq!(
        fixture
            .service
            .get("ws", "pane", "DB_PASSWORD", "run migrations")
            .await,
        Ok("hunter2".to_owned())
    );
    let _ = fixture
        .service
        .get("ws", "pane", "DB_PASSWORD", "again")
        .await;
    assert_eq!(reasons(&fixture.asks), vec!["run migrations", "again"]);
}

#[test]
fn sbx_c75_lists_names_and_labels_only_never_a_value() {
    let fixture = setup(Options::default());
    let text = serde_json::to_string(&fixture.service.list("ws")).unwrap();
    assert!(!text.contains("hunter2"));
    assert!(!text.contains("ghp_real"));
    assert!(!text.contains("KEYDATA"));
    assert!(!text.contains("vault-value"));
}

#[tokio::test]
async fn sbx_c76_returns_no_value_when_the_human_denies_or_the_card_times_out() {
    for outcome in [
        ApprovalOutcome::Answer(ApprovalAnswer::Deny),
        ApprovalOutcome::Timeout,
    ] {
        let fixture = setup(Options {
            outcome,
            ..Options::default()
        });
        let res = fixture.service.get("ws", "pane", "DB_PASSWORD", "").await;
        assert_eq!(res, Err(SecretGetError::Denied), "{outcome:?}");
        assert!(!format!("{res:?}").contains("hunter2"));
    }
}

#[tokio::test]
async fn sbx_c77_fails_for_an_unknown_name_without_asking() {
    let fixture = setup(Options::default());
    assert_eq!(
        fixture.service.get("ws", "pane", "NOPE", "").await,
        Err(SecretGetError::UnknownSecret)
    );
    assert!(fixture.asks.lock().is_empty());
}

#[test]
fn lists_ssh_keys_then_sorted_token_env_vars_then_the_gh_token_then_the_vault() {
    let fixture = setup(Options {
        env: vec![
            ("ZED_SECRET", "z"),
            ("ALPHA_KEY", "a"),
            ("MID_PASSWORD", "m"),
            ("BETA_TOKEN", "b"),
        ],
        gh_token: Some("gho_x"),
        vault: vec![
            ("GLOBAL_ONE", VaultScope::Global),
            ("PROJ", VaultScope::Project),
        ],
        ..Options::default()
    });
    let list = fixture.service.list("ws");
    let rows: Vec<(String, String, SecretSource, SecretKind, bool)> = list
        .iter()
        .map(|s| (s.id.clone(), s.name.clone(), s.source, s.kind, s.editable))
        .collect();
    assert_eq!(
        rows,
        vec![
            (
                "host:ssh:id_ed25519".to_owned(),
                "id_ed25519".to_owned(),
                SecretSource::Host,
                SecretKind::SshKey,
                false
            ),
            (
                "host:env:ALPHA_KEY".to_owned(),
                "ALPHA_KEY".to_owned(),
                SecretSource::Host,
                SecretKind::Env,
                false
            ),
            (
                "host:env:BETA_TOKEN".to_owned(),
                "BETA_TOKEN".to_owned(),
                SecretSource::Host,
                SecretKind::Env,
                false
            ),
            (
                "host:env:MID_PASSWORD".to_owned(),
                "MID_PASSWORD".to_owned(),
                SecretSource::Host,
                SecretKind::Env,
                false
            ),
            (
                "host:env:ZED_SECRET".to_owned(),
                "ZED_SECRET".to_owned(),
                SecretSource::Host,
                SecretKind::Env,
                false
            ),
            (
                "host:gh".to_owned(),
                "gh auth token".to_owned(),
                SecretSource::Host,
                SecretKind::GhToken,
                false
            ),
            (
                "ostia:global:GLOBAL_ONE".to_owned(),
                "GLOBAL_ONE".to_owned(),
                SecretSource::Ostia,
                SecretKind::Vault,
                true
            ),
            (
                "ostia:project:PROJ".to_owned(),
                "PROJ".to_owned(),
                SecretSource::Ostia,
                SecretKind::Vault,
                true
            ),
        ]
    );
}

#[test]
fn lists_only_env_names_that_end_in_an_underscore_and_a_secret_word_and_have_a_value() {
    let fixture = setup(Options {
        env: vec![
            ("TOKEN", "x"),
            ("MY_TOKENS", "x"),
            ("my_token", "x"),
            ("EMPTY_TOKEN", ""),
            ("A_KEY", "x"),
            ("SOME_SECRET", "x"),
            ("PGPASSWORD", "x"),
            ("X_PASSWORD", "x"),
        ],
        ..Options::default()
    });
    let list = fixture.service.list("ws");
    let env_names: Vec<&str> = list
        .iter()
        .filter(|s| s.kind == SecretKind::Env)
        .map(|s| s.name.as_str())
        .collect();
    assert_eq!(env_names, vec!["A_KEY", "SOME_SECRET", "X_PASSWORD"]);
}

#[test]
fn adds_the_gh_token_entry_only_when_gh_has_a_token() {
    let without = setup(Options::default());
    assert!(!names(&without.service.list("ws")).contains(&"gh auth token"));
    let with = setup(Options {
        gh_token: Some(""),
        ..Options::default()
    });
    assert!(names(&with.service.list("ws")).contains(&"gh auth token"));
}

#[test]
fn lists_no_ssh_keys_when_the_ssh_folder_is_missing() {
    let fixture = setup(Options::default());
    fs::remove_dir_all(ssh_dir(&fixture)).unwrap();
    let list = fixture.service.list("ws");
    assert!(list.iter().all(|s| s.kind != SecretKind::SshKey));
    assert!(names(&list).contains(&"GITHUB_TOKEN"));
}

#[test]
fn lists_a_file_only_when_a_private_key_header_is_in_its_first_128_characters() {
    let fixture = setup(Options::default());
    let ssh = ssh_dir(&fixture);
    fs::write(
        ssh.join("late_header"),
        format!("{}{HEADER}", " ".repeat(200)),
    )
    .unwrap();
    fs::write(
        ssh.join("edge_header"),
        format!("{}{HEADER}", " ".repeat(128 - 35)),
    )
    .unwrap();
    fs::write(
        ssh.join("edge_over"),
        format!("{}{HEADER}", " ".repeat(128 - 34)),
    )
    .unwrap();
    fs::write(ssh.join("rsa"), "-----BEGIN RSA PRIVATE KEY-----\nx").unwrap();
    fs::write(ssh.join("plain_pem"), "-----BEGIN PRIVATE KEY-----\nx").unwrap();
    fs::write(ssh.join("certificate"), "-----BEGIN CERTIFICATE-----\nx").unwrap();
    fs::write(ssh.join("config"), "Host *\n  User me\n").unwrap();
    fs::write(ssh.join("empty"), "").unwrap();
    let list = fixture.service.list("ws");
    let keys: Vec<&str> = list
        .iter()
        .filter(|s| s.kind == SecretKind::SshKey)
        .map(|s| s.name.as_str())
        .collect();
    let mut sorted = keys.clone();
    sorted.sort_unstable();
    assert_eq!(
        sorted,
        vec!["edge_header", "id_ed25519", "plain_pem", "rsa"]
    );
}

#[test]
fn finds_a_key_header_after_bytes_that_are_not_utf8() {
    let fixture = setup(Options::default());
    let mut bytes = vec![0xff, 0xfe, 0xfd];
    bytes.extend_from_slice(HEADER.as_bytes());
    fs::write(ssh_dir(&fixture).join("binary_first"), bytes).unwrap();
    let list = fixture.service.list("ws");
    assert!(names(&list).contains(&"binary_first"));
}

#[test]
fn skips_folders_and_unreadable_files_in_the_ssh_folder_and_follows_a_link_to_a_key() {
    let fixture = setup(Options::default());
    let ssh = ssh_dir(&fixture);
    fs::create_dir(ssh.join("a_folder")).unwrap();
    fs::write(ssh.join("a_folder").join("inner"), HEADER).unwrap();
    fs::write(ssh.join("locked"), HEADER).unwrap();
    fs::set_permissions(ssh.join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
    symlink(ssh.join("id_ed25519"), ssh.join("linked")).unwrap();
    symlink(ssh.join("no_such_target"), ssh.join("dangling")).unwrap();
    let list = fixture.service.list("ws");
    let keys: Vec<&str> = list
        .iter()
        .filter(|s| s.kind == SecretKind::SshKey)
        .map(|s| s.name.as_str())
        .collect();
    let mut sorted = keys.clone();
    sorted.sort_unstable();
    assert_eq!(sorted, vec!["id_ed25519", "linked"]);
}

#[test]
fn reads_a_host_ssh_key_env_var_gh_token_and_vault_value_by_id() {
    let fixture = setup(Options {
        gh_token: Some("gho_x"),
        vault: vec![
            ("API_KEY", VaultScope::Global),
            ("API_KEY", VaultScope::Project),
        ],
        ..Options::default()
    });
    let service = &fixture.service;
    assert_eq!(
        service.value("ws", "host:ssh:id_ed25519").as_deref(),
        Some(HEADER)
    );
    assert_eq!(
        service.value("ws", "host:env:GITHUB_TOKEN").as_deref(),
        Some("ghp_real")
    );
    assert_eq!(
        service.value("ws", "host:env:PATH").as_deref(),
        Some("/usr/bin")
    );
    assert_eq!(service.value("ws", "host:gh").as_deref(), Some("gho_x"));
    assert_eq!(
        service.value("ws1", "ostia:global:API_KEY").as_deref(),
        Some("vault-value")
    );
    assert_eq!(
        service.value("ws2", "ostia:project:API_KEY").as_deref(),
        Some("vault-value")
    );
    assert_eq!(
        *fixture.reads.lock(),
        vec![
            ("API_KEY".to_owned(), VaultScope::Global, "ws1".to_owned()),
            ("API_KEY".to_owned(), VaultScope::Project, "ws2".to_owned()),
        ]
    );
}

#[test]
fn reads_no_value_for_a_missing_or_malformed_id() {
    let fixture = setup(Options::default());
    let service = &fixture.service;
    for id in [
        "host:ssh:gone",
        "host:env:NOT_SET",
        "host:gh",
        "host:other:x",
        "ostia:team:API_KEY",
        "ostia:global:UNKNOWN",
        "other:env:GITHUB_TOKEN",
        "GITHUB_TOKEN",
        "",
    ] {
        assert_eq!(service.value("ws", id), None, "{id}");
    }
}

#[test]
fn reads_an_empty_env_value_and_an_empty_gh_token_as_empty_text() {
    let fixture = setup(Options {
        env: vec![("EMPTY_TOKEN", "")],
        gh_token: Some(""),
        ..Options::default()
    });
    assert_eq!(
        fixture
            .service
            .value("ws", "host:env:EMPTY_TOKEN")
            .as_deref(),
        Some("")
    );
    assert_eq!(fixture.service.value("ws", "host:gh").as_deref(), Some(""));
}

#[test]
fn keeps_colons_in_the_tail_of_an_id() {
    let fixture = setup(Options {
        env: vec![("ODD:NAME", "colon-value")],
        ..Options::default()
    });
    assert_eq!(
        fixture.service.value("ws", "host:env:ODD:NAME").as_deref(),
        Some("colon-value")
    );
}

#[test]
fn reads_a_ssh_key_that_is_not_utf8_with_replacement_characters() {
    let fixture = setup(Options::default());
    fs::write(ssh_dir(&fixture).join("id_bin"), [0xffu8, 0x41]).unwrap();
    assert_eq!(
        fixture.service.value("ws", "host:ssh:id_bin").as_deref(),
        Some("\u{fffd}A")
    );
}

#[tokio::test]
async fn finds_a_secret_by_its_id_as_well_as_by_its_name() {
    let fixture = setup(Options::default());
    assert_eq!(
        fixture
            .service
            .get("ws", "pane", "host:env:DB_PASSWORD", "r")
            .await,
        Ok("hunter2".to_owned())
    );
    assert_eq!(fixture.asks.lock()[0].name, "DB_PASSWORD");
}

#[tokio::test]
async fn refuses_a_name_that_matches_two_secrets_without_asking() {
    let fixture = setup(Options {
        vault: vec![("GITHUB_TOKEN", VaultScope::Global)],
        ..Options::default()
    });
    assert_eq!(
        fixture.service.get("ws", "pane", "GITHUB_TOKEN", "r").await,
        Err(SecretGetError::Ambiguous)
    );
    assert!(fixture.asks.lock().is_empty());
    assert_eq!(
        fixture
            .service
            .get("ws", "pane", "ostia:global:GITHUB_TOKEN", "r")
            .await,
        Err(SecretGetError::Missing)
    );
}

#[tokio::test]
async fn asks_with_the_workspace_pane_secret_name_and_reason() {
    let fixture = setup(Options::default());
    let _ = fixture
        .service
        .get("ws-1", "pane-9", "host:env:DB_PASSWORD", "deploy the app")
        .await;
    assert_eq!(
        *fixture.asks.lock(),
        vec![SecretAsk {
            workspace_id: "ws-1".to_owned(),
            pane_id: "pane-9".to_owned(),
            name: "DB_PASSWORD".to_owned(),
            reason: "deploy the app".to_owned(),
        }]
    );
}

#[tokio::test]
async fn hands_over_a_granted_secret_without_asking() {
    let fixture = setup(Options {
        granted: vec!["host:env:DB_PASSWORD".to_owned()],
        outcome: ApprovalOutcome::Answer(ApprovalAnswer::Deny),
        ..Options::default()
    });
    assert_eq!(
        fixture.service.get("ws", "pane", "DB_PASSWORD", "r").await,
        Ok("hunter2".to_owned())
    );
    assert!(fixture.asks.lock().is_empty());
}

#[tokio::test]
async fn trusts_a_secret_for_the_workspace_after_a_session_answer_until_it_is_forgotten() {
    let fixture = setup(Options {
        outcome: ApprovalOutcome::Answer(ApprovalAnswer::Session),
        ..Options::default()
    });
    let service = &fixture.service;
    for reason in ["first", "second", "third"] {
        assert_eq!(
            service.get("ws", "pane", "DB_PASSWORD", reason).await,
            Ok("hunter2".to_owned())
        );
    }
    assert_eq!(reasons(&fixture.asks), vec!["first"]);
    let _ = service
        .get("other", "pane", "DB_PASSWORD", "other ws")
        .await;
    assert_eq!(reasons(&fixture.asks), vec!["first", "other ws"]);
    let _ = service
        .get("ws", "pane", "GITHUB_TOKEN", "other secret")
        .await;
    assert_eq!(
        reasons(&fixture.asks),
        vec!["first", "other ws", "other secret"]
    );
    service.forget("ws");
    let _ = service
        .get("ws", "pane", "DB_PASSWORD", "after forget")
        .await;
    assert_eq!(reasons(&fixture.asks).last().unwrap(), "after forget");
    assert_eq!(fixture.asks.lock().len(), 4);
}

#[tokio::test]
async fn forgets_only_the_named_workspace() {
    let fixture = setup(Options {
        outcome: ApprovalOutcome::Answer(ApprovalAnswer::Session),
        ..Options::default()
    });
    let service = &fixture.service;
    let _ = service.get("a", "pane", "DB_PASSWORD", "a1").await;
    let _ = service.get("b", "pane", "DB_PASSWORD", "b1").await;
    service.forget("a");
    service.forget("never-seen");
    let _ = service.get("b", "pane", "DB_PASSWORD", "b2").await;
    let _ = service.get("a", "pane", "DB_PASSWORD", "a2").await;
    assert_eq!(reasons(&fixture.asks), vec!["a1", "b1", "a2"]);
}

#[tokio::test]
async fn does_not_remember_a_once_answer() {
    let fixture = setup(Options::default());
    let service = &fixture.service;
    let _ = service.get("ws", "pane", "DB_PASSWORD", "one").await;
    let _ = service.get("ws", "pane", "DB_PASSWORD", "two").await;
    assert_eq!(reasons(&fixture.asks), vec!["one", "two"]);
}

#[tokio::test]
async fn refuses_every_outcome_except_once_and_session() {
    for outcome in [
        ApprovalOutcome::Answer(ApprovalAnswer::Deny),
        ApprovalOutcome::Answer(ApprovalAnswer::Always),
        ApprovalOutcome::Answer(ApprovalAnswer::Workspace),
        ApprovalOutcome::Auto,
        ApprovalOutcome::Timeout,
    ] {
        let fixture = setup(Options {
            outcome,
            ..Options::default()
        });
        assert_eq!(
            fixture.service.get("ws", "pane", "DB_PASSWORD", "r").await,
            Err(SecretGetError::Denied),
            "{outcome:?}"
        );
        assert_eq!(
            fixture.service.get("ws", "pane", "DB_PASSWORD", "r").await,
            Err(SecretGetError::Denied),
            "{outcome:?} twice"
        );
        assert_eq!(fixture.asks.lock().len(), 2, "{outcome:?}");
    }
}

#[tokio::test]
async fn reports_a_removed_ssh_key_as_unknown_without_asking() {
    let fixture = setup(Options::default());
    fs::remove_file(ssh_dir(&fixture).join("id_ed25519")).unwrap();
    assert_eq!(
        fixture
            .service
            .get("ws", "pane", "host:ssh:id_ed25519", "r")
            .await,
        Err(SecretGetError::UnknownSecret)
    );
    assert!(fixture.asks.lock().is_empty());
}

#[tokio::test]
async fn finds_the_gh_token_by_its_label() {
    let fixture = setup(Options {
        gh_token: Some("gho_x"),
        ..Options::default()
    });
    assert_eq!(
        fixture
            .service
            .get("ws", "pane", "gh auth token", "r")
            .await,
        Ok("gho_x".to_owned())
    );
    assert_eq!(fixture.asks.lock()[0].name, "gh auth token");
}

#[tokio::test]
async fn reports_missing_when_the_value_is_gone_after_the_listing() {
    let fixture = setup(Options {
        vault: vec![("GONE", VaultScope::Global)],
        ..Options::default()
    });
    assert_eq!(
        fixture.service.get("ws", "pane", "GONE", "r").await,
        Err(SecretGetError::Missing)
    );
    assert_eq!(reasons(&fixture.asks), vec!["r"]);
}

#[test]
fn writes_the_get_error_as_the_kebab_case_word_the_clients_read() {
    let rows = [
        (SecretGetError::UnknownSecret, "unknown-secret"),
        (SecretGetError::Ambiguous, "ambiguous"),
        (SecretGetError::Denied, "denied"),
        (SecretGetError::Missing, "missing"),
    ];
    for (error, word) in rows {
        assert_eq!(serde_json::to_value(error).unwrap(), word);
    }
}
