#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::symlink;

use ostia_base::Platform;
use ostia_contract::sandbox::{DEFAULT_ALLOW_READ, SandboxSwitches};
use ostia_sandbox::srt_config::{
    FixedWorkspace, HOME_HIDDEN_FILES, SandboxBasePaths, SandboxFolderReason, SandboxPaths,
    SrtPolicy, build_srt_config, can_block_sockets, fixed_policy, folder_problem,
    reachable_container_sockets, srt_vendor_dir,
};
use serde_json::json;
use tempfile::TempDir;

const PACKAGED: &str = "/opt/ostia/resources/app.asar";
const VENDOR: &str =
    "/opt/ostia/resources/app.asar.unpacked/node_modules/@anthropic-ai/sandbox-runtime/vendor";

const ON: SandboxSwitches = SandboxSwitches {
    unix_sockets: true,
    git_config: false,
    strict_domains: false,
};
const OFF: SandboxSwitches = SandboxSwitches {
    unix_sockets: false,
    ..ON
};

struct App {
    _dir: TempDir,
    path: String,
}

fn real_temp() -> (TempDir, String) {
    let dir = TempDir::new().unwrap();
    let path = fs::canonicalize(dir.path())
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    (dir, path)
}

fn app() -> App {
    let (dir, path) = real_temp();
    fs::create_dir_all(format!("{path}/.git/hooks")).unwrap();
    fs::create_dir(format!("{path}/.ostia")).unwrap();
    fs::write(format!("{path}/.git/config"), "").unwrap();
    fs::write(format!("{path}/.envrc"), "").unwrap();
    fs::write(format!("{path}/.ostia/vault.json"), "").unwrap();
    App { _dir: dir, path }
}

fn s(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn has_all(list: &[String], items: &[&str]) -> bool {
    items
        .iter()
        .all(|item| list.iter().any(|entry| entry == item))
}

fn has(list: &[String], item: &str) -> bool {
    list.iter().any(|entry| entry == item)
}

fn base() -> SandboxBasePaths {
    SandboxBasePaths {
        home: "/home/u".to_owned(),
        socket_path: "/run/ostia.sock".to_owned(),
        ..SandboxBasePaths::default()
    }
}

fn paths(work_dir: &str) -> SandboxPaths {
    SandboxPaths {
        base: base(),
        work_dir: work_dir.to_owned(),
        tmp_dir: "/tmp/sbx/w1".to_owned(),
        ..SandboxPaths::default()
    }
}

fn guarded() -> SandboxBasePaths {
    SandboxBasePaths {
        data_dirs: s(&["/home/u/.local/share/ostia", "/home/u/.config/ostia"]),
        runtime_dir: Some("/run/user/1000".to_owned()),
        socket_path: "/run/user/1000/ostia-1.sock".to_owned(),
        agent_sockets: s(&["/tmp/ssh-abc/agent.1"]),
        container_sockets: s(&["/run/docker.sock"]),
        tmp_root: Some("/tmp/ostia-sandbox".to_owned()),
        ..base()
    }
}

fn guarded_paths(work_dir: &str) -> SandboxPaths {
    SandboxPaths {
        base: guarded(),
        ..paths(work_dir)
    }
}

fn workspace(work_dir: &str) -> FixedWorkspace {
    FixedWorkspace {
        work_dir: work_dir.to_owned(),
        tmp_dir: "/tmp/sbx/w1".to_owned(),
        plugins_dir: None,
    }
}

fn policy() -> SrtPolicy {
    SrtPolicy::default()
}

#[test]
fn points_a_packaged_app_at_the_unpacked_copy_which_bwrap_can_bind() {
    assert_eq!(srt_vendor_dir(PACKAGED), VENDOR);
}

#[test]
fn leaves_an_unpackaged_app_folder_as_it_is() {
    assert_eq!(
        srt_vendor_dir("/home/u/ostia"),
        "/home/u/ostia/node_modules/@anthropic-ai/sandbox-runtime/vendor"
    );
}

#[test]
fn lets_the_shell_rc_read_its_colour_theme_configs_while_the_rest_of_home_stays_hidden() {
    let app = app();
    let config = build_srt_config(
        &SrtPolicy {
            allow_read: DEFAULT_ALLOW_READ.map(String::from).to_vec(),
            ..policy()
        },
        &paths(&app.path),
        Platform::Linux,
        "x64",
    );
    let fs = config.filesystem;
    assert!(has(&fs.deny_read, "/home/u"));
    assert!(has_all(
        &fs.allow_read,
        &[
            "/home/u/.zshrc",
            "/home/u/.config/vivid",
            "/home/u/.config/bat"
        ]
    ));
    assert!(!has(&fs.allow_read, "/home/u/.config"));
    assert!(!has(&fs.allow_write, "/home/u/.config/vivid"));
}

#[test]
fn lists_only_the_sockets_this_user_can_connect_to_once_per_real_path() {
    let reachable = |path: &str| path.ends_with("docker.sock");
    let resolve = |path: &str| Some(path.replace("/var/run/", "/run/"));
    assert_eq!(
        reachable_container_sockets(&reachable, &resolve),
        s(&["/run/docker.sock"])
    );
    assert_eq!(
        reachable_container_sockets(&|_: &str| false, &resolve),
        Vec::<String>::new()
    );
}

#[test]
fn keeps_the_listed_socket_path_when_it_cannot_be_resolved() {
    let found = reachable_container_sockets(
        &|path: &str| path == "/run/podman/podman.sock",
        &|_: &str| None,
    );
    assert_eq!(found, s(&["/run/podman/podman.sock"]));
}

#[test]
fn hides_the_reachable_ones_from_the_sandbox_since_docker_would_hand_out_the_host() {
    let app = app();
    let config = build_srt_config(
        &policy(),
        &SandboxPaths {
            base: SandboxBasePaths {
                container_sockets: s(&["/run/docker.sock"]),
                ..base()
            },
            ..paths(&app.path)
        },
        Platform::Linux,
        "x64",
    );
    assert!(has(&config.filesystem.deny_read, "/run/docker.sock"));
    assert!(!has(&config.filesystem.allow_read, "/run/docker.sock"));
}

#[test]
fn hands_srt_the_unpacked_java_agent_and_apply_seccomp_on_linux() {
    let app = app();
    let with_vendor = SandboxPaths {
        base: SandboxBasePaths {
            srt_vendor_dir: Some(VENDOR.to_owned()),
            ..base()
        },
        ..paths(&app.path)
    };
    let config = build_srt_config(&policy(), &with_vendor, Platform::Linux, "x64");
    assert_eq!(
        config.java_agent_jar_path.as_deref(),
        Some(format!("{VENDOR}/java-proxy-agent/srt-proxy-agent.jar").as_str())
    );
    assert_eq!(
        config
            .seccomp
            .as_ref()
            .map(|seccomp| seccomp.apply_path.as_str()),
        Some(format!("{VENDOR}/seccomp/x64/apply-seccomp").as_str())
    );
}

#[test]
fn gives_macos_only_the_java_agent() {
    let app = app();
    let with_vendor = SandboxPaths {
        base: SandboxBasePaths {
            srt_vendor_dir: Some(VENDOR.to_owned()),
            ..base()
        },
        ..paths(&app.path)
    };
    let config = build_srt_config(&policy(), &with_vendor, Platform::Darwin, "arm64");
    assert_eq!(
        config.java_agent_jar_path.as_deref(),
        Some(format!("{VENDOR}/java-proxy-agent/srt-proxy-agent.jar").as_str())
    );
    assert!(config.seccomp.is_none());
}

#[test]
fn adds_no_seccomp_on_an_unsupported_linux_arch_and_no_vendored_binary_without_a_vendor_folder() {
    let app = app();
    let with_vendor = SandboxPaths {
        base: SandboxBasePaths {
            srt_vendor_dir: Some(VENDOR.to_owned()),
            ..base()
        },
        ..paths(&app.path)
    };
    let odd = build_srt_config(&policy(), &with_vendor, Platform::Linux, "riscv64");
    assert!(odd.java_agent_jar_path.is_some());
    assert!(odd.seccomp.is_none());
    let arm = build_srt_config(&policy(), &with_vendor, Platform::Linux, "arm64");
    assert_eq!(
        arm.seccomp
            .as_ref()
            .map(|seccomp| seccomp.apply_path.as_str()),
        Some(format!("{VENDOR}/seccomp/arm64/apply-seccomp").as_str())
    );
    let bare = build_srt_config(&policy(), &paths(&app.path), Platform::Linux, "x64");
    assert!(bare.java_agent_jar_path.is_none());
    assert!(bare.seccomp.is_none());
}

#[test]
fn hides_the_codex_app_server_socket_folder_from_a_sandbox_and_never_opens_it_by_a_human_allow_list_entry()
 {
    let app = app();
    let with_codex = SandboxPaths {
        base: SandboxBasePaths {
            codex_dir: Some("/tmp/ostia-codex-1000".to_owned()),
            ..guarded()
        },
        ..paths(&app.path)
    };
    let config = build_srt_config(
        &SrtPolicy {
            allow_read: s(&["/tmp/ostia-codex-1000", "/tmp/ostia-codex-1000/x"]),
            ..policy()
        },
        &with_codex,
        Platform::Linux,
        "x64",
    );
    assert!(has(&config.filesystem.deny_read, "/tmp/ostia-codex-1000"));
    assert!(
        !config
            .filesystem
            .allow_read
            .iter()
            .any(|path| path.starts_with("/tmp/ostia-codex-1000"))
    );
}

#[test]
fn makes_a_writable_folder_the_human_added_writable_and_readable_next_to_the_fixed_ones() {
    let app = app();
    let config = build_srt_config(
        &SrtPolicy {
            allow_write: s(&["~/builds", "/srv/out"]),
            ..policy()
        },
        &guarded_paths(&app.path),
        Platform::Linux,
        "x64",
    );
    assert_eq!(
        config.filesystem.allow_write,
        [
            app.path.as_str(),
            "/tmp/sbx/w1",
            "/home/u/.claude",
            "/home/u/.codex",
            "/home/u/builds",
            "/srv/out",
        ]
    );
    assert!(has_all(
        &config.filesystem.allow_read,
        &["/home/u/builds", "/srv/out"]
    ));
}

#[test]
fn hides_the_paths_the_human_listed_and_drops_any_readable_or_writable_entry_beneath_them() {
    let app = app();
    let secrets = format!("{}/secrets", app.path);
    let config = build_srt_config(
        &SrtPolicy {
            allow_read: s(&["~/.cargo", "~/.cargo/registry", "~/notes"]),
            allow_write: s(&["~/.cargo/target"]),
            deny_read: vec!["~/.cargo".to_owned(), secrets.clone()],
            ..policy()
        },
        &guarded_paths(&app.path),
        Platform::Linux,
        "x64",
    );
    let fs = config.filesystem;
    assert!(has_all(
        &fs.deny_read,
        &["/home/u", "/home/u/.cargo", secrets.as_str()]
    ));
    assert!(has(&fs.allow_read, "/home/u/notes"));
    assert!(has(&fs.allow_read, &app.path));
    assert!(
        !fs.allow_read
            .iter()
            .any(|p| p.starts_with("/home/u/.cargo"))
    );
    assert!(
        !fs.allow_write
            .iter()
            .any(|p| p.starts_with("/home/u/.cargo"))
    );
}

#[test]
fn drops_a_readable_or_writable_entry_beneath_a_hidden_folder_when_its_name_starts_with_two_dots() {
    let app = app();
    let config = build_srt_config(
        &SrtPolicy {
            allow_read: s(&["~/.cargo/..cache"]),
            allow_write: s(&["~/.cargo/..target"]),
            deny_read: s(&["~/.cargo"]),
            ..policy()
        },
        &guarded_paths(&app.path),
        Platform::Linux,
        "x64",
    );
    assert!(!has(
        &config.filesystem.allow_read,
        "/home/u/.cargo/..cache"
    ));
    assert!(!has(
        &config.filesystem.allow_write,
        "/home/u/.cargo/..target"
    ));
}

#[test]
fn stops_handing_the_agent_folder_to_the_sandbox_once_the_human_hides_it() {
    let app = app();
    let config = build_srt_config(
        &SrtPolicy {
            deny_read: s(&["~/.claude"]),
            ..policy()
        },
        &guarded_paths(&app.path),
        Platform::Linux,
        "x64",
    );
    assert!(!has(&config.filesystem.allow_read, "/home/u/.claude"));
    assert!(!has(&config.filesystem.allow_write, "/home/u/.claude"));
    assert!(has(&config.filesystem.allow_write, "/home/u/.codex"));
}

#[test]
fn adds_read_only_paths_after_the_fixed_ones_which_the_runtime_puts_above_every_writable_path() {
    let app = app();
    let dist = format!("{}/dist", app.path);
    let config = build_srt_config(
        &SrtPolicy {
            deny_write: vec![dist.clone(), "/srv/out/keep".to_owned()],
            ..policy()
        },
        &guarded_paths(&app.path),
        Platform::Linux,
        "x64",
    );
    let hooks = format!("{}/.git/hooks", app.path);
    assert!(has_all(
        &config.filesystem.deny_write,
        &[
            "/home/u/.claude/settings.json",
            hooks.as_str(),
            dist.as_str(),
            "/srv/out/keep",
        ]
    ));
}

#[test]
fn never_opens_ostia_data_the_socket_folder_an_agent_socket_folder_a_container_socket_or_another_sandbox_tmp()
 {
    let app = app();
    let closed = s(&[
        "/home/u/.local/share/ostia",
        "/home/u/.local/share/ostia/vault.json",
        "/home/u/.local/share",
        "/home/u/.config/ostia/settings.json",
        "/run/user/1000",
        "/run/user/1000/bus",
        "/run",
        "/tmp/ssh-abc",
        "/tmp/ssh-abc/agent.1",
        "/run/docker.sock",
        "/tmp/ostia-sandbox",
        "/tmp/ostia-sandbox/other-workspace",
        "/tmp",
    ]);
    let closing = SrtPolicy {
        allow_read: closed.clone(),
        allow_write: closed.clone(),
        allow_sockets: closed.clone(),
        ..policy()
    };
    for platform in [Platform::Linux, Platform::Darwin] {
        let config = build_srt_config(&closing, &guarded_paths(&app.path), platform, "x64");
        let sockets = config
            .network
            .allow_unix_sockets
            .clone()
            .unwrap_or_default();
        for path in &closed {
            assert!(!has(&config.filesystem.allow_write, path), "{path}");
            assert!(!has(&config.filesystem.allow_read, path), "{path}");
            assert!(!has(&sockets, path), "{path}");
        }
        assert!(has_all(
            &config.filesystem.deny_read,
            &[
                "/home/u/.local/share/ostia",
                "/run/user/1000",
                "/tmp/ssh-abc",
                "/run/docker.sock",
                "/tmp/ostia-sandbox",
            ]
        ));
    }
}

#[test]
fn keeps_the_protected_agent_and_git_files_read_only_even_when_the_human_lists_them_as_writable() {
    let app = app();
    let hooks = format!("{}/.git/hooks", app.path);
    let config = build_srt_config(
        &SrtPolicy {
            allow_write: vec!["~/.claude/settings.json".to_owned(), hooks.clone()],
            ..policy()
        },
        &guarded_paths(&app.path),
        Platform::Linux,
        "x64",
    );
    assert!(has_all(
        &config.filesystem.deny_write,
        &["/home/u/.claude/settings.json", hooks.as_str()]
    ));
}

#[test]
fn drops_a_readable_or_writable_entry_whose_real_path_is_inside_ostia_data() {
    let (_dir, root) = real_temp();
    let home = format!("{root}/home");
    let data_dir = format!("{home}/.local/share/ostia");
    fs::create_dir_all(&data_dir).unwrap();
    let innocent = format!("{home}/innocent");
    symlink(&data_dir, &innocent).unwrap();
    let config = build_srt_config(
        &SrtPolicy {
            allow_read: s(&["~/innocent"]),
            allow_write: s(&["~/innocent"]),
            ..policy()
        },
        &SandboxPaths {
            base: SandboxBasePaths {
                home: home.clone(),
                data_dirs: vec![data_dir],
                ..base()
            },
            work_dir: format!("{home}/app"),
            ..paths("")
        },
        Platform::Linux,
        "x64",
    );
    assert!(!has(&config.filesystem.allow_read, &innocent));
    assert!(!has(&config.filesystem.allow_write, &innocent));
}

#[test]
fn allows_every_unix_socket_on_linux_by_default_where_the_runtime_cannot_filter_by_path() {
    let app = app();
    let config = build_srt_config(&policy(), &guarded_paths(&app.path), Platform::Linux, "x64");
    assert_eq!(config.network.allow_all_unix_sockets, Some(true));
    assert_eq!(config.network.allow_unix_sockets, None);
    assert!(!config.network.allow_local_binding);
}

#[test]
fn blocks_every_unix_socket_on_linux_when_the_human_turns_them_off() {
    let app = app();
    let config = build_srt_config(
        &SrtPolicy {
            switches: Some(OFF),
            ..policy()
        },
        &guarded_paths(&app.path),
        Platform::Linux,
        "x64",
    );
    assert_eq!(config.network.allow_all_unix_sockets, Some(false));
}

#[test]
fn ignores_the_allowed_socket_list_on_linux() {
    let app = app();
    let config = build_srt_config(
        &SrtPolicy {
            switches: Some(ON),
            allow_sockets: s(&["/var/run/tool.sock"]),
            ..policy()
        },
        &guarded_paths(&app.path),
        Platform::Linux,
        "x64",
    );
    assert_eq!(config.network.allow_unix_sockets, None);
}

#[test]
fn allows_only_ostias_socket_and_the_listed_sockets_on_macos() {
    let app = app();
    let config = build_srt_config(
        &SrtPolicy {
            switches: Some(ON),
            allow_sockets: s(&["/var/run/tool.sock", "~/run/app.sock"]),
            ..policy()
        },
        &guarded_paths(&app.path),
        Platform::Darwin,
        "arm64",
    );
    assert_eq!(config.network.allow_all_unix_sockets, None);
    assert_eq!(
        config.network.allow_unix_sockets,
        Some(s(&[
            "/run/user/1000/ostia-1.sock",
            "/tmp/sbx/w1/a.sock",
            "/var/run/tool.sock",
            "/home/u/run/app.sock",
        ]))
    );
    assert!(config.network.allow_local_binding);
}

#[test]
fn blocks_every_unix_socket_on_macos_ostias_included_when_the_human_turns_them_off() {
    let app = app();
    let config = build_srt_config(
        &SrtPolicy {
            switches: Some(OFF),
            allow_sockets: s(&["/var/run/tool.sock"]),
            ..policy()
        },
        &guarded_paths(&app.path),
        Platform::Darwin,
        "arm64",
    );
    assert_eq!(config.network.allow_unix_sockets, Some(Vec::new()));
    assert_eq!(config.network.allow_all_unix_sockets, None);
}

#[test]
fn puts_the_kept_shell_socket_among_the_readable_paths_and_the_macos_sockets() {
    let app = app();
    let kept = SandboxPaths {
        base: SandboxBasePaths {
            kept_socket_path: Some("/run/user/1000/kept.sock".to_owned()),
            ..guarded()
        },
        ..paths(&app.path)
    };
    let linux = build_srt_config(&policy(), &kept, Platform::Linux, "x64");
    assert!(has(
        &linux.filesystem.allow_read,
        "/run/user/1000/kept.sock"
    ));
    let mac = build_srt_config(
        &SrtPolicy {
            switches: Some(ON),
            ..policy()
        },
        &kept,
        Platform::Darwin,
        "arm64",
    );
    assert_eq!(
        mac.network.allow_unix_sockets,
        Some(s(&[
            "/run/user/1000/ostia-1.sock",
            "/run/user/1000/kept.sock",
            "/tmp/sbx/w1/a.sock",
        ]))
    );
}

#[test]
fn says_socket_blocking_works_only_where_the_runtime_ships_a_filter() {
    assert!(can_block_sockets(Platform::Linux, "x64"));
    assert!(can_block_sockets(Platform::Linux, "arm64"));
    assert!(!can_block_sockets(Platform::Linux, "riscv64"));
    assert!(can_block_sockets(Platform::Darwin, "arm64"));
}

#[test]
fn passes_blocked_domains_to_the_runtime_which_checks_them_before_the_allowed_ones() {
    let app = app();
    let config = build_srt_config(
        &SrtPolicy {
            domains: s(&["example.com"]),
            denied_domains: s(&["telemetry.example.com"]),
            ..policy()
        },
        &paths(&app.path),
        Platform::Linux,
        "x64",
    );
    assert_eq!(config.network.denied_domains, ["telemetry.example.com"]);
    assert_eq!(config.network.allowed_domains, ["example.com"]);
}

#[test]
fn asks_about_unlisted_domains_by_default_and_refuses_them_outright_when_the_human_says_never_ask()
{
    let app = app();
    let base_policy = SrtPolicy {
        domains: s(&["example.com"]),
        ..policy()
    };
    assert!(
        !build_srt_config(&base_policy, &paths(&app.path), Platform::Linux, "x64")
            .network
            .strict_allowlist
    );
    let strict = SandboxSwitches {
        strict_domains: true,
        ..ON
    };
    assert!(
        build_srt_config(
            &SrtPolicy {
                switches: Some(strict),
                ..base_policy
            },
            &paths(&app.path),
            Platform::Linux,
            "x64"
        )
        .network
        .strict_allowlist
    );
}

#[test]
fn keeps_git_config_read_only_until_the_human_lets_git_change_it_and_hooks_read_only_always() {
    let app = app();
    let git_config = format!("{}/.git/config", app.path);
    let hooks = format!("{}/.git/hooks", app.path);
    let closed = build_srt_config(&policy(), &paths(&app.path), Platform::Linux, "x64").filesystem;
    assert!(!closed.allow_git_config);
    assert!(has(&closed.deny_write, &git_config));
    let git = SandboxSwitches {
        git_config: true,
        ..ON
    };
    let open = build_srt_config(
        &SrtPolicy {
            switches: Some(git),
            ..policy()
        },
        &paths(&app.path),
        Platform::Linux,
        "x64",
    )
    .filesystem;
    assert!(open.allow_git_config);
    assert!(!has(&open.deny_write, &git_config));
    assert!(has(&open.deny_write, &hooks));
}

#[test]
fn lists_what_ostia_always_hides_opens_and_protects_for_a_workspace() {
    let app = app();
    let fixed = fixed_policy(
        &guarded(),
        Some(&workspace(&app.path)),
        false,
        Platform::Linux,
        "x64",
    );
    assert_eq!(
        fixed.hidden,
        [
            "/home/u".to_owned(),
            "/home/u/.local/share/ostia".to_owned(),
            "/home/u/.config/ostia".to_owned(),
            "/home/u/.cargo/credentials.toml".to_owned(),
            "/home/u/.cargo/credentials".to_owned(),
            format!("{}/.ostia/vault.json", app.path),
            "/tmp/ssh-abc".to_owned(),
            "/run/docker.sock".to_owned(),
            "/run/user/1000".to_owned(),
            "/tmp/ostia-sandbox".to_owned(),
        ]
    );
    assert_eq!(
        fixed.readable,
        [
            app.path.clone(),
            "/tmp/sbx/w1".to_owned(),
            "/run/user/1000/ostia-1.sock".to_owned(),
            "/home/u/.claude".to_owned(),
            "/home/u/.codex".to_owned(),
        ]
    );
    assert_eq!(
        fixed.writable,
        [
            app.path.clone(),
            "/tmp/sbx/w1".to_owned(),
            "/home/u/.claude".to_owned(),
            "/home/u/.codex".to_owned(),
        ]
    );
    assert!(has(&fixed.read_only, &format!("{}/.git/config", app.path)));
    assert_eq!(fixed.hidden_sockets, ["/tmp/ssh-abc", "/run/docker.sock"]);
    assert!(fixed.socket_blocking);
}

#[test]
fn matches_what_build_srt_config_hands_the_runtime_when_the_human_added_nothing() {
    let app = app();
    let fixed = fixed_policy(
        &guarded(),
        Some(&workspace(&app.path)),
        false,
        Platform::Linux,
        "x64",
    );
    let config = build_srt_config(&policy(), &guarded_paths(&app.path), Platform::Linux, "x64");
    assert_eq!(config.filesystem.deny_read, fixed.hidden);
    assert_eq!(config.filesystem.allow_read, fixed.readable);
    assert_eq!(config.filesystem.allow_write, fixed.writable);
    assert_eq!(config.filesystem.deny_write, fixed.read_only);
}

#[test]
fn keeps_cargo_readable_from_the_defaults_but_always_hides_its_credentials() {
    let app = app();
    let config = build_srt_config(
        &SrtPolicy {
            allow_read: DEFAULT_ALLOW_READ.map(String::from).to_vec(),
            ..policy()
        },
        &guarded_paths(&app.path),
        Platform::Linux,
        "x64",
    );
    assert!(has(&config.filesystem.allow_read, "/home/u/.cargo"));
    assert!(has_all(
        &config.filesystem.deny_read,
        &[
            "/home/u/.cargo/credentials.toml",
            "/home/u/.cargo/credentials"
        ]
    ));
    assert_eq!(
        HOME_HIDDEN_FILES.to_vec(),
        [".cargo/credentials.toml", ".cargo/credentials"]
    );
}

#[test]
fn names_no_workspace_guard_whose_file_is_missing_so_the_runtime_makes_no_placeholder_for_it() {
    let (_dir, empty) = real_temp();
    let fixed = fixed_policy(
        &guarded(),
        Some(&workspace(&empty)),
        false,
        Platform::Linux,
        "x64",
    );
    let config = build_srt_config(&policy(), &guarded_paths(&empty), Platform::Linux, "x64");
    for list in [
        &fixed.hidden,
        &fixed.read_only,
        &config.filesystem.deny_read,
        &config.filesystem.deny_write,
    ] {
        let inside: Vec<&String> = list
            .iter()
            .filter(|p| p.starts_with(&empty) && **p != empty)
            .collect();
        assert!(inside.is_empty(), "{inside:?}");
    }
}

#[test]
fn leaves_out_the_workspace_paths_when_no_workspace_is_named() {
    let fixed = fixed_policy(&guarded(), None, false, Platform::Linux, "x64");
    assert_eq!(
        fixed.readable,
        s(&[
            "/run/user/1000/ostia-1.sock",
            "/home/u/.claude",
            "/home/u/.codex",
        ])
    );
    assert_eq!(fixed.writable, s(&["/home/u/.claude", "/home/u/.codex"]));
    assert!(!fixed.read_only.iter().any(|p| p.contains(".git")));
}

#[test]
fn leaves_git_config_out_of_the_fixed_read_only_list_when_git_may_change_it() {
    let app = app();
    let git_config = format!("{}/.git/config", app.path);
    let hooks = format!("{}/.git/hooks", app.path);
    let fixed = fixed_policy(
        &guarded(),
        Some(&workspace(&app.path)),
        true,
        Platform::Linux,
        "x64",
    );
    assert!(!has(&fixed.read_only, &git_config));
    assert!(has(&fixed.read_only, &hooks));
}

#[test]
fn reads_the_private_plugins_folder_and_never_writes_it() {
    let app = app();
    let with_plugins = SandboxPaths {
        plugins_dir: Some("/tmp/sbx/w1-plugins".to_owned()),
        ..paths(&app.path)
    };
    let config = build_srt_config(&policy(), &with_plugins, Platform::Linux, "x64");
    assert!(has(&config.filesystem.allow_read, "/tmp/sbx/w1-plugins"));
    assert!(!has(&config.filesystem.allow_write, "/tmp/sbx/w1-plugins"));
    assert!(has(&config.filesystem.deny_write, "/tmp/sbx/w1-plugins"));
    assert!(has(
        &config.filesystem.deny_write,
        "/home/u/.claude/plugins"
    ));
}

#[test]
fn lists_the_same_plugin_folders_as_the_fixed_policy() {
    let app = app();
    let fixed = fixed_policy(
        &base(),
        Some(&FixedWorkspace {
            plugins_dir: Some("/tmp/sbx/w1-plugins".to_owned()),
            ..workspace(&app.path)
        }),
        false,
        Platform::Linux,
        "x64",
    );
    assert!(has(&fixed.readable, "/tmp/sbx/w1-plugins"));
}

#[test]
fn refuses_the_home_folder_a_folder_above_it_and_one_that_holds_ostia_data() {
    let (_dir, root) = real_temp();
    let home = format!("{root}/u");
    fs::create_dir_all(format!("{home}/.local/share/ostia")).unwrap();
    fs::create_dir_all(format!("{home}/.config/ostia/extensions")).unwrap();
    let home_paths = SandboxBasePaths {
        home: home.clone(),
        data_dirs: vec![
            format!("{home}/.local/share/ostia"),
            format!("{home}/.config/ostia"),
        ],
        ..guarded()
    };
    assert_eq!(
        folder_problem(&home, &home_paths),
        Some(SandboxFolderReason::Home)
    );
    assert_eq!(
        folder_problem(&format!("{home}/"), &home_paths),
        Some(SandboxFolderReason::Home)
    );
    assert_eq!(
        folder_problem(&root, &home_paths),
        Some(SandboxFolderReason::AboveHome)
    );
    assert_eq!(
        folder_problem("/", &home_paths),
        Some(SandboxFolderReason::AboveHome)
    );
    assert_eq!(
        folder_problem(&format!("{home}/.local"), &home_paths),
        Some(SandboxFolderReason::OstiaData)
    );
    assert_eq!(
        folder_problem(&format!("{home}/.config/ostia/extensions"), &home_paths),
        Some(SandboxFolderReason::OstiaData)
    );
}

#[test]
fn accepts_a_project_folder_inside_or_outside_home() {
    let app = app();
    assert_eq!(folder_problem(&app.path, &guarded()), None);
    assert_eq!(folder_problem("/srv/project", &guarded()), None);
}

fn hook_link_filesystem(
    app: &App,
    hook_links: &[&str],
    deny_read: &[&str],
) -> ostia_sandbox::srt_config::SrtFilesystem {
    let config = build_srt_config(
        &SrtPolicy {
            deny_read: s(deny_read),
            ..policy()
        },
        &SandboxPaths {
            base: SandboxBasePaths {
                data_dirs: s(&["/home/u/.local/share/ostia"]),
                ..base()
            },
            hook_links: s(hook_links),
            ..paths(&app.path)
        },
        Platform::Linux,
        "x64",
    );
    config.filesystem
}

#[test]
fn opens_a_hook_link_target_for_reading_and_never_for_writing() {
    let app = app();
    let fs = hook_link_filesystem(&app, &["/home/u/tools/hook.sh"], &[]);
    assert!(has(&fs.allow_read, "/home/u/tools/hook.sh"));
    assert!(has(&fs.deny_write, "/home/u/tools/hook.sh"));
    assert!(!has(&fs.allow_write, "/home/u/tools/hook.sh"));
}

#[test]
fn leaves_out_a_hook_link_target_in_ostia_data_or_one_the_human_hid() {
    let app = app();
    let fs = hook_link_filesystem(
        &app,
        &[
            "/home/u/.local/share/ostia/vault.json",
            "/home/u/tools/hook.sh",
        ],
        &["/home/u/tools"],
    );
    assert!(!has(
        &fs.allow_read,
        "/home/u/.local/share/ostia/vault.json"
    ));
    assert!(!has(&fs.allow_read, "/home/u/tools/hook.sh"));
    assert!(!has(
        &fs.deny_write,
        "/home/u/.local/share/ostia/vault.json"
    ));
}

#[test]
fn serializes_to_the_config_shape_the_sandbox_runtime_reads() {
    let app = app();
    let with_vendor = SandboxPaths {
        base: SandboxBasePaths {
            srt_vendor_dir: Some(VENDOR.to_owned()),
            ..base()
        },
        ..paths(&app.path)
    };
    let linux = serde_json::to_value(build_srt_config(
        &SrtPolicy {
            domains: s(&["example.com"]),
            ..policy()
        },
        &with_vendor,
        Platform::Linux,
        "x64",
    ))
    .unwrap();
    assert_eq!(linux["network"]["allowedDomains"], json!(["example.com"]));
    assert_eq!(linux["network"]["deniedDomains"], json!([]));
    assert_eq!(linux["network"]["strictAllowlist"], json!(false));
    assert_eq!(linux["network"]["allowAllUnixSockets"], json!(true));
    assert_eq!(linux["network"]["allowLocalBinding"], json!(false));
    assert!(linux["network"].get("allowUnixSockets").is_none());
    assert_eq!(linux["filesystem"]["allowGitConfig"], json!(false));
    assert!(linux["filesystem"]["denyRead"].is_array());
    assert!(linux["filesystem"]["allowRead"].is_array());
    assert!(linux["filesystem"]["allowWrite"].is_array());
    assert!(linux["filesystem"]["denyWrite"].is_array());
    assert_eq!(
        linux["javaAgentJarPath"],
        json!(format!("{VENDOR}/java-proxy-agent/srt-proxy-agent.jar"))
    );
    assert_eq!(
        linux["seccomp"],
        json!({"applyPath": format!("{VENDOR}/seccomp/x64/apply-seccomp")})
    );
    assert!(linux.get("allowPty").is_none());
    let mac = serde_json::to_value(build_srt_config(
        &policy(),
        &paths(&app.path),
        Platform::Darwin,
        "arm64",
    ))
    .unwrap();
    assert_eq!(mac["allowPty"], json!(true));
    assert_eq!(mac["network"]["allowLocalBinding"], json!(true));
    assert!(mac["network"].get("allowAllUnixSockets").is_none());
    assert!(mac["network"]["allowUnixSockets"].is_array());
    assert!(mac.get("seccomp").is_none());
    assert!(mac.get("javaAgentJarPath").is_none());
}
