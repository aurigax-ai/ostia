#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use ostia_base::host::{Host, Platform};
use ostia_base::system_requirements::{
    KEEP_SHELLS_FEATURE, MANAGER_FEATURE, MissingRequirement, Requirement, RequirementEnv,
    Requirements, SANDBOX_FEATURE,
};
use ostia_base::tool_path::{LoginPathOptions, ShellRunner, ToolPath};
use tempfile::{TempDir, tempdir};

struct Rig {
    root: TempDir,
    requirements: Requirements,
    tool_path: ToolPath,
    counter: usize,
}

fn rig_with_path(path: &str) -> Rig {
    let host = Host {
        env: BTreeMap::from([("PATH".to_owned(), path.to_owned())]),
        home: "/home/me".into(),
        cwd: "/".into(),
        platform: Platform::Linux,
    };
    let tool_path = ToolPath::new(&host);
    Rig {
        root: tempdir().unwrap(),
        requirements: Requirements::new(tool_path.clone()),
        tool_path,
        counter: 0,
    }
}

fn rig() -> Rig {
    rig_with_path("")
}

impl Rig {
    fn bin_dir(&self, name: &str, programs: &[&str]) -> PathBuf {
        let dir = self.root.path().join(name);
        fs::create_dir_all(&dir).unwrap();
        for program in programs {
            let file = dir.join(program);
            fs::write(&file, "#!/bin/sh\n").unwrap();
            fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
        }
        dir
    }

    fn versioned_tmux(&mut self, version: &str) -> PathBuf {
        self.counter += 1;
        let dir = self.root.path().join(format!("tmux-{}", self.counter));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("tmux");
        fs::write(&file, format!("#!/bin/sh\necho '{version}'\n")).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
        dir
    }
}

fn env(platform: Platform, path: &Path) -> RequirementEnv {
    RequirementEnv {
        platform: Some(platform),
        path: Some(path.display().to_string()),
        pty_relay: None,
    }
}

fn direct(platform: Platform, path: &Path) -> RequirementEnv {
    RequirementEnv {
        pty_relay: Some(false),
        ..env(platform, path)
    }
}

fn missing(program: &str, package: &str) -> MissingRequirement {
    MissingRequirement {
        program: program.to_owned(),
        package: package.to_owned(),
        needs: None,
        found: None,
    }
}

fn old_tmux(found: Option<&str>) -> MissingRequirement {
    MissingRequirement {
        needs: Some("3.2".to_owned()),
        found: found.map(str::to_owned),
        ..missing("tmux", "tmux")
    }
}

#[test]
fn names_the_sandbox_packages_missing_on_linux_and_nothing_when_all_are_there() {
    let rig = rig();
    let some = rig.bin_dir("some", &["socat"]);
    assert_eq!(
        rig.requirements
            .missing_requirements(SANDBOX_FEATURE, &direct(Platform::Linux, &some)),
        vec![missing("bwrap", "bubblewrap"), missing("rg", "ripgrep")]
    );
    let all = rig.bin_dir("all", &["socat", "bwrap", "rg"]);
    assert_eq!(
        rig.requirements
            .missing_requirements(SANDBOX_FEATURE, &direct(Platform::Linux, &all)),
        Vec::new()
    );
    assert_eq!(
        rig.requirements.missing_requirements(
            SANDBOX_FEATURE,
            &RequirementEnv {
                platform: Some(Platform::Darwin),
                path: Some(some.display().to_string()),
                pty_relay: None,
            }
        ),
        vec![missing("rg", "ripgrep")]
    );
}

#[test]
fn needs_script_from_util_linux_only_where_the_sandboxed_shell_runs_behind_the_pty_relay() {
    let rig = rig();
    let all = rig.bin_dir("no-script", &["socat", "bwrap", "rg"]);
    let with = |relay: bool| RequirementEnv {
        pty_relay: Some(relay),
        ..env(Platform::Linux, &all)
    };
    assert_eq!(
        rig.requirements
            .missing_requirements(SANDBOX_FEATURE, &with(false)),
        Vec::new()
    );
    assert_eq!(
        rig.requirements
            .missing_requirements(SANDBOX_FEATURE, &with(true)),
        vec![missing("script", "util-linux")]
    );
}

#[test]
fn mgr_c39_the_manager_needs_ss_from_iproute2_on_linux_only() {
    let rig = rig();
    let none = rig.bin_dir("none", &[]);
    assert_eq!(
        rig.requirements
            .missing_requirements(MANAGER_FEATURE, &env(Platform::Linux, &none)),
        vec![missing("ss", "iproute2")]
    );
    let with_ss = rig.bin_dir("with-ss", &["ss"]);
    assert_eq!(
        rig.requirements
            .missing_requirements(MANAGER_FEATURE, &env(Platform::Linux, &with_ss)),
        Vec::new()
    );
    assert_eq!(
        rig.requirements
            .missing_requirements(MANAGER_FEATURE, &env(Platform::Darwin, &none)),
        Vec::new()
    );
}

fn tool(program: &str, package: &str) -> Requirement {
    Requirement {
        program: program.to_owned(),
        package: package.to_owned(),
        platforms: vec![Platform::Linux],
        only_with_pty_relay: false,
        min_version: None,
    }
}

#[test]
fn treats_an_unknown_feature_and_a_non_executable_file_as_missing_nothing_and_missing() {
    let rig = rig();
    assert_eq!(
        rig.requirements.missing_requirements(
            "no-such-feature",
            &RequirementEnv {
                platform: Some(Platform::Linux),
                path: Some(String::new()),
                pty_relay: None,
            }
        ),
        Vec::new()
    );
    let dir = rig.root.path().join("noexec");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("tool"), "").unwrap();
    rig.requirements
        .register_requirements("noexec-feature", vec![tool("tool", "tool-pkg")], None);
    assert_eq!(
        rig.requirements
            .missing_requirements("noexec-feature", &env(Platform::Linux, &dir)),
        vec![missing("tool", "tool-pkg")]
    );
}

#[test]
fn treats_a_folder_named_like_the_program_as_missing() {
    let rig = rig();
    let dir = rig.root.path().join("folder-bin");
    fs::create_dir_all(dir.join("tool")).unwrap();
    rig.requirements
        .register_requirements("folder-feature", vec![tool("tool", "tool-pkg")], None);
    assert_eq!(
        rig.requirements
            .missing_requirements("folder-feature", &env(Platform::Linux, &dir)),
        vec![missing("tool", "tool-pkg")]
    );
}

#[test]
fn finds_a_programs_absolute_path_on_path_names_a_feature_for_the_human_and_forgets_one() {
    let rig = rig();
    let dir = rig.bin_dir("lsp-bin", &["gopls"]);
    assert_eq!(
        rig.requirements
            .program_path("gopls", Some(&format!("/nonexistent:{}", dir.display()))),
        Some(dir.join("gopls"))
    );
    assert_eq!(
        rig.requirements.program_path("gopls", Some("/nonexistent")),
        None
    );
    rig.requirements.register_requirements(
        "lsp:lsp-gopls/gopls",
        vec![tool("gopls", "gopls")],
        Some("gopls"),
    );
    assert_eq!(
        rig.requirements.requirement_label("lsp:lsp-gopls/gopls"),
        "gopls"
    );
    assert_eq!(rig.requirements.requirement_label("sandbox"), "sandbox");
    let nowhere = RequirementEnv {
        platform: Some(Platform::Linux),
        path: Some("/nonexistent".to_owned()),
        pty_relay: None,
    };
    assert_eq!(
        rig.requirements
            .missing_requirements("lsp:lsp-gopls/gopls", &nowhere),
        vec![missing("gopls", "gopls")]
    );
    rig.requirements
        .register_requirements("lsp:lsp-gopls/gopls", Vec::new(), None);
    assert_eq!(
        rig.requirements
            .missing_requirements("lsp:lsp-gopls/gopls", &nowhere),
        Vec::new()
    );
    assert_eq!(
        rig.requirements.requirement_label("lsp:lsp-gopls/gopls"),
        "lsp:lsp-gopls/gopls"
    );
}

#[test]
fn forgets_the_label_when_a_feature_is_registered_again_without_one() {
    let rig = rig();
    rig.requirements
        .register_requirements("f", vec![tool("a", "a")], Some("Nice"));
    assert_eq!(rig.requirements.requirement_label("f"), "Nice");
    rig.requirements
        .register_requirements("f", vec![tool("a", "a")], None);
    assert_eq!(rig.requirements.requirement_label("f"), "f");
}

#[test]
fn needs_git_for_the_marketplace_on_linux_and_macos() {
    let rig = rig();
    let nowhere = rig.bin_dir("empty", &[]);
    for platform in [Platform::Linux, Platform::Darwin] {
        assert_eq!(
            rig.requirements
                .missing_requirements("marketplace", &env(platform, &nowhere)),
            vec![missing("git", "git")]
        );
    }
}

#[test]
fn sbx_c98_builds_a_copyable_install_command_for_the_package_manager_on_path() {
    let rig = rig();
    let needs = vec![missing("bwrap", "bubblewrap"), missing("socat", "socat")];
    let pacman = rig.bin_dir("pacman-bin", &["pacman", "sudo"]);
    let hint = rig
        .requirements
        .install_hint(&needs, &env(Platform::Linux, &pacman));
    assert_eq!(
        hint.command.as_deref(),
        Some("sudo pacman -S --needed bubblewrap socat")
    );
    assert_eq!(
        hint.packages,
        vec!["bubblewrap".to_owned(), "socat".to_owned()]
    );
    let apt = rig.bin_dir("apt-bin", &["apt-get"]);
    assert_eq!(
        rig.requirements
            .install_hint(&needs, &env(Platform::Linux, &apt))
            .command
            .as_deref(),
        Some("sudo apt-get install bubblewrap socat")
    );
    let hint = rig.requirements.install_hint(
        &needs,
        &RequirementEnv {
            platform: Some(Platform::Linux),
            path: Some(String::new()),
            pty_relay: None,
        },
    );
    assert_eq!(hint.command, None);
    assert_eq!(
        hint.packages,
        vec!["bubblewrap".to_owned(), "socat".to_owned()]
    );
}

#[test]
fn picks_the_first_package_manager_in_the_list_and_names_each_package_once() {
    let rig = rig();
    let both = rig.bin_dir(
        "both",
        &["apt-get", "pacman", "brew", "dnf", "zypper", "apk"],
    );
    let needs = vec![
        missing("a", "pkg"),
        missing("b", "pkg"),
        missing("c", "other"),
    ];
    let hint = rig
        .requirements
        .install_hint(&needs, &env(Platform::Linux, &both));
    assert_eq!(
        hint.command.as_deref(),
        Some("sudo pacman -S --needed pkg other")
    );
    assert_eq!(hint.packages, vec!["pkg".to_owned(), "other".to_owned()]);
    for (manager, command) in [
        ("apt-get", "sudo apt-get install pkg other"),
        ("dnf", "sudo dnf install pkg other"),
        ("zypper", "sudo zypper install pkg other"),
        ("apk", "sudo apk add pkg other"),
        ("brew", "brew install pkg other"),
    ] {
        let dir = rig.bin_dir(&format!("only-{manager}"), &[manager]);
        assert_eq!(
            rig.requirements
                .install_hint(&needs, &env(Platform::Linux, &dir))
                .command
                .as_deref(),
            Some(command),
            "{manager}"
        );
    }
}

#[test]
fn ksh_c17_needs_nothing_for_keeping_shells_when_tmux_3_2_or_newer_is_on_path() {
    let mut rig = rig();
    for version in ["tmux 3.2", "tmux 3.4a", "tmux next-3.6", "tmux 4.0"] {
        let dir = rig.versioned_tmux(version);
        assert_eq!(
            rig.requirements
                .missing_requirements(KEEP_SHELLS_FEATURE, &env(Platform::Linux, &dir)),
            Vec::new(),
            "{version}"
        );
        assert_eq!(
            rig.requirements
                .missing_requirements(KEEP_SHELLS_FEATURE, &env(Platform::Darwin, &dir)),
            Vec::new(),
            "{version}"
        );
    }
}

#[test]
fn ksh_c18_names_tmux_as_missing_for_keeping_shells_when_it_is_not_on_path() {
    let rig = rig();
    let none = rig.bin_dir("none", &[]);
    assert_eq!(
        rig.requirements
            .missing_requirements(KEEP_SHELLS_FEATURE, &env(Platform::Linux, &none)),
        vec![missing("tmux", "tmux")]
    );
}

#[test]
fn ksh_c19_names_the_version_needed_and_the_one_found_when_tmux_is_older_than_3_2() {
    let mut rig = rig();
    for (version, found) in [("tmux 3.1c", "3.1c"), ("tmux 2.9", "2.9")] {
        let dir = rig.versioned_tmux(version);
        assert_eq!(
            rig.requirements
                .missing_requirements(KEEP_SHELLS_FEATURE, &env(Platform::Linux, &dir)),
            vec![old_tmux(Some(found))],
            "{version}"
        );
    }
}

#[tokio::test]
async fn ksh_c89_finds_tmux_for_keeping_shells_with_a_launchd_path_when_only_the_login_shell_has_it_on_path()
 {
    let mut scratch = rig();
    let dir = scratch.versioned_tmux("tmux 3.5a");
    let launchd = scratch.bin_dir("launchd", &["ls"]);
    let rig = rig_with_path(&launchd.display().to_string());
    assert_ne!(
        rig.requirements.program_path("tmux", None),
        Some(dir.join("tmux"))
    );
    let output = format!(
        "motd\n__OSTIA_LOGIN_PATH__{}:/usr/bin:/bin\n__OSTIA_LOGIN_PATH__",
        dir.display()
    );
    let run: ShellRunner = Arc::new(move |_, _, _| {
        let output = output.clone();
        Box::pin(async move { Ok(output) })
    });
    rig.tool_path
        .resolve_login_path(LoginPathOptions {
            shell: Some("/bin/zsh".to_owned()),
            platform: Some(Platform::Darwin),
            timeout: None,
            run: Some(run),
        })
        .await;
    assert_eq!(
        rig.requirements.program_path("tmux", None),
        Some(dir.join("tmux"))
    );
    assert_eq!(
        rig.requirements.missing_requirements(
            KEEP_SHELLS_FEATURE,
            &RequirementEnv {
                platform: Some(Platform::Darwin),
                path: None,
                pty_relay: None,
            }
        ),
        Vec::new()
    );
}

#[test]
fn ksh_c80_asks_tmux_for_its_version_once_per_program_file_again_only_after_the_file_changes() {
    let rig = rig();
    let dir = rig.root.path().join("tmux-count");
    fs::create_dir_all(&dir).unwrap();
    let runs = dir.join("runs");
    let tmux = dir.join("tmux");
    fs::write(
        &tmux,
        format!(
            "#!/bin/sh\necho run >> '{}'\necho 'tmux 3.4'\n",
            runs.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&tmux, fs::Permissions::from_mode(0o755)).unwrap();
    let check = || {
        rig.requirements
            .missing_requirements(KEEP_SHELLS_FEATURE, &env(Platform::Linux, &dir))
    };
    assert_eq!(check(), Vec::new());
    assert_eq!(check(), Vec::new());
    assert_eq!(fs::read_to_string(&runs).unwrap(), "run\n");
    fs::File::options()
        .write(true)
        .open(&tmux)
        .unwrap()
        .set_modified(SystemTime::now() + Duration::from_secs(60))
        .unwrap();
    assert_eq!(check(), Vec::new());
    assert_eq!(fs::read_to_string(&runs).unwrap(), "run\nrun\n");
}

#[test]
fn ksh_c19_names_only_the_version_needed_when_tmux_will_not_say_which_it_is() {
    let mut rig = rig();
    let dir = rig.versioned_tmux("not a version");
    assert_eq!(
        rig.requirements
            .missing_requirements(KEEP_SHELLS_FEATURE, &env(Platform::Linux, &dir)),
        vec![old_tmux(None)]
    );
}

#[test]
fn reads_the_version_of_a_tmux_that_prints_nothing_as_too_old() {
    let rig = rig();
    let dir = rig.root.path().join("silent");
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join("tmux");
    fs::write(&file, "#!/bin/sh\nexit 1\n").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        rig.requirements
            .missing_requirements(KEEP_SHELLS_FEATURE, &env(Platform::Linux, &dir)),
        vec![old_tmux(None)]
    );
}

#[test]
fn compares_the_minor_version_as_a_number_so_3_10_is_newer_than_3_2() {
    let mut rig = rig();
    let dir = rig.versioned_tmux("tmux 3.10");
    assert_eq!(
        rig.requirements
            .missing_requirements(KEEP_SHELLS_FEATURE, &env(Platform::Linux, &dir)),
        Vec::new()
    );
}

#[test]
fn serializes_a_missing_requirement_without_the_fields_it_does_not_have() {
    assert_eq!(
        serde_json::to_string(&missing("rg", "ripgrep")).unwrap(),
        r#"{"program":"rg","package":"ripgrep"}"#
    );
    assert_eq!(
        serde_json::to_string(&old_tmux(Some("3.1c"))).unwrap(),
        r#"{"program":"tmux","package":"tmux","needs":"3.2","found":"3.1c"}"#
    );
}
