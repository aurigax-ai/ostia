#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::fs;
use std::future::Future;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ostia_contract::install_method::{ReplaceAvailability, ReplaceBlock, ReplaceFailure};
use ostia_contract::releases::ReleaseInfo;
use ostia_sync::install_replace::ReplaceError;
use ostia_sync::mac_replace::{
    CommandResult, ReplaceMacInstall, RunCommand, SignaturePolicy, SwapDeps, SwapResult,
    can_replace_bundle, designated_requirement, discard_staged, old_bundle_path,
    replace_mac_install, run_command, signature_policy, staged_bundle_path, swap_staged_bundle,
    verify_staged_sync,
};
use support::{FakeHttp, Reply, copy_dir, is_root, linux_host, names, sha256_hex, write};
use tempfile::TempDir;

type CommandFuture = Pin<Box<dyn Future<Output = CommandResult> + Send>>;

const VERSION: &str = "0.6.0-rc.2";
const DMG: &str = "ostia-0.6.0-rc.2-arm64.dmg";
const DOWNLOAD: &str = "/aurigax-ai/ostia/releases/download/v0.6.0-rc.2";
const TEAM_REQUIREMENT: &str = "anchor apple generic and certificate leaf[subject.OU] = \"4ZNCN9338G\" and identifier \"ai.aurigax.ostia\"";
const DMG_BYTES: &[u8] = b"fake disk image bytes";

fn app_bundle(dir: &Path, version: &str) -> PathBuf {
    write(
        &dir.join("Contents").join("Resources").join("app.asar"),
        "asar archive",
    );
    write(&dir.join("Contents").join("Info.plist"), version);
    write(
        &dir.join("Contents")
            .join("Resources")
            .join("build-info.json"),
        &format!(r#"{{"version":"{version}+sha.abc","builtAt":"2026-10-13T00:00:00Z"}}"#),
    );
    dir.to_path_buf()
}

fn installed(root: &Path) -> PathBuf {
    fs::create_dir_all(root.join("Applications")).unwrap();
    app_bundle(&root.join("Applications").join("Ostia.app"), "0.5.12")
}

fn bundle_version(bundle: &Path) -> String {
    fs::read_to_string(bundle.join("Contents").join("Info.plist")).unwrap()
}

#[derive(Default)]
struct Overrides {
    codesign: Option<CommandResult>,
    requirement: Option<CommandResult>,
    spctl: Option<CommandResult>,
    attach: Option<CommandResult>,
    ditto: Option<CommandResult>,
    plist: Option<String>,
}

struct FakeTools {
    run: RunCommand,
    calls: Arc<Mutex<Vec<Vec<String>>>>,
    mount_point: Arc<Mutex<Option<PathBuf>>>,
}

impl FakeTools {
    fn calls(&self) -> Vec<Vec<String>> {
        self.calls.lock().unwrap().clone()
    }

    fn mounted(&self) -> bool {
        self.mount_point.lock().unwrap().is_some()
    }

    fn did(&self, command: &str, verb: &str) -> bool {
        self.calls()
            .iter()
            .any(|call| call[0] == command && call.get(1).map(String::as_str) == Some(verb))
    }
}

fn result(code: i32, output: &str) -> CommandResult {
    CommandResult {
        code,
        output: output.to_owned(),
    }
}

fn fake_tools(image: &Path, over: Overrides) -> FakeTools {
    let calls: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let mount_point: Arc<Mutex<Option<PathBuf>>> = Arc::default();
    let image = image.to_path_buf();
    let over = Arc::new(over);
    let run: RunCommand = Arc::new({
        let calls = Arc::clone(&calls);
        let mount_point = Arc::clone(&mount_point);
        move |command: String, args: Vec<String>| -> CommandFuture {
            let calls = Arc::clone(&calls);
            let mount_point = Arc::clone(&mount_point);
            let image = image.clone();
            let over = Arc::clone(&over);
            Box::pin(async move {
                let mut call = vec![command.clone()];
                call.extend(args.iter().cloned());
                calls.lock().unwrap().push(call);
                let ok = result(0, "");
                match (command.as_str(), args.first().map(String::as_str)) {
                    ("hdiutil", Some("attach")) => {
                        if let Some(attach) = &over.attach {
                            return attach.clone();
                        }
                        let at = args.iter().position(|arg| arg == "-mountpoint").unwrap();
                        let mount = PathBuf::from(&args[at + 1]);
                        copy_dir(&image, &mount.join("Ostia.app"));
                        *mount_point.lock().unwrap() = Some(mount);
                        ok
                    }
                    ("hdiutil", Some("detach")) => {
                        if let Some(mount) = mount_point.lock().unwrap().take() {
                            let _ = fs::remove_dir_all(mount.join("Ostia.app"));
                        }
                        ok
                    }
                    ("ditto", _) => {
                        if let Some(ditto) = &over.ditto {
                            return ditto.clone();
                        }
                        copy_dir(Path::new(&args[0]), Path::new(&args[1]));
                        ok
                    }
                    ("codesign", _) => {
                        let requirement = args.iter().any(|arg| arg.starts_with("-R="));
                        let chosen = if requirement {
                            &over.requirement
                        } else {
                            &over.codesign
                        };
                        chosen.clone().unwrap_or(ok)
                    }
                    ("spctl", _) => over.spctl.clone().unwrap_or_else(|| {
                        result(
                            0,
                            &format!(
                                "{}: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: AurigaX (4ZNCN9338G)\n",
                                args.last().unwrap()
                            ),
                        )
                    }),
                    ("plutil", _) => {
                        let plist = fs::read_to_string(args.last().unwrap()).unwrap();
                        let text = over.plist.clone().unwrap_or(plist);
                        result(0, &format!("{text}\n"))
                    }
                    (other, _) => result(127, &format!("unexpected {other}")),
                }
            })
        }
    });
    FakeTools {
        run,
        calls,
        mount_point,
    }
}

fn release_files(server: &FakeHttp, sum: &str) {
    server.route(&format!("{DOWNLOAD}/{DMG}"), Reply::ok(DMG_BYTES));
    server.route(
        &format!("{DOWNLOAD}/SHA256SUMS"),
        Reply::ok(format!("{sum}  {DMG}\n{}  other.tar.gz\n", "0".repeat(64))),
    );
}

fn dmg_sha() -> String {
    sha256_hex(DMG_BYTES)
}

fn release_info(dmg_sha256: Option<String>) -> ReleaseInfo {
    ReleaseInfo {
        version: VERSION.to_owned(),
        url: format!("https://github.com/aurigax-ai/ostia/releases/tag/v{VERSION}"),
        dmg_sha256,
    }
}

struct Run<'a> {
    bundle: &'a Path,
    root: &'a Path,
    tools: &'a FakeTools,
    server: &'a FakeHttp,
    release: ReleaseInfo,
}

async fn replace_with(run: Run<'_>) -> Result<(), ReplaceError> {
    let work = run.root.join("work");
    fs::create_dir_all(&work).unwrap();
    let outcome = replace_mac_install(ReplaceMacInstall {
        bundle: run.bundle.to_path_buf(),
        release: run.release,
        base: run.server.url.clone(),
        run: Arc::clone(&run.tools.run),
        policy: SignaturePolicy::Release,
        timeout: Duration::from_secs(10),
        on_progress: Arc::new(|_| {}),
        on_installing: Arc::new(|| {}),
        work_root: Some(work.clone()),
        is_arm64: true,
    })
    .await;
    assert!(names(&work).is_empty(), "the work folder must be cleaned");
    assert!(!run.tools.mounted(), "the image must be detached");
    outcome
}

#[tokio::test]
async fn stages_the_verified_app_next_to_the_installed_one_and_leaves_the_installed_one_alone() {
    let root = TempDir::new().unwrap();
    let bundle = installed(root.path());
    let image = app_bundle(&root.path().join("image").join("Ostia.app"), VERSION);
    let tools = fake_tools(&image, Overrides::default());
    let server = FakeHttp::start().await;
    release_files(&server, &dmg_sha());

    replace_with(Run {
        bundle: &bundle,
        root: root.path(),
        tools: &tools,
        server: &server,
        release: release_info(Some(dmg_sha())),
    })
    .await
    .unwrap();

    assert_eq!(bundle_version(&bundle), "0.5.12");
    assert_eq!(bundle_version(&staged_bundle_path(&bundle)), VERSION);
    assert_eq!(
        staged_bundle_path(&bundle),
        root.path().join("Applications").join(".Ostia.app.new")
    );
    let staged = staged_bundle_path(&bundle).to_string_lossy().into_owned();
    let calls = tools.calls();
    assert!(calls.contains(&vec![
        "codesign".to_owned(),
        "--verify".to_owned(),
        "--deep".to_owned(),
        "--strict".to_owned(),
        staged.clone()
    ]));
    assert!(calls.contains(&vec![
        "codesign".to_owned(),
        "--verify".to_owned(),
        "--deep".to_owned(),
        "--strict".to_owned(),
        format!("-R={TEAM_REQUIREMENT}"),
        staged.clone()
    ]));
    assert!(calls.contains(&vec![
        "spctl".to_owned(),
        "-a".to_owned(),
        "-t".to_owned(),
        "exec".to_owned(),
        "-vv".to_owned(),
        staged
    ]));
    let attach = calls
        .iter()
        .find(|call| call[0] == "hdiutil" && call[1] == "attach")
        .unwrap();
    assert_eq!(
        attach[1..6],
        [
            "attach",
            "-nobrowse",
            "-readonly",
            "-noautoopen",
            "-mountpoint"
        ]
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call[0] == "hdiutil" && call[1] == "detach")
            .count(),
        1
    );
}

struct Failing {
    name: &'static str,
    reason: ReplaceFailure,
    over: Overrides,
    tamper_dmg: bool,
    sums_for: Option<&'static str>,
    release_sha: Option<Option<String>>,
    image_version: &'static str,
}

fn failing(name: &'static str, reason: ReplaceFailure) -> Failing {
    Failing {
        name,
        reason,
        over: Overrides::default(),
        tamper_dmg: false,
        sums_for: None,
        release_sha: None,
        image_version: VERSION,
    }
}

#[tokio::test]
async fn changes_nothing_detaches_and_cleans_up_after_each_failure() {
    let table = [
        Failing {
            over: Overrides {
                codesign: Some(result(1, "invalid signature")),
                ..Overrides::default()
            },
            ..failing("a broken signature", ReplaceFailure::BadSignature)
        },
        Failing {
            over: Overrides {
                requirement: Some(result(3, "does not satisfy its requirement")),
                ..Overrides::default()
            },
            ..failing("another team or identifier", ReplaceFailure::WrongTeam)
        },
        Failing {
            over: Overrides {
                spctl: Some(result(3, "rejected")),
                ..Overrides::default()
            },
            ..failing(
                "a rejected Gatekeeper assessment",
                ReplaceFailure::NotNotarized,
            )
        },
        Failing {
            over: Overrides {
                spctl: Some(result(0, "accepted\nsource=Developer ID\n")),
                ..Overrides::default()
            },
            ..failing(
                "a signed but not notarized app",
                ReplaceFailure::NotNotarized,
            )
        },
        Failing {
            over: Overrides {
                plist: Some("0.6.0-rc.1".to_owned()),
                ..Overrides::default()
            },
            ..failing(
                "another version in Info.plist",
                ReplaceFailure::WrongVersion,
            )
        },
        Failing {
            image_version: "0.6.0-rc.1",
            ..failing(
                "another version in build-info.json",
                ReplaceFailure::WrongVersion,
            )
        },
        Failing {
            over: Overrides {
                attach: Some(result(1, "corrupt image")),
                ..Overrides::default()
            },
            ..failing("a dmg that does not mount", ReplaceFailure::MountFailed)
        },
        Failing {
            over: Overrides {
                ditto: Some(result(1, "no space")),
                ..Overrides::default()
            },
            ..failing("a copy that fails", ReplaceFailure::ExtractFailed)
        },
        Failing {
            tamper_dmg: true,
            ..failing(
                "a download that does not match SHA256SUMS",
                ReplaceFailure::ChecksumMismatch,
            )
        },
        Failing {
            release_sha: Some(Some("f".repeat(64))),
            ..failing(
                "SHA256SUMS that disagrees with the asset digest",
                ReplaceFailure::ChecksumMismatch,
            )
        },
        Failing {
            release_sha: Some(None),
            ..failing(
                "a release without an asset digest",
                ReplaceFailure::NoChecksum,
            )
        },
        Failing {
            sums_for: Some("other.dmg"),
            ..failing("SHA256SUMS without the dmg", ReplaceFailure::NoChecksum)
        },
    ];
    for case in table {
        let root = TempDir::new().unwrap();
        let bundle = installed(root.path());
        let image = app_bundle(
            &root.path().join("image").join("Ostia.app"),
            case.image_version,
        );
        let tools = fake_tools(&image, case.over);
        let server = FakeHttp::start().await;
        release_files(&server, &dmg_sha());
        if case.tamper_dmg {
            server.route(&format!("{DOWNLOAD}/{DMG}"), Reply::ok("tampered"));
        }
        if let Some(asset) = case.sums_for {
            server.route(
                &format!("{DOWNLOAD}/SHA256SUMS"),
                Reply::ok(format!("{}  {asset}\n", dmg_sha())),
            );
        }
        let release = release_info(case.release_sha.unwrap_or_else(|| Some(dmg_sha())));

        let outcome = replace_with(Run {
            bundle: &bundle,
            root: root.path(),
            tools: &tools,
            server: &server,
            release,
        })
        .await;

        assert_eq!(outcome.unwrap_err().reason(), case.reason, "{}", case.name);
        assert_eq!(bundle_version(&bundle), "0.5.12", "{}", case.name);
        assert_eq!(
            names(&root.path().join("Applications")),
            ["Ostia.app"],
            "{}",
            case.name
        );
        let attached = tools.did("hdiutil", "attach");
        let detached = tools.did("hdiutil", "detach");
        assert_eq!(
            detached,
            attached && case.reason != ReplaceFailure::MountFailed,
            "{}",
            case.name
        );
    }
}

#[tokio::test]
async fn refuses_before_downloading_when_the_bundle_cannot_be_replaced() {
    let root = TempDir::new().unwrap();
    let bundle = installed(root.path());
    fs::create_dir(old_bundle_path(&bundle)).unwrap();
    let tools = fake_tools(&root.path().join("none"), Overrides::default());
    let server = FakeHttp::start().await;
    release_files(&server, &dmg_sha());
    let outcome = replace_with(Run {
        bundle: &bundle,
        root: root.path(),
        tools: &tools,
        server: &server,
        release: release_info(Some(dmg_sha())),
    })
    .await;
    assert_eq!(outcome.unwrap_err().reason(), ReplaceFailure::Blocked);
    assert!(tools.calls().is_empty());
}

#[tokio::test]
async fn refuses_a_dmg_asset_name_that_is_not_a_plain_version_before_anything_runs() {
    let root = TempDir::new().unwrap();
    let bundle = installed(root.path());
    let tools = fake_tools(&root.path().join("none"), Overrides::default());
    let server = FakeHttp::start().await;
    let outcome = replace_with(Run {
        bundle: &bundle,
        root: root.path(),
        tools: &tools,
        server: &server,
        release: ReleaseInfo {
            version: "0.6.0+sha.abc".to_owned(),
            ..release_info(Some(dmg_sha()))
        },
    })
    .await;
    assert_eq!(outcome.unwrap_err().reason(), ReplaceFailure::HttpError);
    assert!(tools.calls().is_empty());
    assert!(server.paths().is_empty());
}

fn blocked(reason: ReplaceBlock) -> ReplaceAvailability {
    ReplaceAvailability::Blocked { reason, path: None }
}

#[tokio::test]
async fn accepts_a_writable_bundle_in_a_writable_folder() {
    let root = TempDir::new().unwrap();
    assert_eq!(
        can_replace_bundle(&installed(root.path()), true).await,
        ReplaceAvailability::Ok
    );
}

#[tokio::test]
async fn refuses_an_app_running_translocated_or_from_a_mounted_disk_image_before_touching_the_disk()
{
    assert_eq!(
        can_replace_bundle(
            Path::new("/private/var/folders/x/T/AppTranslocation/1234/d/Ostia.app"),
            true
        )
        .await,
        blocked(ReplaceBlock::Translocated)
    );
    assert_eq!(
        can_replace_bundle(Path::new("/Volumes/Ostia 0.6.0/Ostia.app"), true).await,
        blocked(ReplaceBlock::ReadOnly)
    );
}

#[tokio::test]
async fn refuses_a_mac_without_an_arm64_disk_image() {
    let root = TempDir::new().unwrap();
    assert_eq!(
        can_replace_bundle(&installed(root.path()), false).await,
        blocked(ReplaceBlock::Unsupported)
    );
}

#[tokio::test]
async fn refuses_a_symlinked_bundle_and_a_missing_one() {
    let root = TempDir::new().unwrap();
    let bundle = installed(root.path());
    let link = root.path().join("Applications").join("Linked.app");
    symlink(&bundle, &link).unwrap();
    assert_eq!(
        can_replace_bundle(&link, true).await,
        blocked(ReplaceBlock::Symlink)
    );
    assert_eq!(
        can_replace_bundle(&root.path().join("Gone.app"), true).await,
        blocked(ReplaceBlock::NotWritable)
    );
}

#[tokio::test]
async fn names_a_staged_or_old_copy_left_by_an_earlier_update() {
    let root = TempDir::new().unwrap();
    let bundle = installed(root.path());
    fs::create_dir(staged_bundle_path(&bundle)).unwrap();
    assert_eq!(
        can_replace_bundle(&bundle, true).await,
        ReplaceAvailability::Blocked {
            reason: ReplaceBlock::Leftover,
            path: Some(staged_bundle_path(&bundle).to_string_lossy().into_owned()),
        }
    );
    discard_staged(&bundle).await.unwrap();
    fs::create_dir(old_bundle_path(&bundle)).unwrap();
    assert_eq!(
        can_replace_bundle(&bundle, true).await,
        ReplaceAvailability::Blocked {
            reason: ReplaceBlock::Leftover,
            path: Some(old_bundle_path(&bundle).to_string_lossy().into_owned()),
        }
    );
}

#[tokio::test]
async fn refuses_a_folder_the_user_cannot_write() {
    if is_root() {
        return;
    }
    let root = TempDir::new().unwrap();
    let bundle = installed(root.path());
    let folder = root.path().join("Applications");
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();
    let result = can_replace_bundle(&bundle, true).await;
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(result, blocked(ReplaceBlock::NotWritable));
}

#[test]
fn ignores_the_ad_hoc_switch_in_a_packaged_build() {
    let env = linux_host(&[("OSTIA_UPDATE_SIGNATURE", "adhoc")]);
    assert_eq!(signature_policy(true, &env), SignaturePolicy::Release);
    assert_eq!(signature_policy(false, &env), SignaturePolicy::Adhoc);
    assert_eq!(
        signature_policy(false, &linux_host(&[])),
        SignaturePolicy::Release
    );
    assert_eq!(
        signature_policy(false, &linux_host(&[("OSTIA_UPDATE_SIGNATURE", "none")])),
        SignaturePolicy::Release
    );
}

#[test]
fn pins_the_developer_id_team_and_the_bundle_identifier_for_releases() {
    assert_eq!(
        designated_requirement(SignaturePolicy::Release),
        TEAM_REQUIREMENT
    );
    assert_eq!(
        designated_requirement(SignaturePolicy::Adhoc),
        "identifier \"ai.aurigax.ostia\""
    );
}

#[test]
fn names_the_staged_copy_beside_the_bundle_and_the_old_copy_after_it() {
    assert_eq!(
        staged_bundle_path(Path::new("/Applications/Ostia Beta.app")),
        Path::new("/Applications/.Ostia Beta.app.new")
    );
    assert_eq!(
        old_bundle_path(Path::new("/Applications/Ostia Beta.app")),
        Path::new("/Applications/Ostia Beta.app.old")
    );
}

fn trusted() -> SwapDeps<'static> {
    SwapDeps {
        verify: &|_| true,
        rename: None,
    }
}

#[test]
fn moves_the_installed_bundle_aside_and_the_staged_one_into_place_with_spaces_in_the_path() {
    let root = TempDir::new().unwrap();
    let bundle = installed(root.path());
    app_bundle(&staged_bundle_path(&bundle), VERSION);
    let checked: Mutex<Vec<PathBuf>> = Mutex::default();
    let verify = |staged: &Path| {
        checked.lock().unwrap().push(staged.to_path_buf());
        true
    };
    assert_eq!(
        swap_staged_bundle(
            &bundle,
            SwapDeps {
                verify: &verify,
                rename: None
            }
        ),
        SwapResult::Swapped
    );
    assert_eq!(*checked.lock().unwrap(), [staged_bundle_path(&bundle)]);
    assert_eq!(bundle_version(&bundle), VERSION);
    assert_eq!(bundle_version(&old_bundle_path(&bundle)), "0.5.12");
    assert!(!staged_bundle_path(&bundle).exists());
}

#[test]
fn does_nothing_without_a_staged_bundle_or_with_an_old_one_still_there() {
    let root = TempDir::new().unwrap();
    let bundle = installed(root.path());
    assert_eq!(
        swap_staged_bundle(&bundle, trusted()),
        SwapResult::NothingStaged
    );
    app_bundle(&staged_bundle_path(&bundle), VERSION);
    fs::create_dir(old_bundle_path(&bundle)).unwrap();
    assert_eq!(swap_staged_bundle(&bundle, trusted()), SwapResult::Failed);
    assert_eq!(bundle_version(&bundle), "0.5.12");
}

#[test]
fn checks_the_signature_again_right_before_the_swap_and_drops_a_staged_bundle_that_fails_it() {
    let root = TempDir::new().unwrap();
    let bundle = installed(root.path());
    app_bundle(&staged_bundle_path(&bundle), VERSION);
    assert_eq!(
        swap_staged_bundle(
            &bundle,
            SwapDeps {
                verify: &|_| false,
                rename: None
            }
        ),
        SwapResult::Rejected
    );
    assert_eq!(bundle_version(&bundle), "0.5.12");
    assert_eq!(names(&root.path().join("Applications")), ["Ostia.app"]);
}

#[test]
fn drops_a_staged_symlink_or_file_without_following_it_or_verifying_it() {
    let root = TempDir::new().unwrap();
    let bundle = installed(root.path());
    let elsewhere = app_bundle(&root.path().join("elsewhere").join("Ostia.app"), VERSION);
    let verify = |_: &Path| -> bool { panic!("verified a staged entry that is not a folder") };
    let deps = || SwapDeps {
        verify: &verify,
        rename: None,
    };
    symlink(&elsewhere, staged_bundle_path(&bundle)).unwrap();
    assert_eq!(swap_staged_bundle(&bundle, deps()), SwapResult::Rejected);
    assert!(fs::symlink_metadata(staged_bundle_path(&bundle)).is_err());
    assert_eq!(bundle_version(&elsewhere), VERSION);
    fs::write(staged_bundle_path(&bundle), "not an app").unwrap();
    assert_eq!(swap_staged_bundle(&bundle, deps()), SwapResult::Rejected);
    assert_eq!(names(&root.path().join("Applications")), ["Ostia.app"]);
    assert_eq!(bundle_version(&bundle), "0.5.12");
}

#[test]
fn puts_the_installed_bundle_back_when_the_staged_one_cannot_be_moved_in() {
    let root = TempDir::new().unwrap();
    let bundle = installed(root.path());
    app_bundle(&staged_bundle_path(&bundle), VERSION);
    let calls = Mutex::new(0);
    let rename = |from: &Path, to: &Path| -> std::io::Result<()> {
        let mut calls = calls.lock().unwrap();
        *calls += 1;
        if *calls == 2 {
            return Err(std::io::Error::other("EXDEV"));
        }
        copy_dir(from, to);
        fs::remove_dir_all(from)
    };
    assert_eq!(
        swap_staged_bundle(
            &bundle,
            SwapDeps {
                verify: &|_| true,
                rename: Some(&rename)
            }
        ),
        SwapResult::Failed
    );
    assert_eq!(bundle_version(&bundle), "0.5.12");
    assert!(!old_bundle_path(&bundle).exists());
}

#[test]
fn fails_closed_for_a_folder_that_is_not_a_signed_app() {
    let root = TempDir::new().unwrap();
    let unsigned = app_bundle(&root.path().join("Unsigned.app"), VERSION);
    assert!(!verify_staged_sync(&unsigned, SignaturePolicy::Release));
    assert!(!verify_staged_sync(&unsigned, SignaturePolicy::Adhoc));
    assert!(!verify_staged_sync(
        &root.path().join("missing.app"),
        SignaturePolicy::Adhoc
    ));
}

#[tokio::test]
async fn passes_arguments_without_a_shell_and_reports_the_exit_code() {
    let echoed = run_command("/bin/echo", &["a b; echo c".to_owned()]).await;
    assert_eq!(echoed, result(0, "a b; echo c\n"));
    let exited = run_command("/bin/sh", &["-c".to_owned(), "exit 3".to_owned()]).await;
    assert_eq!(exited.code, 3);
    let missing = run_command("/nonexistent/tool-for-this-test", &[]).await;
    assert_ne!(missing.code, 0);
}
