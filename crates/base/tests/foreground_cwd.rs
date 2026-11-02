#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::cell::RefCell;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;

use ostia_base::foreground_cwd::{darwin_foreground_cwd, linux_foreground_cwd};
use tempfile::{TempDir, tempdir};

fn fake_proc(shell_stat: &str, cwds: &[(u32, &str)]) -> TempDir {
    let root = tempdir().unwrap();
    fs::create_dir(root.path().join("100")).unwrap();
    fs::write(root.path().join("100").join("stat"), shell_stat).unwrap();
    for (pid, cwd) in cwds {
        let folder = root.path().join(pid.to_string());
        fs::create_dir_all(&folder).unwrap();
        symlink(cwd, folder.join("cwd")).unwrap();
    }
    root
}

fn shell_stat(tpgid: i32) -> String {
    format!("100 (bash) S 1 100 100 34816 {tpgid} 4194304 0 0 0 0 0 0 0 0 20 0 1 0")
}

#[test]
fn reads_the_folder_of_the_panes_foreground_process_group_not_the_shells() {
    let root = fake_proc(
        &shell_stat(200),
        &[(100, "/home/u"), (200, "/home/u/work/tree")],
    );
    assert_eq!(
        linux_foreground_cwd(100, root.path()),
        Some(PathBuf::from("/home/u/work/tree"))
    );
}

#[test]
fn answers_a_removed_folder_by_its_path_so_resuming_shows_it_missing_instead_of_moving_elsewhere() {
    let root = fake_proc(&shell_stat(200), &[(200, "/home/u/tree (deleted)")]);
    assert_eq!(
        linux_foreground_cwd(100, root.path()),
        Some(PathBuf::from("/home/u/tree"))
    );
}

#[test]
fn answers_nothing_when_the_group_is_gone_or_the_shell_is_unknown() {
    assert_eq!(
        linux_foreground_cwd(100, fake_proc(&shell_stat(300), &[]).path()),
        None
    );
    assert_eq!(
        linux_foreground_cwd(100, fake_proc(&shell_stat(-1), &[]).path()),
        None
    );
    assert_eq!(
        linux_foreground_cwd(999, fake_proc(&shell_stat(200), &[]).path()),
        None
    );
}

#[test]
fn answers_nothing_for_a_link_that_is_not_an_absolute_path() {
    let root = fake_proc(&shell_stat(200), &[(200, "relative/tree")]);
    assert_eq!(linux_foreground_cwd(100, root.path()), None);
}

#[test]
fn answers_nothing_when_the_foreground_group_is_zero() {
    let root = fake_proc(&shell_stat(0), &[(0, "/home/u")]);
    assert_eq!(linux_foreground_cwd(100, root.path()), None);
}

struct Tools {
    answers: Vec<(&'static str, &'static str)>,
    calls: RefCell<Vec<Vec<String>>>,
}

impl Tools {
    fn new(answers: &[(&'static str, &'static str)]) -> Self {
        Self {
            answers: answers.to_vec(),
            calls: RefCell::new(Vec::new()),
        }
    }

    fn run(&self, bin: &str, args: &[String]) -> String {
        let mut call = vec![bin.to_owned()];
        call.extend(args.iter().cloned());
        self.calls.borrow_mut().push(call);
        self.answers
            .iter()
            .find(|(name, _)| *name == bin)
            .map_or_else(String::new, |(_, out)| (*out).to_owned())
    }
}

fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

#[test]
fn asks_ps_for_the_foreground_group_and_lsof_for_that_processs_folder() {
    let tools = Tools::new(&[
        ("/bin/ps", "  200\n"),
        ("/usr/sbin/lsof", "p200\nfcwd\nn/Users/u/work/tree\n"),
    ]);
    assert_eq!(
        darwin_foreground_cwd(100, |bin, args| tools.run(bin, args)),
        Some(PathBuf::from("/Users/u/work/tree"))
    );
    assert_eq!(
        *tools.calls.borrow(),
        vec![
            strings(&["/bin/ps", "-o", "tpgid=", "-p", "100"]),
            strings(&["/usr/sbin/lsof", "-a", "-p", "200", "-d", "cwd", "-Fn"]),
        ]
    );
}

#[test]
fn answers_nothing_without_a_foreground_group_or_a_folder() {
    let none = |answers: &[(&'static str, &'static str)]| {
        let tools = Tools::new(answers);
        darwin_foreground_cwd(100, |bin, args| tools.run(bin, args))
    };
    assert_eq!(none(&[("/bin/ps", "")]), None);
    assert_eq!(none(&[("/bin/ps", "0")]), None);
    assert_eq!(
        none(&[("/bin/ps", "200"), ("/usr/sbin/lsof", "p200\n")]),
        None
    );
}

#[test]
fn strips_the_deleted_suffix_from_the_folder_lsof_prints() {
    let tools = Tools::new(&[
        ("/bin/ps", "200"),
        ("/usr/sbin/lsof", "p200\nn/Users/u/tree (deleted)\n"),
    ]);
    assert_eq!(
        darwin_foreground_cwd(100, |bin, args| tools.run(bin, args)),
        Some(PathBuf::from("/Users/u/tree"))
    );
}
