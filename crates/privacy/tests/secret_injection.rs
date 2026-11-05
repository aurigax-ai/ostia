#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use ostia_contract::secrets::{
    SecretEntry, SecretGrant, SecretGrantMode, SecretKind, SecretSource,
};
use ostia_privacy::secret_injection::{PrepareSecretsInput, PreparedSecrets, prepare_secrets};
use ostia_privacy::ssh_agent::start_ssh_agent;
use ostia_sandbox::sandbox_tmp::{SandboxTmpDeps, SandboxTmpDirs};
use tempfile::TempDir;

const KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\nKEY-MATERIAL\n";

fn entry(id: &str, name: &str, source: SecretSource, kind: SecretKind) -> SecretEntry {
    SecretEntry {
        id: id.to_owned(),
        name: name.to_owned(),
        source,
        kind,
        editable: false,
    }
}

fn host_env(name: &str) -> SecretEntry {
    entry(
        &format!("host:env:{name}"),
        name,
        SecretSource::Host,
        SecretKind::Env,
    )
}

fn host_ssh(name: &str) -> SecretEntry {
    entry(
        &format!("host:ssh:{name}"),
        name,
        SecretSource::Host,
        SecretKind::SshKey,
    )
}

fn list() -> Vec<SecretEntry> {
    vec![
        host_env("GITHUB_TOKEN"),
        host_ssh("id_ed25519"),
        host_ssh("id_gone"),
    ]
}

fn values() -> HashMap<String, String> {
    HashMap::from([
        (
            "host:env:GITHUB_TOKEN".to_owned(),
            "ghp_real_value".to_owned(),
        ),
        ("host:ssh:id_ed25519".to_owned(), KEY.to_owned()),
    ])
}

fn grant(id: &str, mode: SecretGrantMode) -> SecretGrant {
    SecretGrant {
        id: id.to_owned(),
        mode,
        name: None,
    }
}

fn named(id: &str, mode: SecretGrantMode, name: &str) -> SecretGrant {
    SecretGrant {
        id: id.to_owned(),
        mode,
        name: Some(name.to_owned()),
    }
}

fn prepare(
    grants: &[SecretGrant],
    list: &[SecretEntry],
    values: &HashMap<String, String>,
    dir: &Path,
) -> PreparedSecrets {
    prepare_secrets(PrepareSecretsInput {
        grants,
        list,
        value: &|id| values.get(id).cloned(),
        dir,
    })
    .unwrap()
}

fn mode_of(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn tmp_dirs(root: &Path) -> SandboxTmpDirs {
    SandboxTmpDirs::new(SandboxTmpDeps {
        tmp_root: root.join("sandbox-tmp"),
        pid: 4242,
        kept: None,
    })
}

fn run_sh(script: &str, env: &HashMap<String, String>) -> String {
    let out = Command::new("/bin/sh")
        .arg("-c")
        .arg(script)
        .envs(env)
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap()
}

#[test]
fn sbx_c70_puts_an_env_granted_secret_in_the_sandboxed_shell_as_its_real_value() {
    let root = TempDir::new().unwrap();
    let tmp = tmp_dirs(root.path());
    let prepared = prepare(
        &[grant("host:env:GITHUB_TOKEN", SecretGrantMode::Env)],
        &list(),
        &values(),
        &tmp.tmp_dir("a").join("secrets"),
    );
    let out = run_sh(r#"echo "token=$GITHUB_TOKEN""#, &prepared.env);
    assert!(out.contains("token=ghp_real_value"), "{out}");
}

#[tokio::test]
async fn sbx_c71_gives_git_the_file_granted_ssh_key_through_an_agent_while_ssh_stays_hidden() {
    let root = TempDir::new().unwrap();
    let real_key = root.path().join("id_real");
    let keygen = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", ""])
        .arg("-f")
        .arg(&real_key)
        .status()
        .unwrap();
    assert!(keygen.success());
    let fingerprint_line = Command::new("ssh-keygen")
        .arg("-lf")
        .arg(&real_key)
        .output()
        .unwrap();
    let fingerprint = String::from_utf8(fingerprint_line.stdout)
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .to_owned();
    let tmp = tmp_dirs(root.path());
    let dir = tmp.tmp_dir("a").join("secrets");
    let mut all = list();
    all.push(host_ssh("id_real"));
    let real_text = fs::read_to_string(&real_key).unwrap();
    let real_values = HashMap::from([("host:ssh:id_real".to_owned(), real_text)]);
    let prepared = prepare(
        &[grant("host:ssh:id_real", SecretGrantMode::File)],
        &all,
        &real_values,
        &dir,
    );
    let agent = start_ssh_agent(&tmp.ssh_agent_socket("a"), &prepared.ssh_keys)
        .await
        .unwrap();
    let mut env = prepared.env.clone();
    env.insert(
        "SSH_AUTH_SOCK".to_owned(),
        agent.socket.to_string_lossy().into_owned(),
    );
    let out = run_sh(r#"head -1 "$OSTIA_SECRETS_DIR/id_real"; ssh-add -l"#, &env);
    agent.stop();
    assert!(out.contains("BEGIN OPENSSH PRIVATE KEY"), "{out}");
    assert!(out.contains(&fingerprint), "{out}");
    assert!(!out.contains("KEY-MATERIAL"), "{out}");
}

#[test]
fn sbx_c73_keeps_one_workspace_file_secret_unreadable_from_another_sandboxed_workspace() {
    let root = TempDir::new().unwrap();
    let tmp = tmp_dirs(root.path());
    let dir = tmp.tmp_dir("a").join("secrets");
    prepare(
        &[grant("host:ssh:id_ed25519", SecretGrantMode::File)],
        &list(),
        &values(),
        &dir,
    );
    assert_eq!(mode_of(&dir), 0o700);
    assert_eq!(mode_of(&dir.join("id_ed25519")), 0o600);
    assert!(!tmp.tmp_dir("b").starts_with(tmp.tmp_dir("a")));
    assert!(!dir.starts_with(tmp.tmp_dir("b")));
}

#[test]
fn sbx_c72_removes_the_workspace_secrets_folder_when_the_workspace_closes() {
    let root = TempDir::new().unwrap();
    let tmp = tmp_dirs(root.path());
    let dir = tmp.tmp_dir("a").join("secrets");
    prepare(
        &[grant("host:ssh:id_ed25519", SecretGrantMode::File)],
        &list(),
        &values(),
        &dir,
    );
    assert!(dir.join("id_ed25519").exists());
    tmp.remove("a").unwrap();
    assert!(!dir.exists());
}

#[test]
fn sbx_c69_reports_a_granted_host_secret_that_disappeared_and_injects_the_rest() {
    let root = TempDir::new().unwrap();
    let tmp = tmp_dirs(root.path());
    let prepared = prepare(
        &[
            grant("host:ssh:id_gone", SecretGrantMode::File),
            grant("host:env:GITHUB_TOKEN", SecretGrantMode::Env),
        ],
        &list(),
        &values(),
        &tmp.tmp_dir("b").join("secrets"),
    );
    assert_eq!(prepared.missing, vec!["id_gone".to_owned()]);
    assert_eq!(prepared.env["GITHUB_TOKEN"], "ghp_real_value");
}

#[test]
fn names_the_env_variable_after_the_label_in_upper_case_with_unsafe_characters_replaced() {
    let rows = [
        ("GITHUB_TOKEN", "GITHUB_TOKEN"),
        ("github token", "GITHUB_TOKEN"),
        ("my-key.v2", "MY_KEY_V2"),
        ("1password", "_1PASSWORD"),
        ("9", "_9"),
        ("straße", "STRASSE"),
        ("ünï", "_N_"),
        ("k😀", "K__"),
        ("a/b", "A_B"),
    ];
    for (label, expected) in rows {
        let root = TempDir::new().unwrap();
        let entry = entry("host:env:x", label, SecretSource::Host, SecretKind::Env);
        let vals = HashMap::from([("host:env:x".to_owned(), "v".to_owned())]);
        let prepared = prepare(
            &[grant("host:env:x", SecretGrantMode::Env)],
            &[entry],
            &vals,
            &root.path().join("secrets"),
        );
        assert_eq!(prepared.env.len(), 1, "{label}");
        assert_eq!(prepared.env[expected], "v", "{label}");
    }
}

#[test]
fn uses_the_grant_name_as_the_env_variable_without_changing_it() {
    let root = TempDir::new().unwrap();
    let prepared = prepare(
        &[named(
            "host:env:GITHUB_TOKEN",
            SecretGrantMode::Env,
            "my token-1",
        )],
        &list(),
        &values(),
        &root.path().join("secrets"),
    );
    assert_eq!(prepared.env["my token-1"], "ghp_real_value");
    assert_eq!(prepared.env.len(), 1);
}

#[test]
fn lets_a_later_grant_replace_an_earlier_one_with_the_same_env_name() {
    let root = TempDir::new().unwrap();
    let mut all = list();
    all.push(host_env("OTHER_TOKEN"));
    let mut vals = values();
    vals.insert("host:env:OTHER_TOKEN".to_owned(), "second".to_owned());
    let prepared = prepare(
        &[
            named("host:env:GITHUB_TOKEN", SecretGrantMode::Env, "SAME"),
            named("host:env:OTHER_TOKEN", SecretGrantMode::Env, "SAME"),
        ],
        &all,
        &vals,
        &root.path().join("secrets"),
    );
    assert_eq!(prepared.env["SAME"], "second");
}

#[test]
fn skips_a_request_grant_without_listing_it_as_missing() {
    let root = TempDir::new().unwrap();
    let dir = root.path().join("secrets");
    let prepared = prepare(
        &[
            grant("host:env:GITHUB_TOKEN", SecretGrantMode::Request),
            grant("host:ssh:id_gone", SecretGrantMode::Request),
        ],
        &list(),
        &values(),
        &dir,
    );
    assert!(prepared.env.is_empty());
    assert!(prepared.missing.is_empty());
    assert!(prepared.ssh_keys.is_empty());
    assert!(!dir.exists());
}

#[test]
fn labels_a_missing_secret_by_its_entry_name_or_by_the_last_part_of_the_grant_id() {
    let root = TempDir::new().unwrap();
    let named_entry = entry(
        "ostia:global:key",
        "Display name",
        SecretSource::Ostia,
        SecretKind::Vault,
    );
    let prepared = prepare(
        &[
            grant("ostia:global:key", SecretGrantMode::Env),
            grant("host:env:ABSENT", SecretGrantMode::Env),
            grant("host:ssh:a:b", SecretGrantMode::Env),
            grant("plain", SecretGrantMode::Env),
            grant("host:env:", SecretGrantMode::Env),
        ],
        &[named_entry],
        &HashMap::new(),
        &root.path().join("secrets"),
    );
    assert_eq!(
        prepared.missing,
        vec!["Display name", "ABSENT", "b", "plain", ""]
    );
    assert!(prepared.env.is_empty());
}

#[test]
fn does_not_ask_for_the_value_of_a_secret_that_has_no_list_entry() {
    let root = TempDir::new().unwrap();
    let asked = std::cell::RefCell::new(Vec::new());
    let prepared = prepare_secrets(PrepareSecretsInput {
        grants: &[grant("host:env:GITHUB_TOKEN", SecretGrantMode::Env)],
        list: &[],
        value: &|id| {
            asked.borrow_mut().push(id.to_owned());
            Some("v".to_owned())
        },
        dir: &root.path().join("secrets"),
    })
    .unwrap();
    assert!(asked.borrow().is_empty());
    assert_eq!(prepared.missing, vec!["GITHUB_TOKEN".to_owned()]);
}

#[test]
fn writes_a_file_grant_into_the_secrets_folder_with_private_modes_and_exports_the_folder() {
    let root = TempDir::new().unwrap();
    let dir = root.path().join("nested").join("secrets");
    let prepared = prepare(
        &[grant("host:ssh:id_ed25519", SecretGrantMode::File)],
        &list(),
        &values(),
        &dir,
    );
    assert_eq!(fs::read_to_string(dir.join("id_ed25519")).unwrap(), KEY);
    assert_eq!(mode_of(&dir), 0o700);
    assert_eq!(mode_of(&dir.join("id_ed25519")), 0o600);
    assert_eq!(
        prepared.env["OSTIA_SECRETS_DIR"],
        dir.to_string_lossy().into_owned()
    );
    assert_eq!(prepared.ssh_keys, vec![dir.join("id_ed25519")]);
}

#[test]
fn clears_the_secrets_folder_before_it_writes_a_file_grant() {
    let root = TempDir::new().unwrap();
    let dir = root.path().join("secrets");
    fs::create_dir_all(dir.join("sub")).unwrap();
    fs::write(dir.join("stale"), "old").unwrap();
    fs::write(dir.join("sub").join("deep"), "old").unwrap();
    prepare(
        &[grant("host:env:GITHUB_TOKEN", SecretGrantMode::File)],
        &list(),
        &values(),
        &dir,
    );
    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, vec!["GITHUB_TOKEN".to_owned()]);
}

#[test]
fn clears_the_secrets_folder_even_when_every_file_grant_is_missing() {
    let root = TempDir::new().unwrap();
    let dir = root.path().join("secrets");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("stale"), "old").unwrap();
    let prepared = prepare(
        &[grant("host:ssh:id_gone", SecretGrantMode::File)],
        &list(),
        &values(),
        &dir,
    );
    assert!(dir.is_dir());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    assert_eq!(prepared.missing, vec!["id_gone".to_owned()]);
    assert_eq!(prepared.env["OSTIA_SECRETS_DIR"], dir.to_string_lossy());
}

#[test]
fn leaves_the_secrets_folder_alone_when_there_is_no_file_grant() {
    let root = TempDir::new().unwrap();
    let dir = root.path().join("secrets");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("keep"), "kept").unwrap();
    let prepared = prepare(
        &[grant("host:env:GITHUB_TOKEN", SecretGrantMode::Env)],
        &list(),
        &values(),
        &dir,
    );
    assert_eq!(fs::read_to_string(dir.join("keep")).unwrap(), "kept");
    assert!(!prepared.env.contains_key("OSTIA_SECRETS_DIR"));
}

#[test]
fn names_a_secret_file_after_the_grant_name_or_the_label_with_unsafe_characters_replaced() {
    let rows = [
        ("host:env:GITHUB_TOKEN", None, "GITHUB_TOKEN"),
        (
            "host:env:GITHUB_TOKEN",
            Some("deploy key.pem"),
            "deploy_key.pem",
        ),
        ("host:env:GITHUB_TOKEN", Some("a/b c"), "a_b_c"),
        ("host:env:GITHUB_TOKEN", Some("../up"), ".._up"),
        ("host:env:GITHUB_TOKEN", Some("keep-._ok"), "keep-._ok"),
        ("host:env:GITHUB_TOKEN", Some("é😀"), "___"),
    ];
    for (id, name, expected) in rows {
        let root = TempDir::new().unwrap();
        let dir = root.path().join("secrets");
        let grant = SecretGrant {
            id: id.to_owned(),
            mode: SecretGrantMode::File,
            name: name.map(str::to_owned),
        };
        let prepared = prepare(&[grant], &list(), &values(), &dir);
        let path = dir.join(expected);
        assert!(path.is_file(), "{name:?} -> {expected}");
        assert_eq!(prepared.ssh_keys, Vec::<PathBuf>::new(), "{name:?}");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "{name:?}");
    }
}

#[test]
fn lists_only_file_granted_ssh_key_entries_as_ssh_keys() {
    let root = TempDir::new().unwrap();
    let dir = root.path().join("secrets");
    let mut all = list();
    all.push(entry(
        "ostia:global:deploy",
        "deploy",
        SecretSource::Ostia,
        SecretKind::Vault,
    ));
    let mut vals = values();
    vals.insert("ostia:global:deploy".to_owned(), "vault".to_owned());
    let prepared = prepare(
        &[
            grant("host:ssh:id_ed25519", SecretGrantMode::File),
            grant("ostia:global:deploy", SecretGrantMode::File),
            grant("host:env:GITHUB_TOKEN", SecretGrantMode::File),
        ],
        &all,
        &vals,
        &dir,
    );
    assert_eq!(prepared.ssh_keys, vec![dir.join("id_ed25519")]);
    let by_env_only = prepare(
        &[grant("host:ssh:id_ed25519", SecretGrantMode::Env)],
        &all,
        &vals,
        &dir,
    );
    assert!(by_env_only.ssh_keys.is_empty());
    assert_eq!(by_env_only.env["ID_ED25519"], KEY);
}

fn file_grant_setup() -> (Vec<SecretGrant>, Vec<SecretEntry>, HashMap<String, String>) {
    (
        vec![grant("host:ssh:id_ed25519", SecretGrantMode::File)],
        list(),
        values(),
    )
}

#[test]
fn refuses_to_write_through_a_symlink_planted_at_a_secret_file() {
    let root = TempDir::new().unwrap();
    let dir = root.path().join("secrets");
    let victim = root.path().join("victim");
    fs::write(&victim, "keep").unwrap();
    let (grants, entries, vals) = file_grant_setup();
    let result = prepare_secrets(PrepareSecretsInput {
        grants: &grants,
        list: &entries,
        value: &|id| {
            if !dir.join("id_ed25519").exists() {
                std::os::unix::fs::symlink(&victim, dir.join("id_ed25519")).unwrap();
            }
            vals.get(id).cloned()
        },
        dir: &dir,
    });
    assert!(result.is_err());
    assert_eq!(fs::read_to_string(&victim).unwrap(), "keep");
}

#[test]
fn refuses_a_secret_file_that_already_exists() {
    let root = TempDir::new().unwrap();
    let dir = root.path().join("secrets");
    let (grants, entries, vals) = file_grant_setup();
    let result = prepare_secrets(PrepareSecretsInput {
        grants: &grants,
        list: &entries,
        value: &|id| {
            fs::write(dir.join("id_ed25519"), "planted").unwrap();
            vals.get(id).cloned()
        },
        dir: &dir,
    });
    assert!(result.is_err());
}

#[test]
fn replaces_a_symlink_at_the_secrets_folder_with_a_real_folder() {
    let root = TempDir::new().unwrap();
    let dir = root.path().join("secrets");
    let elsewhere = root.path().join("elsewhere");
    fs::create_dir(&elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &dir).unwrap();
    let (grants, entries, vals) = file_grant_setup();
    prepare(&grants, &entries, &vals, &dir);
    assert!(fs::symlink_metadata(&dir).unwrap().is_dir());
    assert!(!fs::symlink_metadata(&dir).unwrap().is_symlink());
    assert!(fs::read_dir(&elsewhere).unwrap().next().is_none());
}
