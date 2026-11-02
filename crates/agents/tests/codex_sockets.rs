#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use ostia_agents::codex_sockets::{CodexSockets, codex_socket_dir, codex_socket_path};
use ostia_testkit::temp_host;

const SIGTERM: i32 = 15;

fn sleeper() -> Child {
    Command::new("sleep")
        .arg("30")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn exit_signal(child: &mut Child) -> Option<i32> {
    for _ in 0..500 {
        if let Some(status) = child.try_wait().unwrap() {
            return status.signal();
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = child.kill();
    panic!("the server was not stopped");
}

fn files(dir: &Path, pid_text: &str) -> std::path::PathBuf {
    let sock = dir.join("p.sock");
    fs::write(&sock, "").unwrap();
    fs::write(format!("{}.pid", sock.display()), pid_text).unwrap();
    sock
}

#[test]
fn lives_in_its_own_0700_directory_apart_from_the_shell_state_directory() {
    let (_dir, host) = temp_host().unwrap();
    let path = codex_socket_path(&host).unwrap();
    let parent = path.parent().unwrap();
    assert!(!parent.to_string_lossy().contains("shell-state"));
    assert_eq!(
        fs::metadata(parent).unwrap().permissions().mode() & 0o077,
        0
    );
}

#[test]
fn kills_the_server_and_removes_its_files_when_the_pane_closes() {
    let (dir, _host) = temp_host().unwrap();
    let mut child = sleeper();
    let sock = files(dir.path(), &child.id().to_string());
    let sockets = CodexSockets::new();
    sockets.register("pane-x", sock.clone());
    sockets.forget("pane-x");
    assert_eq!(exit_signal(&mut child), Some(SIGTERM));
    assert!(!sock.exists());
    assert!(!Path::new(&format!("{}.pid", sock.display())).exists());
}

#[test]
fn gives_every_socket_path_its_own_sock_name_in_the_socket_directory() {
    let (_dir, host) = temp_host().unwrap();
    let first = codex_socket_path(&host).unwrap();
    let second = codex_socket_path(&host).unwrap();
    assert_ne!(first, second);
    for path in [&first, &second] {
        assert_eq!(path.extension().and_then(|ext| ext.to_str()), Some("sock"));
    }
    assert_eq!(
        first.parent().unwrap(),
        codex_socket_dir(&host).unwrap().as_path()
    );
}

#[test]
fn remembers_the_socket_of_an_external_id_until_it_is_forgotten() {
    let (dir, _host) = temp_host().unwrap();
    let sockets = CodexSockets::new();
    let path = dir.path().join("never-created.sock");
    assert_eq!(sockets.socket_of("pane-y"), None);
    sockets.register("pane-y", path.clone());
    assert_eq!(sockets.socket_of("pane-y"), Some(path));
    sockets.forget("pane-y");
    assert_eq!(sockets.socket_of("pane-y"), None);
    sockets.forget("pane-y");
}

#[test]
fn reads_a_pid_that_has_a_trailing_newline_as_a_number_does() {
    let (dir, _host) = temp_host().unwrap();
    let mut child = sleeper();
    let sock = files(dir.path(), &format!("{}\n", child.id()));
    let sockets = CodexSockets::new();
    sockets.register("pane-n", sock.clone());
    sockets.forget("pane-n");
    assert_eq!(exit_signal(&mut child), Some(SIGTERM));
    assert!(!sock.exists());
}

#[test]
fn removes_the_files_and_does_not_fail_when_the_pid_file_is_missing_or_holds_no_pid() {
    let (dir, _host) = temp_host().unwrap();
    let sockets = CodexSockets::new();
    for pid_text in [None, Some("abc"), Some("1.5"), Some("")] {
        let sock = dir.path().join("q.sock");
        fs::write(&sock, "").unwrap();
        let pid_file = format!("{}.pid", sock.display());
        if let Some(text) = pid_text {
            fs::write(&pid_file, text).unwrap();
        }
        sockets.register("pane-z", sock.clone());
        sockets.forget("pane-z");
        assert!(!sock.exists(), "pid file {pid_text:?}");
        assert!(!Path::new(&pid_file).exists(), "pid file {pid_text:?}");
    }
}
