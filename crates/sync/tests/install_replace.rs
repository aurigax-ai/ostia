#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::fs;
use std::future::Future;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ostia_contract::install_method::{
    ReplaceAvailability, ReplaceBlock, ReplaceFailure, ReplaceStart, ReplaceState,
};
use ostia_contract::releases::{ReleaseInfo, tarball_asset_name};
use ostia_sync::install_replace::{
    ArchiveEntry, ArchiveEntryKind, InstallReplacer, InstallReplacerDeps, PendingSweep,
    ReplaceError, ReplaceFuture, ReplaceInstallOptions, ReplaceJob, RunTar, TarballReplace,
    allowed_hop, can_replace_install, check_archive, checksum_for, entry_problem,
    release_asset_url, release_download_base, replace_install, run_tar, swap_install,
    sweep_old_install, tarball_replace,
};
use support::{FakeHttp, Reply, eventually, is_root, linux_host, names, sha256_hex, tar_gz, write};
use tempfile::TempDir;

const VERSION: &str = "9.9.9";
const OLD: &str = "1.0.0";

fn app_folder(dir: &Path, version: &str) {
    fs::create_dir_all(dir.join("resources")).unwrap();
    let binary = dir.join("ostia");
    fs::write(&binary, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
    write(
        &dir.join("resources").join("build-info.json"),
        &format!(r#"{{"version":"{version}","builtAt":"2026-10-07T00:00:00Z"}}"#),
    );
}

fn archive(root: &Path, version: &str, edit: impl FnOnce(&Path)) -> Vec<u8> {
    let stage = tempfile::Builder::new()
        .prefix("stage-")
        .tempdir_in(root)
        .unwrap();
    let folder = format!("ostia-{version}-linux-x64");
    let top = stage.path().join(&folder);
    app_folder(&top, version);
    edit(&top);
    let file = stage.path().join("out.tar.gz");
    tar_gz(stage.path(), &folder, &file);
    fs::read(file).unwrap()
}

fn asset_path(asset: &str) -> String {
    format!("/aurigax-ai/ostia/releases/download/v{VERSION}/{asset}")
}

fn serve_release(server: &FakeHttp, data: &[u8], sums: Option<String>) {
    server.route(
        &asset_path(&tarball_asset_name(VERSION)),
        Reply::ok(data.to_vec()),
    );
    let sums = sums.unwrap_or_else(|| {
        format!(
            "{}  {}\n{}  other.deb\n",
            sha256_hex(data),
            tarball_asset_name(VERSION),
            "0".repeat(64)
        )
    });
    server.route(&asset_path("SHA256SUMS"), Reply::ok(sums));
}

fn installed(root: &Path) -> PathBuf {
    let app_dir = root.join("apps").join("ostia");
    app_folder(&app_dir, OLD);
    app_dir
}

type TarFuture = Pin<Box<dyn Future<Output = Result<(), ReplaceError>> + Send>>;

fn tar_runner() -> RunTar {
    Arc::new(|args: Vec<String>| -> TarFuture { Box::pin(run_tar(args)) })
}

fn options(app_dir: &Path, base: &str) -> ReplaceInstallOptions {
    ReplaceInstallOptions {
        app_dir: app_dir.to_path_buf(),
        version: VERSION.to_owned(),
        base: base.to_owned(),
        tar: tar_runner(),
        timeout: Duration::from_secs(30),
        on_progress: Arc::new(|_| {}),
        on_installing: Arc::new(|| {}),
    }
}

async fn replace_from(server: &FakeHttp, app_dir: &Path) -> Result<(), ReplaceError> {
    replace_install(options(app_dir, &server.url)).await
}

fn failure(result: Result<(), ReplaceError>) -> ReplaceFailure {
    result.unwrap_err().reason()
}

fn version_in(dir: &Path) -> String {
    let text = fs::read_to_string(dir.join("resources").join("build-info.json")).unwrap();
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    value["version"].as_str().unwrap().to_owned()
}

fn untouched(app_dir: &Path) {
    assert_eq!(version_in(app_dir), OLD);
    assert_eq!(names(app_dir.parent().unwrap()), ["ostia"]);
}

fn old_of(app_dir: &Path) -> PathBuf {
    PathBuf::from(format!("{}.old", app_dir.display()))
}

fn new_of(app_dir: &Path) -> PathBuf {
    PathBuf::from(format!("{}.new", app_dir.display()))
}

fn download_of(app_dir: &Path) -> PathBuf {
    PathBuf::from(format!("{}.download", app_dir.display()))
}

#[test]
fn builds_the_download_url_from_the_repository_and_the_parsed_version_only() {
    assert_eq!(
        release_asset_url("https://github.com", "1.2.3", &tarball_asset_name("1.2.3"))
            .unwrap()
            .as_str(),
        "https://github.com/aurigax-ai/ostia/releases/download/v1.2.3/ostia-1.2.3-linux-x64.tar.gz"
    );
    assert_eq!(
        release_asset_url("https://github.com", "1.2.3", "SHA256SUMS")
            .unwrap()
            .path(),
        "/aurigax-ai/ostia/releases/download/v1.2.3/SHA256SUMS"
    );
}

#[test]
fn refuses_a_version_that_is_not_plain_semver_and_an_asset_name_with_a_path() {
    assert_eq!(
        release_asset_url("https://github.com", "1.2.3/../../x", "a"),
        None
    );
    assert_eq!(
        release_asset_url("https://github.com", "1.2.3+sha.1", "a"),
        None
    );
    assert_eq!(
        release_asset_url("https://github.com", "1.2.3", "../a"),
        None
    );
}

#[test]
fn takes_the_download_base_from_the_env_only_when_unpackaged() {
    let host = linux_host(&[("OSTIA_RELEASE_DOWNLOAD_BASE_URL", "http://127.0.0.1:1")]);
    assert_eq!(release_download_base(false, &host), "http://127.0.0.1:1");
    assert_eq!(release_download_base(true, &host), "https://github.com");
    assert_eq!(
        release_download_base(false, &linux_host(&[])),
        "https://github.com"
    );
}

#[test]
fn allows_only_https_on_github_hosts_for_the_real_base() {
    let base = "https://github.com";
    assert!(allowed_hop("https://github.com/a", base));
    assert!(allowed_hop("https://objects.githubusercontent.com/a", base));
    assert!(!allowed_hop("http://github.com/a", base));
    assert!(!allowed_hop("https://evil.example/a", base));
    assert!(!allowed_hop("https://github.com:8443/a", base));
    assert!(!allowed_hop("https://u:p@github.com/a", base));
}

#[test]
fn allows_only_the_origin_of_a_test_base() {
    let base = "http://127.0.0.1:4000";
    assert!(allowed_hop("http://127.0.0.1:4000/a", base));
    assert!(!allowed_hop("http://127.0.0.1:4001/a", base));
    assert!(!allowed_hop("https://github.com/a", base));
}

#[test]
fn reads_the_line_for_the_asset_in_sha256sum_format() {
    let sum = "a".repeat(64);
    assert_eq!(
        checksum_for(&format!("{sum}  x.tar.gz\n"), "x.tar.gz"),
        Some(sum.clone())
    );
    assert_eq!(
        checksum_for(&format!("{sum} *x.tar.gz\n"), "x.tar.gz"),
        Some(sum.clone())
    );
    assert_eq!(
        checksum_for(&format!("{sum}  y.tar.gz\n"), "x.tar.gz"),
        None
    );
    assert_eq!(checksum_for("nothing here", "x.tar.gz"), None);
}

#[test]
fn reads_only_a_lowercase_64_digit_sum_and_trims_the_line_end() {
    let sum = "b".repeat(64);
    assert_eq!(
        checksum_for(&format!("{sum}  x.tar.gz\r\n"), "x.tar.gz"),
        Some(sum.clone())
    );
    assert_eq!(
        checksum_for(&format!("{}  x.tar.gz\n", "B".repeat(64)), "x.tar.gz"),
        None
    );
    assert_eq!(
        checksum_for(&format!("{}  x.tar.gz\n", "b".repeat(63)), "x.tar.gz"),
        None
    );
    assert_eq!(
        checksum_for(
            &format!("{}  other\n{sum}  x.tar.gz\n", "c".repeat(64)),
            "x.tar.gz"
        ),
        Some(sum)
    );
}

fn entry<'a>(path: &'a str, kind: ArchiveEntryKind, linkpath: Option<&'a str>) -> ArchiveEntry<'a> {
    ArchiveEntry {
        path,
        kind,
        linkpath,
    }
}

#[test]
fn refuses_dotdot_absolute_paths_special_files_and_links_that_leave_the_folder() {
    use ArchiveEntryKind::{CharacterDevice, File, Link, SymbolicLink};
    let refused = [
        entry("top/a/../../x", File, None),
        entry("/etc/passwd", File, None),
        entry("top/dev", CharacterDevice, None),
        entry("top/l", SymbolicLink, Some("/etc")),
        entry("top/l", SymbolicLink, Some("../x")),
        entry("top/a/l", SymbolicLink, Some("../../x")),
        entry("top/h", Link, Some("../x")),
    ];
    for item in refused {
        assert!(entry_problem(&item), "{item:?}");
    }
}

#[test]
fn allows_files_folders_and_links_that_stay_inside() {
    use ArchiveEntryKind::{Directory, File, Link, SymbolicLink};
    let allowed = [
        entry("top/", Directory, None),
        entry("top/a/b", File, None),
        entry("top/a/l", SymbolicLink, Some("../b")),
        entry("top/h", Link, Some("top/a/b")),
    ];
    for item in allowed {
        assert!(!entry_problem(&item), "{item:?}");
    }
}

#[test]
fn refuses_backslashes_nul_bytes_and_links_without_a_target() {
    use ArchiveEntryKind::{File, Link, SymbolicLink};
    let refused = [
        entry("top\\a", File, None),
        entry("top/a\0b", File, None),
        entry("top/l", SymbolicLink, None),
        entry("top/l", SymbolicLink, Some("")),
        entry("top/l", SymbolicLink, Some("a\0b")),
        entry("l", SymbolicLink, Some("a")),
        entry("top/h", Link, None),
        entry("top/h", Link, Some("/etc/passwd")),
        entry("top/h", Link, Some("top")),
    ];
    for item in refused {
        assert!(entry_problem(&item), "{item:?}");
    }
}

#[tokio::test]
async fn refuses_an_archive_on_disk_that_holds_a_symlink_pointing_outside() {
    let root = TempDir::new().unwrap();
    let data = archive(root.path(), VERSION, |top| {
        symlink("../../outside", top.join("escape")).unwrap();
    });
    let file = root.path().join("bad.tar.gz");
    fs::write(&file, data).unwrap();
    assert_eq!(
        check_archive(&file).await.unwrap_err().reason(),
        ReplaceFailure::BadArchive
    );
}

fn gzip_member(bytes: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

#[tokio::test]
async fn refuses_a_symlink_that_hides_in_a_second_gzip_member() {
    let mut builder = tar::Builder::new(Vec::new());
    let mut folder = tar::Header::new_gnu();
    folder.set_entry_type(tar::EntryType::Directory);
    folder.set_mode(0o755);
    folder.set_size(0);
    builder
        .append_data(&mut folder, "top/", std::io::empty())
        .unwrap();
    let mut file_header = tar::Header::new_gnu();
    file_header.set_mode(0o644);
    file_header.set_size(1);
    builder
        .append_data(&mut file_header, "top/a", &b"x"[..])
        .unwrap();
    let first_part = builder.get_ref().len();
    let mut link = tar::Header::new_gnu();
    link.set_entry_type(tar::EntryType::Symlink);
    link.set_mode(0o777);
    link.set_size(0);
    builder.append_link(&mut link, "top/l", "/etc").unwrap();
    let tar_bytes = builder.into_inner().unwrap();
    let mut data = gzip_member(&tar_bytes[..first_part]);
    data.extend(gzip_member(&tar_bytes[first_part..]));
    let root = TempDir::new().unwrap();
    let file = root.path().join("two-members.tar.gz");
    fs::write(&file, data).unwrap();
    assert_eq!(
        check_archive(&file).await.unwrap_err().reason(),
        ReplaceFailure::BadArchive
    );
}

#[tokio::test]
async fn accepts_an_archive_on_disk_that_stays_inside_and_refuses_one_that_is_not_an_archive() {
    let root = TempDir::new().unwrap();
    let good = root.path().join("good.tar.gz");
    fs::write(&good, archive(root.path(), VERSION, |_| {})).unwrap();
    check_archive(&good).await.unwrap();
    let junk = root.path().join("junk.tar.gz");
    fs::write(&junk, "not an archive at all").unwrap();
    assert_eq!(
        check_archive(&junk).await.unwrap_err().reason(),
        ReplaceFailure::BadArchive
    );
}

fn blocked(reason: ReplaceBlock) -> ReplaceAvailability {
    ReplaceAvailability::Blocked { reason, path: None }
}

#[tokio::test]
async fn allows_a_writable_folder_of_its_own() {
    let root = TempDir::new().unwrap();
    assert_eq!(
        can_replace_install(&installed(root.path())).await,
        ReplaceAvailability::Ok
    );
}

#[tokio::test]
async fn refuses_a_folder_under_a_system_path() {
    assert_eq!(
        can_replace_install(Path::new("/opt/ostia")).await,
        blocked(ReplaceBlock::SystemPath)
    );
    assert_eq!(
        can_replace_install(Path::new("/usr/lib/ostia")).await,
        blocked(ReplaceBlock::SystemPath)
    );
}

#[tokio::test]
async fn refuses_a_symlinked_app_folder() {
    let root = TempDir::new().unwrap();
    let real = installed(root.path());
    let link = root.path().join("link");
    symlink(&real, &link).unwrap();
    assert_eq!(
        can_replace_install(&link).await,
        blocked(ReplaceBlock::Symlink)
    );
}

#[tokio::test]
async fn names_a_leftover_new_or_old_folder() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    fs::create_dir(old_of(&app_dir)).unwrap();
    assert_eq!(
        can_replace_install(&app_dir).await,
        ReplaceAvailability::Blocked {
            reason: ReplaceBlock::Leftover,
            path: Some(old_of(&app_dir).to_string_lossy().into_owned()),
        }
    );
    fs::remove_dir_all(old_of(&app_dir)).unwrap();
    fs::create_dir(new_of(&app_dir)).unwrap();
    assert_eq!(
        can_replace_install(&app_dir).await,
        ReplaceAvailability::Blocked {
            reason: ReplaceBlock::Leftover,
            path: Some(new_of(&app_dir).to_string_lossy().into_owned()),
        }
    );
}

#[tokio::test]
async fn refuses_a_parent_folder_the_user_cannot_write() {
    if is_root() {
        return;
    }
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    let parent = app_dir.parent().unwrap();
    fs::set_permissions(parent, fs::Permissions::from_mode(0o555)).unwrap();
    let result = can_replace_install(&app_dir).await;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(result, blocked(ReplaceBlock::NotWritable));
}

#[tokio::test]
async fn refuses_a_missing_app_folder_as_not_writable() {
    let root = TempDir::new().unwrap();
    assert_eq!(
        can_replace_install(&root.path().join("gone")).await,
        blocked(ReplaceBlock::NotWritable)
    );
}

#[tokio::test]
async fn downloads_verifies_extracts_and_swaps_keeping_the_old_build_in_old() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    let server = FakeHttp::start().await;
    serve_release(&server, &archive(root.path(), VERSION, |_| {}), None);
    replace_from(&server, &app_dir).await.unwrap();
    assert_eq!(version_in(&app_dir), VERSION);
    assert_eq!(version_in(&old_of(&app_dir)), OLD);
    assert!(!new_of(&app_dir).exists());
    assert!(!download_of(&app_dir).exists());
}

#[tokio::test]
async fn leaves_the_install_untouched_on_a_checksum_mismatch() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    let server = FakeHttp::start().await;
    let data = archive(root.path(), VERSION, |_| {});
    serve_release(
        &server,
        &data,
        Some(format!(
            "{}  {}\n",
            "f".repeat(64),
            tarball_asset_name(VERSION)
        )),
    );
    assert_eq!(
        failure(replace_from(&server, &app_dir).await),
        ReplaceFailure::ChecksumMismatch
    );
    untouched(&app_dir);
}

#[tokio::test]
async fn refuses_a_release_without_a_checksum_line_for_the_archive() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    let server = FakeHttp::start().await;
    serve_release(
        &server,
        &archive(root.path(), VERSION, |_| {}),
        Some(format!("{}  other.deb\n", "0".repeat(64))),
    );
    assert_eq!(
        failure(replace_from(&server, &app_dir).await),
        ReplaceFailure::NoChecksum
    );
    assert_eq!(server.paths(), [asset_path("SHA256SUMS")]);
    untouched(&app_dir);
}

#[tokio::test]
async fn refuses_a_redirect_to_another_origin() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    let server = FakeHttp::start().await;
    serve_release(&server, &archive(root.path(), VERSION, |_| {}), None);
    server.route(
        &asset_path(&tarball_asset_name(VERSION)),
        Reply::Redirect("http://127.0.0.2:9/elsewhere".to_owned()),
    );
    assert_eq!(
        failure(replace_from(&server, &app_dir).await),
        ReplaceFailure::RedirectRefused
    );
    untouched(&app_dir);
}

#[tokio::test]
async fn follows_a_redirect_on_the_same_origin() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    let server = FakeHttp::start().await;
    let data = archive(root.path(), VERSION, |_| {});
    server.route(
        &asset_path("SHA256SUMS"),
        Reply::ok(format!(
            "{}  {}\n",
            sha256_hex(&data),
            tarball_asset_name(VERSION)
        )),
    );
    server.route(
        &asset_path(&tarball_asset_name(VERSION)),
        Reply::Redirect("/blob".to_owned()),
    );
    server.route("/blob", Reply::ok(data));
    replace_from(&server, &app_dir).await.unwrap();
    assert_eq!(version_in(&app_dir), VERSION);
}

#[tokio::test]
async fn refuses_an_archive_holding_another_version_and_cleans_the_staged_folder() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    let server = FakeHttp::start().await;
    let data = archive(root.path(), VERSION, |top| app_folder(top, "9.9.8"));
    serve_release(&server, &data, None);
    assert_eq!(
        failure(replace_from(&server, &app_dir).await),
        ReplaceFailure::WrongVersion
    );
    untouched(&app_dir);
}

#[tokio::test]
async fn an_archive_with_another_version_is_cleaned_up_app_asar_included_and_the_app_folder_is_left_as_it_was()
 {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    let server = FakeHttp::start().await;
    let data = archive(root.path(), VERSION, |top| {
        app_folder(top, "9.9.8");
        write(&top.join("resources").join("app.asar"), "asar");
    });
    serve_release(&server, &data, None);
    assert_eq!(
        failure(replace_from(&server, &app_dir).await),
        ReplaceFailure::WrongVersion
    );
    assert!(!new_of(&app_dir).exists());
    assert!(!download_of(&app_dir).exists());
    untouched(&app_dir);
}

#[tokio::test]
async fn refuses_an_archive_whose_app_binary_is_not_executable() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    let server = FakeHttp::start().await;
    let data = archive(root.path(), VERSION, |top| {
        fs::set_permissions(top.join("ostia"), fs::Permissions::from_mode(0o644)).unwrap();
    });
    serve_release(&server, &data, None);
    assert_eq!(
        failure(replace_from(&server, &app_dir).await),
        ReplaceFailure::NotExecutable
    );
    untouched(&app_dir);
}

#[tokio::test]
async fn refuses_an_archive_with_an_escaping_symlink_before_extracting_anything() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    let server = FakeHttp::start().await;
    let data = archive(root.path(), VERSION, |top| {
        symlink("/etc", top.join("etc")).unwrap();
    });
    serve_release(&server, &data, None);
    assert_eq!(
        failure(replace_from(&server, &app_dir).await),
        ReplaceFailure::BadArchive
    );
    untouched(&app_dir);
}

#[tokio::test]
async fn reports_an_http_error_and_keeps_the_install() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    let server = FakeHttp::start().await;
    server.route(&asset_path("SHA256SUMS"), Reply::Status(500));
    assert_eq!(
        failure(replace_from(&server, &app_dir).await),
        ReplaceFailure::HttpError
    );
    untouched(&app_dir);
}

#[tokio::test]
async fn does_not_start_while_a_leftover_folder_is_in_the_way() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    fs::create_dir(old_of(&app_dir)).unwrap();
    let server = FakeHttp::start().await;
    serve_release(&server, &archive(root.path(), VERSION, |_| {}), None);
    assert_eq!(
        failure(replace_from(&server, &app_dir).await),
        ReplaceFailure::Blocked
    );
    assert!(server.paths().is_empty());
}

#[tokio::test]
async fn refuses_a_checksum_file_over_the_size_cap_and_keeps_the_install() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    let server = FakeHttp::start().await;
    server.route(
        &asset_path("SHA256SUMS"),
        Reply::ok(vec![b'x'; 64 * 1024 + 1]),
    );
    assert_eq!(
        failure(replace_from(&server, &app_dir).await),
        ReplaceFailure::TooLarge
    );
    untouched(&app_dir);
}

#[tokio::test]
async fn reports_offline_when_the_server_cannot_be_reached() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    let server = FakeHttp::start().await;
    let base = server.url.clone();
    server.close().await;
    assert_eq!(
        failure(replace_install(options(&app_dir, &base)).await),
        ReplaceFailure::Offline
    );
    untouched(&app_dir);
}

#[tokio::test]
async fn gives_up_when_the_server_never_answers_within_the_timeout() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    let server = FakeHttp::start().await;
    server.route(&asset_path("SHA256SUMS"), Reply::Hang);
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        replace_install(ReplaceInstallOptions {
            timeout: Duration::from_millis(200),
            ..options(&app_dir, &server.url)
        }),
    )
    .await
    .expect("the replace must end by its own deadline");
    assert_eq!(failure(result), ReplaceFailure::Offline);
    untouched(&app_dir);
}

#[tokio::test]
async fn moves_the_app_to_old_first_then_new_into_place() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    app_folder(&new_of(&app_dir), VERSION);
    swap_install(&app_dir).await.unwrap();
    assert_eq!(version_in(&app_dir), VERSION);
    assert_eq!(version_in(&old_of(&app_dir)), OLD);
}

#[tokio::test]
async fn puts_the_old_app_back_when_the_new_folder_cannot_be_moved_in() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    assert_eq!(
        swap_install(&app_dir).await.unwrap_err().reason(),
        ReplaceFailure::SwapFailed
    );
    assert_eq!(version_in(&app_dir), OLD);
    assert!(!old_of(&app_dir).exists());
}

#[tokio::test]
async fn deletes_old_only_once_the_version_that_replaced_it_is_running() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    app_folder(&old_of(&app_dir), OLD);
    let pending = PendingSweep {
        app_dir: app_dir.clone(),
        version: VERSION.to_owned(),
    };
    assert!(
        !sweep_old_install(Some(&pending), Some(&app_dir), OLD)
            .await
            .unwrap()
    );
    assert!(old_of(&app_dir).exists());
    assert!(
        !sweep_old_install(Some(&pending), Some(&root.path().join("other")), VERSION)
            .await
            .unwrap()
    );
    assert!(
        !sweep_old_install(None, Some(&app_dir), VERSION)
            .await
            .unwrap()
    );
    assert!(
        !sweep_old_install(Some(&pending), None, VERSION)
            .await
            .unwrap()
    );
    assert!(
        sweep_old_install(
            Some(&pending),
            Some(&app_dir),
            &format!("{VERSION}+sha.abc")
        )
        .await
        .unwrap()
    );
    assert!(!old_of(&app_dir).exists());
}

fn release_for(version: &str) -> ReleaseInfo {
    ReleaseInfo {
        version: version.to_owned(),
        url: String::new(),
        dmg_sha256: None,
    }
}

struct Replacing {
    replacer: InstallReplacer,
    states: Arc<Mutex<Vec<ReplaceState>>>,
    replaced: Arc<Mutex<Vec<PendingSweep>>>,
}

fn replacing(app_dir: Option<PathBuf>, base: &str) -> Replacing {
    let states: Arc<Mutex<Vec<ReplaceState>>> = Arc::default();
    let replaced: Arc<Mutex<Vec<PendingSweep>>> = Arc::default();
    let replacer = InstallReplacer::new(InstallReplacerDeps {
        app_dir: Box::new(move || app_dir.clone()),
        replace: tarball_replace(TarballReplace {
            base: base.to_owned(),
            tar: tar_runner(),
        }),
        on_state: Box::new({
            let states = Arc::clone(&states);
            move |state| states.lock().unwrap().push(state.clone())
        }),
        on_progress: Box::new(|_| {}),
        on_replaced: Box::new({
            let replaced = Arc::clone(&replaced);
            move |pending| replaced.lock().unwrap().push(pending.clone())
        }),
    });
    Replacing {
        replacer,
        states,
        replaced,
    }
}

#[tokio::test]
async fn runs_one_replace_at_a_time_and_reports_done_with_the_version_it_installed() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    let server = FakeHttp::start().await;
    serve_release(&server, &archive(root.path(), VERSION, |_| {}), None);
    let r = replacing(Some(app_dir.clone()), &server.url);

    assert_eq!(
        r.replacer.start(release_for(VERSION)),
        ReplaceStart::Started
    );
    assert_eq!(r.replacer.start(release_for(VERSION)), ReplaceStart::Busy);
    eventually("the replace to finish", || {
        matches!(r.replacer.state(), ReplaceState::Done { .. })
    })
    .await;

    assert_eq!(
        *r.states.lock().unwrap(),
        [
            ReplaceState::Downloading,
            ReplaceState::Installing,
            ReplaceState::Done {
                version: VERSION.to_owned()
            }
        ]
    );
    assert_eq!(
        *r.replaced.lock().unwrap(),
        [PendingSweep {
            app_dir,
            version: VERSION.to_owned()
        }]
    );
}

fn panicking_replace(_job: ReplaceJob) -> ReplaceFuture {
    Box::pin(async {
        let outcome: Result<(), ReplaceError> = Err(ReplaceError::new(ReplaceFailure::Blocked));
        assert!(outcome.is_ok(), "replace exploded");
        outcome
    })
}

#[tokio::test]
async fn reports_a_failed_replace_and_allows_a_new_one_when_the_replace_panics() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    let states: Arc<Mutex<Vec<ReplaceState>>> = Arc::default();
    let replacer = InstallReplacer::new(InstallReplacerDeps {
        app_dir: Box::new(move || Some(app_dir.clone())),
        replace: Arc::new(panicking_replace),
        on_state: Box::new({
            let states = Arc::clone(&states);
            move |state| states.lock().unwrap().push(state.clone())
        }),
        on_progress: Box::new(|_| {}),
        on_replaced: Box::new(|_| {}),
    });
    assert_eq!(replacer.start(release_for(VERSION)), ReplaceStart::Started);
    eventually("the replace to fail", || {
        matches!(replacer.state(), ReplaceState::Failed { .. })
    })
    .await;
    assert_eq!(
        replacer.state(),
        ReplaceState::Failed {
            reason: ReplaceFailure::ExtractFailed
        }
    );
    assert_eq!(replacer.start(release_for(VERSION)), ReplaceStart::Started);
}

#[tokio::test]
async fn does_nothing_without_a_replaceable_app_folder() {
    let r = replacing(None, "https://github.com");
    assert_eq!(
        r.replacer.start(release_for(VERSION)),
        ReplaceStart::NoAction
    );
    assert_eq!(r.replacer.state(), ReplaceState::Idle);
    assert!(r.states.lock().unwrap().is_empty());
}

#[tokio::test]
async fn reports_the_reason_of_a_failed_replace_and_allows_a_new_one() {
    let root = TempDir::new().unwrap();
    let app_dir = installed(root.path());
    let server = FakeHttp::start().await;
    server.route(&asset_path("SHA256SUMS"), Reply::Status(500));
    let r = replacing(Some(app_dir.clone()), &server.url);

    assert_eq!(
        r.replacer.start(release_for(VERSION)),
        ReplaceStart::Started
    );
    eventually("the replace to fail", || {
        matches!(r.replacer.state(), ReplaceState::Failed { .. })
    })
    .await;
    assert_eq!(
        r.replacer.state(),
        ReplaceState::Failed {
            reason: ReplaceFailure::HttpError
        }
    );
    assert!(r.replaced.lock().unwrap().is_empty());
    assert_eq!(
        r.replacer.start(release_for(VERSION)),
        ReplaceStart::Started
    );
}
