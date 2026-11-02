#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use ostia_base::host::Platform;
use ostia_base::systemd_launch::{SystemdLaunch, SystemdLaunchInput, systemd_launch_plan};

fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
    items
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

fn base() -> SystemdLaunchInput {
    SystemdLaunchInput {
        platform: Platform::Linux,
        no_new_privs: true,
        systemd_run: Some(PathBuf::from("/usr/bin/systemd-run")),
        tail: Some(PathBuf::from("/usr/bin/tail")),
        exe: PathBuf::from("/opt/ostia/ostia"),
        args: vec!["--hidden".to_owned()],
        env: pairs(&[("PATH", "/usr/bin"), ("DISPLAY", ":0")]),
        cwd: PathBuf::from("/home/u"),
        unit: "ostia-abc".to_owned(),
        wait_for_pid: None,
    }
}

fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

fn setenv(plan: &SystemdLaunch) -> Vec<&String> {
    plan.args
        .iter()
        .filter(|arg| arg.starts_with("--setenv="))
        .collect()
}

#[test]
fn starts_the_app_through_the_user_manager_with_its_argv_and_env() {
    assert_eq!(
        systemd_launch_plan(&base()),
        Some(SystemdLaunch {
            file: PathBuf::from("/usr/bin/systemd-run"),
            args: strings(&[
                "--user",
                "--quiet",
                "--collect",
                "--no-block",
                "--unit=ostia-abc",
                "--working-directory=/home/u",
                "--property=KillMode=process",
                "--setenv=PATH=/usr/bin",
                "--setenv=DISPLAY=:0",
                "--",
                "/opt/ostia/ostia",
                "--hidden",
            ]),
        })
    );
}

#[test]
fn keeps_app_relaunch_when_the_flag_is_already_clear() {
    let input = SystemdLaunchInput {
        no_new_privs: false,
        ..base()
    };
    assert_eq!(systemd_launch_plan(&input), None);
}

#[test]
fn keeps_app_relaunch_when_systemd_run_is_missing() {
    let input = SystemdLaunchInput {
        systemd_run: None,
        ..base()
    };
    assert_eq!(systemd_launch_plan(&input), None);
}

#[test]
fn does_nothing_off_linux() {
    let input = SystemdLaunchInput {
        platform: Platform::Darwin,
        ..base()
    };
    assert_eq!(systemd_launch_plan(&input), None);
}

#[test]
fn waits_for_the_old_process_to_exit_before_starting() {
    let input = SystemdLaunchInput {
        wait_for_pid: Some(42),
        ..base()
    };
    let plan = systemd_launch_plan(&input).unwrap();
    assert!(
        plan.args
            .contains(&"--property=ExecStartPre=/usr/bin/tail --pid=42 -f /dev/null".to_owned())
    );
}

#[test]
fn puts_the_wait_before_the_environment_and_after_the_kill_mode() {
    let input = SystemdLaunchInput {
        wait_for_pid: Some(42),
        ..base()
    };
    let args = systemd_launch_plan(&input).unwrap().args;
    let position = |needle: &str| args.iter().position(|arg| arg.starts_with(needle)).unwrap();
    assert!(position("--property=KillMode") < position("--property=ExecStartPre"));
    assert!(position("--property=ExecStartPre") < position("--setenv=PATH"));
}

#[test]
fn keeps_app_relaunch_when_it_must_wait_and_tail_is_missing() {
    let input = SystemdLaunchInput {
        wait_for_pid: Some(42),
        tail: None,
        ..base()
    };
    assert_eq!(systemd_launch_plan(&input), None);
}

#[test]
fn passes_the_discrete_gpu_env_and_drops_service_variables_and_bad_names() {
    let input = SystemdLaunchInput {
        env: pairs(&[
            ("DRI_PRIME", "pci-0000_01_00_0"),
            ("OSTIA_GPU_RESTORE", "{}"),
            ("INVOCATION_ID", "x"),
            ("JOURNAL_STREAM", "x"),
            ("NOTIFY_SOCKET", "/run/notify"),
            ("MAINPID", "1"),
            ("MANAGERPID", "1"),
            ("SYSTEMD_EXEC_PID", "1"),
            ("BAD NAME", "1"),
            ("1BAD", "1"),
            ("", "1"),
        ]),
        ..base()
    };
    let plan = systemd_launch_plan(&input).unwrap();
    assert_eq!(
        setenv(&plan),
        vec![
            "--setenv=DRI_PRIME=pci-0000_01_00_0",
            "--setenv=OSTIA_GPU_RESTORE={}"
        ]
    );
}

#[test]
fn puts_an_argument_that_looks_like_an_option_after_the_separator() {
    let input = SystemdLaunchInput {
        args: vec!["--user-data-dir=/tmp/x".to_owned()],
        ..base()
    };
    let plan = systemd_launch_plan(&input).unwrap();
    let separator = plan.args.iter().position(|arg| arg == "--").unwrap();
    assert_eq!(
        plan.args[separator..],
        strings(&["--", "/opt/ostia/ostia", "--user-data-dir=/tmp/x"])
    );
}

#[test]
fn keeps_the_order_of_the_environment_and_a_value_with_an_equals_sign() {
    let input = SystemdLaunchInput {
        env: pairs(&[("Z", "1"), ("A", "x=y"), ("M", "")]),
        ..base()
    };
    let plan = systemd_launch_plan(&input).unwrap();
    assert_eq!(
        setenv(&plan),
        vec!["--setenv=Z=1", "--setenv=A=x=y", "--setenv=M="]
    );
}
