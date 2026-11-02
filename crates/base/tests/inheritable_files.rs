#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs::File;
use std::os::fd::AsRawFd;
use std::process::{Command, Stdio};

use ostia_base::host::Platform;
use ostia_base::inheritable_files::{inheritable_fds, without_inherited_files};
use rustix::io::{FdFlags, fcntl_setfd};
use tempfile::tempdir;

fn held_inheritable(dir: &std::path::Path) -> (File, std::path::PathBuf) {
    let path = dir.join("held");
    let file = File::create(&path).unwrap();
    fcntl_setfd(&file, FdFlags::empty()).unwrap();
    (file, path)
}

#[test]
#[cfg(target_os = "linux")]
fn grf_c226_a_descriptor_main_left_inheritable_is_found_and_the_child_gets_dev_null_in_its_place() {
    let dir = tempdir().unwrap();
    let (held, path) = held_inheritable(dir.path());
    let fd = held.as_raw_fd();
    let fds = inheritable_fds(Platform::Linux);
    assert!(fds.contains(&fd));
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", "ls -l /proc/self/fd"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let release = without_inherited_files(&mut command, &fds).unwrap();
    let output = command.output().unwrap();
    drop(release);
    let seen = String::from_utf8_lossy(&output.stdout).into_owned();
    assert!(!seen.contains(path.to_str().unwrap()), "{seen}");
    assert!(seen.contains(&format!("{fd} -> /dev/null")), "{seen}");
}

#[test]
#[cfg(target_os = "linux")]
fn lists_the_inheritable_descriptors_from_3_upward_in_order_and_skips_close_on_exec_ones() {
    let dir = tempdir().unwrap();
    let (held, _) = held_inheritable(dir.path());
    let closed_on_exec = File::create(dir.path().join("sealed")).unwrap();
    let fds = inheritable_fds(Platform::Linux);
    assert!(fds.contains(&held.as_raw_fd()));
    assert!(!fds.contains(&closed_on_exec.as_raw_fd()));
    assert!(fds.iter().all(|fd| *fd >= 3));
    assert!(fds.windows(2).all(|pair| pair[0] < pair[1]));
}

#[test]
fn finds_nothing_and_changes_nothing_off_linux() {
    assert_eq!(inheritable_fds(Platform::Darwin), Vec::<i32>::new());
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", "ls /proc/self/fd"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let release = without_inherited_files(&mut command, &[]).unwrap();
    assert!(command.output().unwrap().status.success());
    drop(release);
}
