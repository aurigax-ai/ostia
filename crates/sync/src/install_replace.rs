use std::fmt;
use std::fs::File;
use std::future::Future;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use flate2::read::GzDecoder;
use ostia_base::PRODUCT_NAME;
use ostia_base::checked_download::{
    DownloadError, DownloadFailure, DownloadRequest, DownloadTarget, download_checked,
    follow_allowed, is_allowed_hop,
};
use ostia_base::host::Host;
use ostia_base::js::{JS_DOT, is_js_space, static_regex};
use ostia_base::json_store::load_json;
use ostia_base::path_guard::is_inside_path;
use ostia_contract::build_info::{parse_build_info, release_version};
use ostia_contract::install_method::{
    ReplaceAvailability, ReplaceBlock, ReplaceFailure, ReplaceProgress, ReplaceStart, ReplaceState,
    UPDATE_DOWNLOAD_HOSTS,
};
use ostia_contract::releases::{
    RELEASE_NAME, RELEASE_OWNER, ReleaseInfo, parse_version, tarball_asset_name,
};
use parking_lot::Mutex;
use regex::Regex;
use rustix::fs::{Access, access};
use serde::Serialize;
use tokio::process::Command;
use tokio::time::Instant;
use url::Url;

use crate::install_cleanup::remove_tree_force;
use crate::install_method::dirname;

pub const UPDATE_ARCHIVE_MAX_BYTES: u64 = 1024 * 1024 * 1024;
pub const CHECKSUMS_MAX_BYTES: u64 = 64 * 1024;
pub const CHECKSUMS_FILE: &str = "SHA256SUMS";
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const EXTRACT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const RELEASE_DOWNLOAD_BASE_URL: &str = "https://github.com";
const PROGRESS_STEP_BYTES: u64 = 1024 * 1024;
const SYSTEM_PARENTS: [&str; 2] = ["/opt", "/usr"];

static CHECKSUM_LINE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(&format!(r"^([0-9a-f]{{64}}) [ *]({JS_DOT}+)$")));

#[derive(Debug)]
pub struct ReplaceError {
    reason: ReplaceFailure,
}

impl ReplaceError {
    pub fn new(reason: ReplaceFailure) -> Self {
        Self { reason }
    }

    pub fn reason(&self) -> ReplaceFailure {
        self.reason
    }
}

impl From<ReplaceFailure> for ReplaceError {
    fn from(reason: ReplaceFailure) -> Self {
        Self::new(reason)
    }
}

impl fmt::Display for ReplaceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.reason.as_str())
    }
}

impl std::error::Error for ReplaceError {}

pub type ProgressFn = Arc<dyn Fn(ReplaceProgress) + Send + Sync>;
pub type InstallingFn = Arc<dyn Fn() + Send + Sync>;
pub type ReplaceFuture = Pin<Box<dyn Future<Output = Result<(), ReplaceError>> + Send>>;
pub type RunTar = Arc<dyn Fn(Vec<String>) -> ReplaceFuture + Send + Sync>;
pub type ReplaceFn = Arc<dyn Fn(ReplaceJob) -> ReplaceFuture + Send + Sync>;

pub(crate) fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn download_path(app_dir: &Path) -> PathBuf {
    suffixed(app_dir, ".download")
}

fn new_path(app_dir: &Path) -> PathBuf {
    suffixed(app_dir, ".new")
}

fn old_path(app_dir: &Path) -> PathBuf {
    suffixed(app_dir, ".old")
}

pub fn release_download_base(is_packaged: bool, host: &Host) -> String {
    let overridden = if is_packaged {
        None
    } else {
        host.app_var("RELEASE_DOWNLOAD_BASE_URL")
    };
    overridden.unwrap_or(RELEASE_DOWNLOAD_BASE_URL).to_owned()
}

fn is_asset_name(asset: &str) -> bool {
    !asset.is_empty()
        && asset
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

pub(crate) fn try_release_asset_url(
    base: &str,
    version: &str,
    asset: &str,
) -> Result<Option<Url>, url::ParseError> {
    if parse_version(version).is_none() || version.contains('+') || !is_asset_name(asset) {
        return Ok(None);
    }
    Url::parse(&format!(
        "{}/{RELEASE_OWNER}/{RELEASE_NAME}/releases/download/v{version}/{asset}",
        base.trim_end_matches('/')
    ))
    .map(Some)
}

pub fn release_asset_url(base: &str, version: &str, asset: &str) -> Option<Url> {
    try_release_asset_url(base, version, asset).ok().flatten()
}

pub fn allowed_hop(url: &str, base: &str) -> bool {
    is_allowed_hop(
        url,
        UPDATE_DOWNLOAD_HOSTS,
        (base != RELEASE_DOWNLOAD_BASE_URL).then_some(base),
    )
}

pub fn checksum_for(sums: &str, asset: &str) -> Option<String> {
    sums.split('\n').find_map(|line| {
        let captures = CHECKSUM_LINE.captures(line.trim_end_matches(is_js_space))?;
        if captures.get(2)?.as_str() != asset {
            return None;
        }
        Some(captures.get(1)?.as_str().to_owned())
    })
}

fn blocked(reason: ReplaceBlock) -> ReplaceAvailability {
    ReplaceAvailability::Blocked { reason, path: None }
}

async fn writable(path: &Path) -> bool {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || access(path.as_path(), Access::WRITE_OK).is_ok())
        .await
        .unwrap_or(false)
}

pub async fn replaceable_at(target: &Path, leftovers: &[PathBuf]) -> ReplaceAvailability {
    match tokio::fs::symlink_metadata(target).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return blocked(ReplaceBlock::Symlink);
        }
        Ok(_) => {}
        Err(_) => return blocked(ReplaceBlock::NotWritable),
    }
    for leftover in leftovers {
        if tokio::fs::symlink_metadata(leftover).await.is_ok() {
            return ReplaceAvailability::Blocked {
                reason: ReplaceBlock::Leftover,
                path: Some(leftover.to_string_lossy().into_owned()),
            };
        }
    }
    if !writable(target).await || !writable(&dirname(target)).await {
        return blocked(ReplaceBlock::NotWritable);
    }
    ReplaceAvailability::Ok
}

pub async fn can_replace_install(app_dir: &Path) -> ReplaceAvailability {
    let parent = dirname(app_dir);
    if SYSTEM_PARENTS
        .iter()
        .any(|dir| is_inside_path(Path::new(dir), &parent))
    {
        return blocked(ReplaceBlock::SystemPath);
    }
    replaceable_at(app_dir, &[new_path(app_dir), old_path(app_dir)]).await
}

fn stripped_entry(path: &str) -> Option<String> {
    let parts: Vec<&str> = path
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();
    (parts.len() > 1).then(|| parts[1..].join("/"))
}

fn leaves_root(segments: &[&str]) -> bool {
    let mut depth: i64 = 0;
    for segment in segments {
        if segment.is_empty() || *segment == "." {
            continue;
        }
        depth += if *segment == ".." { -1 } else { 1 };
        if depth < 0 {
            return true;
        }
    }
    depth == 0
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArchiveEntryKind {
    File,
    Directory,
    SymbolicLink,
    Link,
    CharacterDevice,
    Other,
}

#[derive(Clone, Copy, Debug)]
pub struct ArchiveEntry<'a> {
    pub path: &'a str,
    pub kind: ArchiveEntryKind,
    pub linkpath: Option<&'a str>,
}

pub fn entry_problem(entry: &ArchiveEntry<'_>) -> bool {
    if !matches!(
        entry.kind,
        ArchiveEntryKind::File
            | ArchiveEntryKind::Directory
            | ArchiveEntryKind::SymbolicLink
            | ArchiveEntryKind::Link
    ) {
        return true;
    }
    let path = entry.path;
    if path.starts_with('/') || path.contains('\\') || path.contains('\0') {
        return true;
    }
    if path.split('/').any(|part| part == "..") {
        return true;
    }
    let inside = stripped_entry(path);
    let linkpath = ostia_base::js::non_empty(entry.linkpath);
    match entry.kind {
        ArchiveEntryKind::SymbolicLink => {
            let (Some(linkpath), Some(inside)) = (linkpath, inside) else {
                return true;
            };
            if linkpath.starts_with('/') || linkpath.contains('\0') {
                return true;
            }
            let mut segments: Vec<&str> = inside.split('/').collect();
            segments.pop();
            segments.extend(linkpath.split('/'));
            leaves_root(&segments)
        }
        ArchiveEntryKind::Link => {
            let Some(linkpath) = linkpath else {
                return true;
            };
            if linkpath.starts_with('/') || linkpath.split('/').any(|part| part == "..") {
                return true;
            }
            stripped_entry(linkpath).is_none()
        }
        _ => false,
    }
}

fn kind_of(entry_type: tar::EntryType) -> ArchiveEntryKind {
    if entry_type.is_file() || entry_type.is_contiguous() {
        ArchiveEntryKind::File
    } else if entry_type.is_dir() {
        ArchiveEntryKind::Directory
    } else if entry_type.is_symlink() {
        ArchiveEntryKind::SymbolicLink
    } else if entry_type.is_hard_link() {
        ArchiveEntryKind::Link
    } else if entry_type.is_character_special() {
        ArchiveEntryKind::CharacterDevice
    } else {
        ArchiveEntryKind::Other
    }
}

fn scan_archive(file: &Path) -> Result<(), ReplaceError> {
    let bad = || ReplaceError::new(ReplaceFailure::BadArchive);
    let file = File::open(file).map_err(|_| bad())?;
    let mut archive = tar::Archive::new(GzDecoder::new(file));
    for entry in archive.entries().map_err(|_| bad())? {
        let entry = entry.map_err(|_| bad())?;
        let path = String::from_utf8_lossy(&entry.path_bytes()).into_owned();
        let linkpath = entry
            .link_name_bytes()
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
        let problem = entry_problem(&ArchiveEntry {
            path: &path,
            kind: kind_of(entry.header().entry_type()),
            linkpath: linkpath.as_deref(),
        });
        if problem {
            return Err(bad());
        }
    }
    Ok(())
}

pub async fn check_archive(file: &Path) -> Result<(), ReplaceError> {
    let file = file.to_path_buf();
    tokio::task::spawn_blocking(move || scan_archive(&file))
        .await
        .unwrap_or_else(|_| Err(ReplaceError::new(ReplaceFailure::BadArchive)))
}

async fn check_extracted(dir: &Path, version: &str) -> Result<(), ReplaceError> {
    let not_executable = || ReplaceError::new(ReplaceFailure::NotExecutable);
    let binary = tokio::fs::metadata(dir.join(PRODUCT_NAME))
        .await
        .map_err(|_| not_executable())?;
    if !binary.is_file() || binary.permissions().mode() & 0o111 == 0 {
        return Err(not_executable());
    }
    let info = load_json(&dir.join("resources").join("build-info.json"))
        .and_then(|raw| parse_build_info(&raw));
    match info {
        Some(info) if release_version(&info.version) == version => Ok(()),
        _ => Err(ReplaceError::new(ReplaceFailure::WrongVersion)),
    }
}

pub(crate) fn replace_failure(error: &DownloadError) -> ReplaceError {
    ReplaceError::new(match error.reason() {
        Some(DownloadFailure::HostNotAllowed | DownloadFailure::RedirectRefused) => {
            ReplaceFailure::RedirectRefused
        }
        Some(DownloadFailure::HttpError) => ReplaceFailure::HttpError,
        Some(DownloadFailure::TooLarge) => ReplaceFailure::TooLarge,
        None => ReplaceFailure::Offline,
    })
}

fn release_request(url: &Url, base: &str) -> DownloadRequest {
    let base = base.to_owned();
    DownloadRequest {
        url: url.to_string(),
        allowed: Arc::new(move |hop: &str| allowed_hop(hop, &base)),
        user_agent: PRODUCT_NAME.to_owned(),
    }
}

pub(crate) async fn within<T>(
    deadline: Instant,
    future: impl Future<Output = Result<T, ReplaceError>>,
) -> Result<T, ReplaceError> {
    tokio::time::timeout_at(deadline, future)
        .await
        .unwrap_or_else(|_| Err(ReplaceError::new(ReplaceFailure::Offline)))
}

pub(crate) async fn fetch_text(
    url: &Url,
    base: &str,
    max_bytes: u64,
    deadline: Instant,
) -> Result<String, ReplaceError> {
    within(deadline, async {
        let response = follow_allowed(&release_request(url, base))
            .await
            .map_err(|error| replace_failure(&error))?;
        response
            .read_capped(max_bytes)
            .await
            .ok_or_else(|| ReplaceError::new(ReplaceFailure::TooLarge))
    })
    .await
}

pub(crate) struct DownloadJob<'a> {
    pub url: &'a Url,
    pub base: &'a str,
    pub file: PathBuf,
    pub max_bytes: u64,
    pub deadline: Instant,
    pub on_progress: ProgressFn,
}

pub(crate) async fn download_to(job: DownloadJob<'_>) -> Result<String, ReplaceError> {
    let reported = AtomicU64::new(0);
    let on_progress = job.on_progress;
    let target = DownloadTarget {
        file: job.file,
        exclusive: true,
        max_bytes: job.max_bytes,
        on_progress: Arc::new(move |received: u64, total: u64| {
            if received - reported.load(Ordering::SeqCst) < PROGRESS_STEP_BYTES && received != total
            {
                return;
            }
            reported.store(received, Ordering::SeqCst);
            on_progress(ReplaceProgress { received, total });
        }),
    };
    let request = release_request(job.url, job.base);
    within(job.deadline, async {
        download_checked(&request, &target)
            .await
            .map_err(|error| replace_failure(&error))
    })
    .await
}

pub async fn run_tar(args: Vec<String>) -> Result<(), ReplaceError> {
    let mut command = Command::new("tar");
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    match tokio::time::timeout(EXTRACT_TIMEOUT, command.status()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        _ => Err(ReplaceError::new(ReplaceFailure::ExtractFailed)),
    }
}

pub async fn swap_install(app_dir: &Path) -> Result<(), ReplaceError> {
    let swap_failed = || ReplaceError::new(ReplaceFailure::SwapFailed);
    if tokio::fs::rename(app_dir, old_path(app_dir)).await.is_err() {
        return Err(swap_failed());
    }
    if tokio::fs::rename(new_path(app_dir), app_dir).await.is_err() {
        let _ = tokio::fs::rename(old_path(app_dir), app_dir).await;
        return Err(swap_failed());
    }
    Ok(())
}

async fn remove_file_force(path: &Path) -> io::Result<()> {
    match tokio::fs::remove_file(path).await {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

pub struct ReplaceInstallOptions {
    pub app_dir: PathBuf,
    pub version: String,
    pub base: String,
    pub tar: RunTar,
    pub timeout: Duration,
    pub on_progress: ProgressFn,
    pub on_installing: InstallingFn,
}

pub fn replace_install(
    options: ReplaceInstallOptions,
) -> impl Future<Output = Result<(), ReplaceError>> + Send {
    let deadline = Instant::now() + options.timeout;
    replace_install_until(options, deadline)
}

async fn replace_install_until(
    options: ReplaceInstallOptions,
    deadline: Instant,
) -> Result<(), ReplaceError> {
    let extract_failed = || ReplaceError::new(ReplaceFailure::ExtractFailed);
    let ReplaceInstallOptions {
        app_dir,
        version,
        base,
        tar,
        on_progress,
        on_installing,
        ..
    } = options;
    let asset = tarball_asset_name(&version);
    let archive_url =
        try_release_asset_url(&base, &version, &asset).map_err(|_| extract_failed())?;
    let sums_url =
        try_release_asset_url(&base, &version, CHECKSUMS_FILE).map_err(|_| extract_failed())?;
    let (Some(archive_url), Some(sums_url)) = (archive_url, sums_url) else {
        return Err(ReplaceError::new(ReplaceFailure::HttpError));
    };
    if can_replace_install(&app_dir).await != ReplaceAvailability::Ok {
        return Err(ReplaceError::new(ReplaceFailure::Blocked));
    }
    let file = download_path(&app_dir);
    let staged = new_path(&app_dir);
    remove_file_force(&file)
        .await
        .map_err(|_| extract_failed())?;
    let outcome = async {
        let sums = fetch_text(&sums_url, &base, CHECKSUMS_MAX_BYTES, deadline).await?;
        let expected = checksum_for(&sums, &asset)
            .ok_or_else(|| ReplaceError::new(ReplaceFailure::NoChecksum))?;
        let actual = download_to(DownloadJob {
            url: &archive_url,
            base: &base,
            file: file.clone(),
            max_bytes: UPDATE_ARCHIVE_MAX_BYTES,
            deadline,
            on_progress,
        })
        .await?;
        if actual != expected {
            return Err(ReplaceError::new(ReplaceFailure::ChecksumMismatch));
        }
        on_installing();
        check_archive(&file).await?;
        let mut folder = tokio::fs::DirBuilder::new();
        folder.mode(0o755);
        folder.create(&staged).await.map_err(|_| extract_failed())?;
        tar(vec![
            "-xzf".to_owned(),
            file.to_string_lossy().into_owned(),
            "--strip-components=1".to_owned(),
            "-C".to_owned(),
            staged.to_string_lossy().into_owned(),
        ])
        .await?;
        check_extracted(&staged, &version).await?;
        swap_install(&app_dir).await
    }
    .await;
    let outcome = match outcome {
        Ok(()) => Ok(()),
        Err(error) => match remove_tree_force(&staged).await {
            Ok(()) => Err(error),
            Err(_) => Err(extract_failed()),
        },
    };
    remove_file_force(&file)
        .await
        .map_err(|_| extract_failed())?;
    outcome
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSweep {
    pub app_dir: PathBuf,
    pub version: String,
}

pub async fn sweep_old_install(
    pending: Option<&PendingSweep>,
    app_dir: Option<&Path>,
    running_version: &str,
) -> io::Result<bool> {
    let (Some(pending), Some(app_dir)) = (pending, app_dir) else {
        return Ok(false);
    };
    if pending.app_dir.as_os_str() != app_dir.as_os_str() {
        return Ok(false);
    }
    if release_version(running_version) != pending.version {
        return Ok(false);
    }
    remove_tree_force(&old_path(app_dir)).await?;
    Ok(true)
}

pub struct ReplaceJob {
    pub app_dir: PathBuf,
    pub release: ReleaseInfo,
    pub timeout: Duration,
    pub on_progress: ProgressFn,
    pub on_installing: InstallingFn,
}

pub struct TarballReplace {
    pub base: String,
    pub tar: RunTar,
}

pub fn tarball_replace(deps: TarballReplace) -> ReplaceFn {
    Arc::new(move |job: ReplaceJob| {
        Box::pin(replace_install(ReplaceInstallOptions {
            app_dir: job.app_dir,
            version: job.release.version,
            base: deps.base.clone(),
            tar: Arc::clone(&deps.tar),
            timeout: job.timeout,
            on_progress: job.on_progress,
            on_installing: job.on_installing,
        }))
    })
}

pub struct InstallReplacerDeps {
    pub app_dir: Box<dyn Fn() -> Option<PathBuf> + Send + Sync>,
    pub replace: ReplaceFn,
    pub on_state: Box<dyn Fn(&ReplaceState) + Send + Sync>,
    pub on_progress: Box<dyn Fn(ReplaceProgress) + Send + Sync>,
    pub on_replaced: Box<dyn Fn(&PendingSweep) + Send + Sync>,
}

struct ReplacerShared {
    deps: InstallReplacerDeps,
    state: Mutex<ReplaceState>,
}

impl ReplacerShared {
    fn set(&self, next: ReplaceState) {
        *self.state.lock() = next.clone();
        (self.deps.on_state)(&next);
    }
}

#[derive(Clone)]
pub struct InstallReplacer {
    shared: Arc<ReplacerShared>,
}

impl InstallReplacer {
    pub fn new(deps: InstallReplacerDeps) -> Self {
        Self {
            shared: Arc::new(ReplacerShared {
                deps,
                state: Mutex::new(ReplaceState::Idle),
            }),
        }
    }

    pub fn state(&self) -> ReplaceState {
        self.shared.state.lock().clone()
    }

    pub fn start(&self, release: ReleaseInfo) -> ReplaceStart {
        let shared = &self.shared;
        let Some(app_dir) = (shared.deps.app_dir)() else {
            return ReplaceStart::NoAction;
        };
        {
            let mut state = shared.state.lock();
            if matches!(*state, ReplaceState::Downloading | ReplaceState::Installing) {
                return ReplaceStart::Busy;
            }
            *state = ReplaceState::Downloading;
        }
        (shared.deps.on_state)(&ReplaceState::Downloading);
        let version = release.version.clone();
        let replace = (shared.deps.replace)(ReplaceJob {
            app_dir: app_dir.clone(),
            release,
            timeout: UPDATE_DOWNLOAD_TIMEOUT,
            on_progress: Arc::new({
                let shared = Arc::clone(shared);
                move |progress: ReplaceProgress| (shared.deps.on_progress)(progress)
            }),
            on_installing: Arc::new({
                let shared = Arc::clone(shared);
                move || shared.set(ReplaceState::Installing)
            }),
        });
        let shared = Arc::clone(shared);
        tokio::spawn(async move {
            match replace.await {
                Ok(()) => {
                    (shared.deps.on_replaced)(&PendingSweep {
                        app_dir,
                        version: version.clone(),
                    });
                    shared.set(ReplaceState::Done { version });
                }
                Err(error) => shared.set(ReplaceState::Failed {
                    reason: error.reason(),
                }),
            }
        });
        ReplaceStart::Started
    }
}
