#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;

use ostia_sandbox::spawn_env::sandbox_spawn_env;

fn env(items: &[(&str, &str)]) -> BTreeMap<String, String> {
    items
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect()
}

#[test]
fn drops_the_agent_sockets_a_sandbox_must_not_reach() {
    let out = sandbox_spawn_env(&env(&[
        ("PATH", "/bin"),
        ("SSH_AUTH_SOCK", "/run/ssh"),
        ("GPG_AGENT_INFO", "x"),
    ]));
    assert_eq!(out, env(&[("PATH", "/bin")]));
}

#[test]
fn drops_the_artifact_folder_and_pad_which_the_sandbox_does_not_bind_and_keeps_the_workspace_folder()
 {
    let out = sandbox_spawn_env(&env(&[
        ("PATH", "/bin"),
        ("OSTIA_PANE_ID", "p1"),
        ("OSTIA_WORKSPACE_DIR", "/home/u/project"),
        ("OSTIA_ARTIFACTS", "/data/artifacts/w1"),
        ("OSTIA_PAD", "/data/artifacts/w1/PAD.md"),
    ]));
    assert_eq!(
        out,
        env(&[
            ("PATH", "/bin"),
            ("OSTIA_PANE_ID", "p1"),
            ("OSTIA_WORKSPACE_DIR", "/home/u/project"),
        ])
    );
}

#[test]
fn drops_every_agent_socket_variable() {
    for name in ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "GPG_AGENT_INFO"] {
        let out = sandbox_spawn_env(&env(&[("PATH", "/bin"), (name, "x")]));
        assert_eq!(out, env(&[("PATH", "/bin")]), "{name}");
    }
}

#[test]
fn leaves_the_input_untouched_and_returns_an_empty_env_for_an_empty_one() {
    let input = env(&[("SSH_AUTH_SOCK", "/run/ssh"), ("HOME", "/home/u")]);
    let out = sandbox_spawn_env(&input);
    assert_eq!(out, env(&[("HOME", "/home/u")]));
    assert_eq!(input.len(), 2);
    assert!(sandbox_spawn_env(&BTreeMap::new()).is_empty());
}
