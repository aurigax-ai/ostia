#![allow(dead_code)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use ostia_base::Host;
use ostia_testscript::ScriptsGuard;
use tempfile::TempDir;

pub fn host() -> Host {
    Host::current()
}

pub fn write(path: impl AsRef<Path>, text: &str) {
    fs::write(path, text).unwrap();
}

pub fn link(target: impl AsRef<Path>, at: impl AsRef<Path>) {
    symlink(target, at).unwrap();
}

pub fn run_git(cwd: &Path, extra: &[&str], args: &[&str]) -> String {
    let output = Command::new("git")
        .args([
            "-c",
            "user.email=a@b.c",
            "-c",
            "user.name=t",
            "-c",
            "protocol.file.allow=always",
        ])
        .args(extra)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

pub fn git(cwd: &Path, args: &[&str]) -> String {
    run_git(cwd, &[], args)
}

pub fn git_inert(cwd: &Path, args: &[&str]) -> String {
    run_git(cwd, &["-c", "core.fsmonitor=false"], args)
}

pub struct Sandbox {
    pub dir: TempDir,
    pub root: PathBuf,
    pub marks: PathBuf,
    _scripts: Option<ScriptsGuard>,
}

impl Sandbox {
    pub fn new(prefix: &str) -> Self {
        Self::build(prefix, None)
    }

    pub fn scripted(prefix: &str) -> Self {
        Self::build(prefix, Some(ostia_testscript::lock()))
    }

    fn build(prefix: &str, scripts: Option<ScriptsGuard>) -> Self {
        let dir = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let marks = root.join("marks");
        fs::create_dir(&marks).unwrap();
        Self {
            dir,
            root,
            marks,
            _scripts: scripts,
        }
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    pub fn dir(&self, name: &str) -> PathBuf {
        let path = self.path(name);
        fs::create_dir_all(&path).unwrap();
        path
    }

    pub fn program(&self, name: &str) -> String {
        let path = self.path(name);
        let mark = self.marks.join(name);
        ostia_testscript::write_script(
            &path,
            &format!("#!/bin/sh\ntouch \"{}\"\nexit 1\n", mark.display()),
            0o755,
        )
        .unwrap();
        path.to_string_lossy().into_owned()
    }

    pub fn marked(&self, name: &str) -> bool {
        self.marks.join(name).exists()
    }

    pub fn clear_mark(&self, name: &str) {
        let _ = fs::remove_file(self.marks.join(name));
    }
}

pub fn init_repo(path: &Path) {
    fs::create_dir_all(path).unwrap();
    git(path, &["init", "-q", "-b", "main"]);
}

pub fn commit_all(path: &Path, message: &str) {
    git(path, &["add", "."]);
    git(path, &["commit", "-q", "-m", message]);
}
