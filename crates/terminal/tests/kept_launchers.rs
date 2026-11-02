#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use ostia_terminal::kept_launchers::{KeptPlumbing, KeptPlumbingOptions, kept_launcher_paths};
use tempfile::TempDir;

struct Fixture {
    root: TempDir,
    launcher_dir: PathBuf,
    listened: Arc<AtomicUsize>,
    warned: Arc<Mutex<Vec<Option<String>>>>,
}

fn fixture() -> Fixture {
    let root = TempDir::new().unwrap();
    let launcher_dir = root.path().join("userData").join("bin");
    Fixture {
        root,
        launcher_dir,
        listened: Arc::new(AtomicUsize::new(0)),
        warned: Arc::new(Mutex::new(Vec::new())),
    }
}

impl Fixture {
    fn plumbing(&self, exec_path: &str, app_path: &Path) -> KeptPlumbing {
        let listened = Arc::clone(&self.listened);
        let warned = Arc::clone(&self.warned);
        KeptPlumbing::new(KeptPlumbingOptions {
            launcher_dir: self.launcher_dir.clone(),
            exec_path: exec_path.to_owned(),
            app_path: app_path.to_path_buf(),
            listen: Box::new(move || {
                listened.fetch_add(1, Ordering::SeqCst);
            }),
            warn: Box::new(move |code| {
                warned.lock().unwrap().push(code.map(str::to_owned));
            }),
        })
    }

    fn app(&self) -> PathBuf {
        self.root.path().join("app")
    }

    fn fake_exec(&self, name: &str) -> String {
        let path = self.root.path().join(name);
        fs::write(&path, "#!/bin/sh\necho \"$@\"\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path.to_str().unwrap().to_owned()
    }
}

fn mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn ksh_c1_ksh_c81_with_the_setting_off_nothing_for_kept_shells_is_written_or_listened_on() {
    let f = fixture();
    let exec = f.fake_exec("exec");
    f.plumbing(&exec, &f.app()).start(false);
    let paths = kept_launcher_paths(&f.launcher_dir);
    assert!(!paths.node.exists());
    assert!(!paths.cli.exists());
    assert_eq!(f.listened.load(Ordering::SeqCst), 0);
}

#[test]
fn with_the_setting_on_writes_both_launchers_once_and_listens_once() {
    let f = fixture();
    let exec = f.fake_exec("exec");
    let kept = f.plumbing(&exec, &f.app());
    kept.start(true);
    kept.ensure();
    let paths = kept_launcher_paths(&f.launcher_dir);
    assert!(paths.node.exists());
    assert!(paths.cli.exists());
    assert_eq!(f.listened.load(Ordering::SeqCst), 1);
}

#[test]
fn ksh_c33_a_kept_pane_runs_the_cli_of_the_ostia_that_is_running_now() {
    let f = fixture();
    let old_app = f.root.path().join("old-app");
    let new_app = f.root.path().join("new-app");
    let old_exec = f.fake_exec("old-ostia");
    let new_exec = f.fake_exec("new-ostia");
    f.plumbing(&old_exec, &old_app).ensure();
    f.plumbing(&new_exec, &new_app).ensure();
    let paths = kept_launcher_paths(&f.launcher_dir);
    assert_eq!(
        paths.cli,
        f.root
            .path()
            .join("userData")
            .join("bin")
            .join("ostia-cli.js")
    );
    let ran = Command::new(&paths.node)
        .arg(&paths.cli)
        .env_clear()
        .env("HOME", f.root.path())
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(ran.stdout).unwrap().trim(),
        paths.cli.to_str().unwrap()
    );
    let node_script = fs::read_to_string(&paths.node).unwrap();
    assert!(node_script.contains("new-ostia"));
    assert!(!node_script.contains("old-ostia"));
    let cli_script = fs::read_to_string(&paths.cli).unwrap();
    assert!(cli_script.contains(new_app.join("out/cli/index.js").to_str().unwrap()));
    assert!(!cli_script.contains("old-app"));
}

#[test]
fn reports_a_launcher_it_cannot_write_and_still_listens() {
    let f = fixture();
    fs::write(f.root.path().join("userData"), "").unwrap();
    let exec = f.fake_exec("exec");
    f.plumbing(&exec, &f.app()).ensure();
    assert_eq!(*f.warned.lock().unwrap(), vec![Some("ENOTDIR".to_owned())]);
    assert_eq!(f.listened.load(Ordering::SeqCst), 1);
}

#[test]
fn names_the_node_launcher_and_the_cli_file_inside_the_launcher_folder() {
    let paths = kept_launcher_paths(Path::new("/data/bin"));
    assert_eq!(paths.node, Path::new("/data/bin/ostia-node"));
    assert_eq!(paths.cli, Path::new("/data/bin/ostia-cli.js"));
}

#[test]
fn writes_a_shell_launcher_that_execs_the_quoted_exec_path_and_a_cli_file_that_requires_the_app_cli()
 {
    let f = fixture();
    let app = f.root.path().join("my app");
    f.plumbing("/opt/o'brien/ostia", &app).ensure();
    let paths = kept_launcher_paths(&f.launcher_dir);
    assert_eq!(
        fs::read_to_string(&paths.node).unwrap(),
        "#!/bin/sh\nexec '/opt/o'\\''brien/ostia' \"$@\"\n"
    );
    let cli_path = app.join("out/cli/index.js");
    assert_eq!(
        fs::read_to_string(&paths.cli).unwrap(),
        format!(
            "require({})\n",
            serde_json::to_string(cli_path.to_str().unwrap()).unwrap()
        )
    );
}

#[test]
fn keeps_the_launchers_private_to_the_owner() {
    let f = fixture();
    let exec = f.fake_exec("exec");
    f.plumbing(&exec, &f.app()).ensure();
    let paths = kept_launcher_paths(&f.launcher_dir);
    assert_eq!(mode(&paths.node), 0o700);
    assert_eq!(mode(&paths.cli), 0o600);
    assert_eq!(mode(&f.launcher_dir), 0o700);
}

#[test]
fn does_not_warn_when_the_launchers_are_written() {
    let f = fixture();
    let exec = f.fake_exec("exec");
    f.plumbing(&exec, &f.app()).ensure();
    assert!(f.warned.lock().unwrap().is_empty());
}

#[test]
fn start_with_the_setting_on_after_ensure_listens_only_once() {
    let f = fixture();
    let exec = f.fake_exec("exec");
    let kept = f.plumbing(&exec, &f.app());
    kept.ensure();
    kept.ensure();
    kept.start(true);
    assert_eq!(f.listened.load(Ordering::SeqCst), 1);
}

#[test]
fn does_not_retry_the_write_after_a_failure() {
    let f = fixture();
    fs::write(f.root.path().join("userData"), "").unwrap();
    let exec = f.fake_exec("exec");
    let kept = f.plumbing(&exec, &f.app());
    kept.ensure();
    kept.ensure();
    assert_eq!(f.warned.lock().unwrap().len(), 1);
    assert_eq!(f.listened.load(Ordering::SeqCst), 1);
}

#[test]
fn a_second_ensure_waits_until_the_first_has_written_and_listened() {
    use std::sync::mpsc;
    use std::time::Duration;

    let f = fixture();
    let exec = f.fake_exec("exec");
    let paths = kept_launcher_paths(&f.launcher_dir);
    let listened = Arc::clone(&f.listened);
    let (started, started_rx) = mpsc::channel::<()>();
    let started = Mutex::new(started);
    let plumbing = Arc::new(KeptPlumbing::new(KeptPlumbingOptions {
        launcher_dir: f.launcher_dir.clone(),
        exec_path: exec,
        app_path: f.app(),
        listen: Box::new(move || {
            started.lock().unwrap().send(()).unwrap();
            std::thread::sleep(Duration::from_millis(200));
            listened.fetch_add(1, Ordering::SeqCst);
        }),
        warn: Box::new(|_| {}),
    }));
    let first = {
        let plumbing = Arc::clone(&plumbing);
        std::thread::spawn(move || plumbing.ensure())
    };
    started_rx.recv().unwrap();
    plumbing.ensure();
    assert_eq!(f.listened.load(Ordering::SeqCst), 1);
    assert!(paths.node.exists());
    assert!(paths.cli.exists());
    first.join().unwrap();
    assert_eq!(f.listened.load(Ordering::SeqCst), 1);
}
