use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use flate2::read::MultiGzDecoder;
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use ostia_base::checked_download::{
    DownloadError, DownloadFailure, DownloadRequest, DownloadTarget, download_checked,
    is_allowed_hop,
};
use ostia_base::js::{is_js_space, js_trim, non_empty};
use ostia_base::node_path;
use ostia_base::path_guard::is_inside_path;
use ostia_contract::app_env::{EnvSource, read_env};
use ostia_contract::language_servers::{
    LANGUAGE_SERVER_DOWNLOAD_HOSTS, LanguageServerArchive, LanguageServerAsset,
    LanguageServerFetchFailure, LanguageServerGoInstall, LanguageServerPlatform, LanguageServerRun,
    go_install_args, pinned_version,
};
use ostia_diagnostics::app_log::redact_secrets;
use parking_lot::Mutex;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use url::Url;
use uuid::Uuid;
use zip::{HasZipMetadata, ZipArchive};

use crate::server_binaries::{FetchError, FetchHooks, ManagedServerFiles, ProgramFinder};

pub const DOWNLOAD_BASE_URL_ENV: &str = "LSP_DOWNLOAD_BASE_URL";
const DOWNLOAD_MAX_BYTES: u64 = 256 * 1024 * 1024;
const EXTRACT_MAX_BYTES: u64 = 1024 * 1024 * 1024;
const EXTRACT_MAX_FILES: usize = 20_000;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const GO_INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const GO_OUTPUT_MAX_BYTES: usize = 1024 * 1024;
const OUTPUT_LINE_MAX: usize = 500;
const SYMLINK_TYPE: u32 = 0o120_000;
const FILE_TYPE_MASK: u32 = 0o170_000;
const COPY_CHUNK: usize = 64 * 1024;
const TAR_META_MAX_BYTES: u64 = 1024 * 1024;
const GO_PROGRAM: &str = "go";

pub type EnvSnapshot = Arc<dyn Fn() -> BTreeMap<String, String> + Send + Sync>;

type Pending = Shared<BoxFuture<'static, Result<String, FetchError>>>;

pub fn download_base_url(is_packaged: bool, env: &EnvSource) -> Option<String> {
    if is_packaged {
        None
    } else {
        read_env(DOWNLOAD_BASE_URL_ENV, env)
    }
}

#[derive(Clone)]
pub struct ManagedServersDeps {
    pub dir: PathBuf,
    pub user_agent: String,
    pub find_program: ProgramFinder,
    pub env: EnvSnapshot,
    pub platform: Option<String>,
    pub base_url: Option<String>,
    pub max_download_bytes: Option<u64>,
    pub max_extract_bytes: Option<u64>,
    pub max_extract_files: Option<usize>,
    pub download_timeout: Option<Duration>,
    pub go_timeout: Option<Duration>,
}

#[derive(Clone)]
pub struct ManagedServers {
    deps: Arc<ManagedServersDeps>,
    running: Arc<Mutex<HashMap<String, Pending>>>,
}

fn failed(reason: LanguageServerFetchFailure, detail: &str) -> FetchError {
    FetchError {
        reason: Some(reason),
        detail: (!detail.is_empty()).then(|| detail.to_owned()),
    }
}

fn clip(text: &str) -> String {
    let redacted = redact_secrets(text);
    let mut units = 0;
    let mut out = String::new();
    for ch in redacted.chars() {
        units += ch.len_utf16();
        if units > OUTPUT_LINE_MAX {
            break;
        }
        out.push(ch);
    }
    out
}

fn bad_archive(detail: &str) -> FetchError {
    failed(LanguageServerFetchFailure::BadArchive, detail)
}

fn bad_archive_from(error: &impl std::fmt::Display) -> FetchError {
    bad_archive(&clip(&error.to_string()))
}

fn write_failed(error: &impl std::fmt::Display) -> FetchError {
    failed(
        LanguageServerFetchFailure::WriteFailed,
        &clip(&error.to_string()),
    )
}

fn offline(error: &impl std::fmt::Display) -> FetchError {
    failed(
        LanguageServerFetchFailure::Offline,
        &clip(&error.to_string()),
    )
}

fn make_private_dir(path: &Path) -> io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}

fn remove_any(path: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn discard(path: &Path) {
    if let Err(error) = remove_any(path) {
        tracing::warn!(path = %path.display(), %error, "could not remove a managed server path");
    }
}

fn children(dir: &Path) -> Vec<String> {
    match fs::read_dir(dir) {
        Ok(read) => read
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn host_platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

fn entry_target(stage: &Path, name: &str) -> Result<PathBuf, FetchError> {
    if name.contains('\0') || name.contains('\\') || name.starts_with('/') {
        return Err(bad_archive("an entry has an unsafe name"));
    }
    let segments: Vec<&str> = name
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect();
    if segments.contains(&"..") {
        return Err(bad_archive("an entry leaves the folder"));
    }
    let target = segments
        .iter()
        .fold(stage.to_path_buf(), |path, segment| path.join(segment));
    if !is_inside_path(stage, &target) {
        return Err(bad_archive("an entry leaves the folder"));
    }
    Ok(target)
}

struct Budget {
    bytes: u64,
    files: usize,
    max_bytes: u64,
    max_files: usize,
}

impl Budget {
    fn with_limits(max_bytes: u64, max_files: usize) -> Self {
        Self {
            bytes: 0,
            files: 0,
            max_bytes,
            max_files,
        }
    }

    fn file(&mut self, size: u64) -> Result<(), FetchError> {
        self.files += 1;
        self.add(size)?;
        if self.files > self.max_files {
            return Err(failed(
                LanguageServerFetchFailure::TooLarge,
                "too many files",
            ));
        }
        Ok(())
    }

    fn add(&mut self, size: u64) -> Result<(), FetchError> {
        self.bytes = self.bytes.saturating_add(size);
        if self.bytes > self.max_bytes {
            return Err(failed(
                LanguageServerFetchFailure::TooLarge,
                "unpacks to too many bytes",
            ));
        }
        Ok(())
    }
}

fn file_mode(unix_mode: u32) -> u32 {
    if unix_mode & 0o111 != 0 { 0o755 } else { 0o644 }
}

fn create_with_mode(path: &Path, mode: u32) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(path)
}

fn copy_capped(
    reader: &mut impl Read,
    writer: &mut impl Write,
    budget: &mut Budget,
) -> Result<(), FetchError> {
    let mut chunk = vec![0u8; COPY_CHUNK];
    loop {
        let count = reader
            .read(&mut chunk)
            .map_err(|error| bad_archive_from(&error))?;
        if count == 0 {
            return Ok(());
        }
        budget.add(count as u64)?;
        writer
            .write_all(&chunk[..count])
            .map_err(|error| bad_archive_from(&error))?;
    }
}

fn unpack_gzip(file: &Path, target: &Path, budget: &mut Budget) -> Result<(), FetchError> {
    budget.file(0)?;
    let input = File::open(file).map_err(|error| bad_archive_from(&error))?;
    let mut decoder = MultiGzDecoder::new(input);
    let mut output = create_with_mode(target, 0o666).map_err(|error| bad_archive_from(&error))?;
    copy_capped(&mut decoder, &mut output, budget)
}

fn open_tar(file: &Path) -> Result<tar::Archive<MultiGzDecoder<File>>, FetchError> {
    let input = File::open(file).map_err(|error| bad_archive_from(&error))?;
    Ok(tar::Archive::new(MultiGzDecoder::new(input)))
}

fn check_tar_headers(file: &Path) -> Result<(), FetchError> {
    let mut raw = open_tar(file)?;
    for entry in raw
        .entries()
        .map_err(|error| bad_archive_from(&error))?
        .raw(true)
    {
        let entry = entry.map_err(|error| bad_archive_from(&error))?;
        let kind = entry.header().entry_type();
        let describes_another = kind.is_gnu_longname()
            || kind.is_gnu_longlink()
            || kind.is_pax_local_extensions()
            || kind.is_pax_global_extensions();
        if describes_another && entry.size() > TAR_META_MAX_BYTES {
            return Err(bad_archive("an archive header is too large"));
        }
    }
    Ok(())
}

fn unpack_tar(file: &Path, stage: &Path, budget: &mut Budget) -> Result<(), FetchError> {
    check_tar_headers(file)?;
    let mut listing = open_tar(file)?;
    for entry in listing
        .entries()
        .map_err(|error| bad_archive_from(&error))?
    {
        let entry = entry.map_err(|error| bad_archive_from(&error))?;
        let kind = entry.header().entry_type();
        if kind.is_pax_global_extensions() {
            continue;
        }
        let name = String::from_utf8_lossy(&entry.path_bytes()).into_owned();
        entry_target(stage, &name)?;
        if kind.is_dir() {
            continue;
        }
        if !(kind.is_file() || kind.is_contiguous()) {
            return Err(bad_archive("it holds a link or special file"));
        }
        budget.file(entry.size())?;
    }
    let mut extraction = open_tar(file)?;
    for entry in extraction
        .entries()
        .map_err(|error| bad_archive_from(&error))?
    {
        let mut entry = entry.map_err(|error| bad_archive_from(&error))?;
        let kind = entry.header().entry_type();
        if kind.is_pax_global_extensions() {
            continue;
        }
        let name = String::from_utf8_lossy(&entry.path_bytes()).into_owned();
        let target = entry_target(stage, &name)?;
        if kind.is_dir() {
            fs::create_dir_all(&target).map_err(|error| bad_archive_from(&error))?;
            continue;
        }
        let mode = file_mode(entry.header().mode().unwrap_or(0));
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| bad_archive_from(&error))?;
        }
        let mut output =
            create_with_mode(&target, mode).map_err(|error| bad_archive_from(&error))?;
        io::copy(&mut entry, &mut output).map_err(|error| bad_archive_from(&error))?;
    }
    Ok(())
}

struct ZipFileJob {
    index: usize,
    target: PathBuf,
    mode: u32,
    size: u64,
}

fn unpack_zip(file: &Path, stage: &Path, budget: &mut Budget) -> Result<(), FetchError> {
    let input = File::open(file).map_err(|error| bad_archive_from(&error))?;
    let mut zip = ZipArchive::new(input).map_err(|error| bad_archive_from(&error))?;
    let mut jobs = Vec::new();
    for index in 0..zip.len() {
        let entry = zip
            .by_index_raw(index)
            .map_err(|error| bad_archive_from(&error))?;
        let name = entry.name().to_owned();
        let target = entry_target(stage, &name)?;
        if name.ends_with('/') {
            continue;
        }
        let unix_mode = entry.get_metadata().external_attributes >> 16;
        if unix_mode & FILE_TYPE_MASK == SYMLINK_TYPE {
            return Err(bad_archive("it holds a link or special file"));
        }
        budget.file(entry.size())?;
        jobs.push(ZipFileJob {
            index,
            target,
            mode: file_mode(unix_mode),
            size: entry.size(),
        });
    }
    for job in jobs {
        if let Some(parent) = job.target.parent() {
            fs::create_dir_all(parent).map_err(|error| bad_archive_from(&error))?;
        }
        let entry = zip
            .by_index(job.index)
            .map_err(|error| bad_archive_from(&error))?;
        let mut output =
            create_with_mode(&job.target, job.mode).map_err(|error| bad_archive_from(&error))?;
        let copied = io::copy(&mut entry.take(job.size.saturating_add(1)), &mut output)
            .map_err(|error| bad_archive_from(&error))?;
        if copied != job.size {
            return Err(bad_archive("an entry size does not match"));
        }
    }
    Ok(())
}

fn unpack_archive(
    asset: &LanguageServerAsset,
    file: &Path,
    stage: &Path,
    mut budget: Budget,
) -> Result<(), FetchError> {
    let single = node_path::join(stage, &asset.executable);
    match asset.archive {
        LanguageServerArchive::Plain | LanguageServerArchive::Gz
            if !is_inside_path(stage, &single) =>
        {
            Err(failed(LanguageServerFetchFailure::ExecutableMissing, ""))
        }
        LanguageServerArchive::Plain => {
            fs::rename(file, &single).map_err(|error| bad_archive_from(&error))
        }
        LanguageServerArchive::Gz => unpack_gzip(file, &single, &mut budget),
        LanguageServerArchive::TarGz => unpack_tar(file, stage, &mut budget),
        LanguageServerArchive::Zip => unpack_zip(file, stage, &mut budget),
    }
}

fn download_reason(reason: DownloadFailure) -> LanguageServerFetchFailure {
    match reason {
        DownloadFailure::HostNotAllowed => LanguageServerFetchFailure::HostNotAllowed,
        DownloadFailure::RedirectRefused => LanguageServerFetchFailure::RedirectRefused,
        DownloadFailure::HttpError => LanguageServerFetchFailure::HttpError,
        DownloadFailure::TooLarge => LanguageServerFetchFailure::TooLarge,
    }
}

fn download_failure(error: &DownloadError) -> FetchError {
    let Some(reason) = error.reason() else {
        return offline(error);
    };
    let detail = if reason == DownloadFailure::TooLarge {
        "the download is too large".to_owned()
    } else {
        let text = error.to_string();
        text.strip_prefix(&format!("{reason}: "))
            .unwrap_or_default()
            .to_owned()
    };
    failed(download_reason(reason), &detail)
}

fn report_lines(text: &[u8], hooks: &FetchHooks) {
    for line in String::from_utf8_lossy(text).split('\n') {
        if !js_trim(line).is_empty() {
            (hooks.on_output)(clip(line.trim_end_matches(is_js_space)));
        }
    }
}

async fn drain(reader: &mut (impl AsyncRead + Unpin), buffer: &mut Vec<u8>) -> bool {
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => return false,
            Ok(count) => {
                let room = GO_OUTPUT_MAX_BYTES - buffer.len();
                if count > room {
                    buffer.extend_from_slice(&chunk[..room]);
                    return true;
                }
                buffer.extend_from_slice(&chunk[..count]);
            }
        }
    }
}

enum GoOutcome {
    Exited(io::Result<ExitStatus>),
    TooMuch,
}

fn spawn_code(error: &io::Error) -> &'static str {
    match error.kind() {
        io::ErrorKind::NotFound => "ENOENT",
        io::ErrorKind::PermissionDenied => "EACCES",
        _ => "an error",
    }
}

fn fetching(running: &HashMap<String, Pending>, key: &str) -> bool {
    let prefix = format!("{key}@");
    running.keys().any(|running| running.starts_with(&prefix))
}

impl ManagedServers {
    pub fn new(deps: ManagedServersDeps) -> Self {
        Self {
            deps: Arc::new(deps),
            running: Arc::default(),
        }
    }

    fn platform(&self) -> String {
        self.deps.platform.clone().unwrap_or_else(host_platform)
    }

    fn server_dir(&self, ext_id: &str, server_id: &str) -> PathBuf {
        node_path::join(&node_path::join(&self.deps.dir, ext_id), server_id)
    }

    fn version_dir(&self, ext_id: &str, server_id: &str, version: &str) -> PathBuf {
        node_path::join(&self.server_dir(ext_id, server_id), version)
    }

    fn asset_for<'a>(&self, run: &'a LanguageServerRun) -> Option<&'a LanguageServerAsset> {
        let LanguageServerRun::Download(download) = run else {
            return None;
        };
        let platform = LanguageServerPlatform::parse(&self.platform())?;
        download
            .download
            .assets
            .0
            .iter()
            .find(|(candidate, _)| *candidate == platform)
            .map(|(_, asset)| asset)
    }

    fn relative_executable(&self, run: &LanguageServerRun) -> Option<String> {
        if let LanguageServerRun::GoInstall(go) = run {
            let binary = &go.go_install.binary;
            return Some(if self.platform().starts_with("win32") {
                format!("{binary}.exe")
            } else {
                binary.clone()
            });
        }
        self.asset_for(run).map(|asset| asset.executable.clone())
    }

    pub fn forget_extension(&self, ext_id: &str) {
        discard(&node_path::join(&self.deps.dir, ext_id));
    }

    pub fn retain(&self, keep: &HashMap<String, String>) {
        let running = self.running.lock();
        for ext_id in children(&self.deps.dir) {
            let ext_dir = self.deps.dir.join(&ext_id);
            for server_id in children(&ext_dir) {
                let key = format!("{ext_id}/{server_id}");
                let server_dir = ext_dir.join(&server_id);
                let Some(version) = keep.get(&key) else {
                    if !fetching(&running, &key) {
                        discard(&server_dir);
                    }
                    continue;
                };
                for name in children(&server_dir) {
                    if name == *version || fetching(&running, &key) {
                        continue;
                    }
                    discard(&server_dir.join(name));
                }
            }
            if children(&ext_dir).is_empty() {
                discard(&ext_dir);
            }
        }
    }

    fn start(
        &self,
        key: String,
        ext_id: &str,
        server_id: &str,
        run: &LanguageServerRun,
        hooks: FetchHooks,
    ) -> Pending {
        let this = self.clone();
        let ext_id = ext_id.to_owned();
        let server_id = server_id.to_owned();
        let run = run.clone();
        let finished = key.clone();
        let handle = tokio::spawn(async move {
            let result = this.install(&ext_id, &server_id, &run, &hooks).await;
            this.running.lock().remove(&finished);
            result
        });
        async move {
            handle
                .await
                .unwrap_or_else(|error| Err(write_failed(&error)))
        }
        .boxed()
        .shared()
    }

    async fn install(
        &self,
        ext_id: &str,
        server_id: &str,
        run: &LanguageServerRun,
        hooks: &FetchHooks,
    ) -> Result<String, FetchError> {
        let (Some(version), Some(relative)) = (pinned_version(run), self.relative_executable(run))
        else {
            return Err(failed(LanguageServerFetchFailure::ExecutableMissing, ""));
        };
        let server_dir = self.server_dir(ext_id, server_id);
        let stage = server_dir.join(format!(".stage-{}", Uuid::new_v4()));
        let download = server_dir.join(format!(".download-{}", Uuid::new_v4()));
        let result = match self
            .populate(run, hooks, &relative, &stage, &download)
            .await
        {
            Ok(()) => self.publish(ext_id, server_id, version, &relative, &stage),
            Err(error) => Err(error),
        };
        discard(&stage);
        discard(&download);
        result
    }

    async fn populate(
        &self,
        run: &LanguageServerRun,
        hooks: &FetchHooks,
        relative: &str,
        stage: &Path,
        download: &Path,
    ) -> Result<(), FetchError> {
        make_private_dir(stage).map_err(|error| write_failed(&error))?;
        if let LanguageServerRun::GoInstall(go) = run {
            self.go_install(&go.go_install, stage, hooks).await?;
        } else {
            let asset = self
                .asset_for(run)
                .ok_or_else(|| failed(LanguageServerFetchFailure::ExecutableMissing, ""))?;
            self.download(asset, download, hooks).await?;
            self.unpack(asset, download, stage).await?;
        }
        let executable = node_path::join(stage, relative);
        let is_file = fs::symlink_metadata(&executable).is_ok_and(|metadata| metadata.is_file());
        if !is_inside_path(stage, &executable) || !is_file {
            return Err(failed(LanguageServerFetchFailure::ExecutableMissing, ""));
        }
        Ok(())
    }

    fn publish(
        &self,
        ext_id: &str,
        server_id: &str,
        version: &str,
        relative: &str,
        stage: &Path,
    ) -> Result<String, FetchError> {
        let move_in = || -> io::Result<PathBuf> {
            fs::set_permissions(
                node_path::join(stage, relative),
                fs::Permissions::from_mode(0o755),
            )?;
            let target = self.version_dir(ext_id, server_id, version);
            remove_any(&target)?;
            fs::rename(stage, &target)?;
            fs::set_permissions(&target, fs::Permissions::from_mode(0o700))?;
            self.drop_other_versions(&self.server_dir(ext_id, server_id), version)?;
            Ok(target)
        };
        let target = move_in().map_err(|error| write_failed(&error))?;
        Ok(node_path::join(&target, relative)
            .to_string_lossy()
            .into_owned())
    }

    fn drop_other_versions(&self, server_dir: &Path, keep: &str) -> io::Result<()> {
        for entry in fs::read_dir(server_dir)? {
            let name = entry?.file_name().to_string_lossy().into_owned();
            if name == keep || name.starts_with(".stage-") || name.starts_with(".download-") {
                continue;
            }
            remove_any(&server_dir.join(name))?;
        }
        Ok(())
    }

    fn request_url(&self, raw: &str) -> Result<String, FetchError> {
        let url = Url::parse(raw).map_err(|error| offline(&error))?;
        let Some(base) = non_empty(self.deps.base_url.as_deref()) else {
            return Ok(url.to_string());
        };
        let query = url
            .query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default();
        Url::parse(base)
            .and_then(|base| base.join(&format!("{}{query}", url.path())))
            .map(String::from)
            .map_err(|error| offline(&error))
    }

    async fn download(
        &self,
        asset: &LanguageServerAsset,
        file: &Path,
        hooks: &FetchHooks,
    ) -> Result<(), FetchError> {
        if let Some(parent) = file.parent() {
            make_private_dir(parent).map_err(|error| offline(&error))?;
        }
        let base = self.deps.base_url.clone();
        let reported = Arc::new(AtomicI64::new(-1));
        let on_percent = Arc::clone(&hooks.on_progress);
        let request = DownloadRequest {
            url: self.request_url(&asset.url)?,
            allowed: Arc::new(move |url: &str| {
                is_allowed_hop(url, &LANGUAGE_SERVER_DOWNLOAD_HOSTS, base.as_deref())
            }),
            user_agent: self.deps.user_agent.clone(),
        };
        let target = DownloadTarget {
            file: file.to_path_buf(),
            exclusive: false,
            max_bytes: self.deps.max_download_bytes.unwrap_or(DOWNLOAD_MAX_BYTES),
            on_progress: Arc::new(move |received, total| {
                let percent = if total > 0 {
                    ((received as f64 / total as f64) * 100.0).floor() as i64
                } else {
                    0
                };
                if reported.swap(percent, Ordering::Relaxed) == percent {
                    return;
                }
                on_percent(percent.min(100) as u32);
            }),
        };
        let limit = self.deps.download_timeout.unwrap_or(DOWNLOAD_TIMEOUT);
        let sha256 = match tokio::time::timeout(limit, download_checked(&request, &target)).await {
            Err(_) => {
                return Err(failed(
                    LanguageServerFetchFailure::Timeout,
                    "The operation was aborted due to timeout",
                ));
            }
            Ok(Err(error)) => return Err(download_failure(&error)),
            Ok(Ok(sha256)) => sha256,
        };
        if sha256 != asset.sha256 {
            return Err(failed(LanguageServerFetchFailure::ChecksumMismatch, ""));
        }
        Ok(())
    }

    async fn unpack(
        &self,
        asset: &LanguageServerAsset,
        file: &Path,
        stage: &Path,
    ) -> Result<(), FetchError> {
        let budget = Budget::with_limits(
            self.deps.max_extract_bytes.unwrap_or(EXTRACT_MAX_BYTES),
            self.deps.max_extract_files.unwrap_or(EXTRACT_MAX_FILES),
        );
        let asset = asset.clone();
        let file = file.to_path_buf();
        let stage = stage.to_path_buf();
        tokio::task::spawn_blocking(move || unpack_archive(&asset, &file, &stage, budget))
            .await
            .unwrap_or_else(|error| Err(bad_archive_from(&error)))
    }

    async fn go_install(
        &self,
        install: &LanguageServerGoInstall,
        stage: &Path,
        hooks: &FetchHooks,
    ) -> Result<(), FetchError> {
        let Some(go) = (self.deps.find_program)(GO_PROGRAM) else {
            return Err(failed(
                LanguageServerFetchFailure::CommandFailed,
                "go is not on PATH",
            ));
        };
        let mut child = Command::new(go)
            .args(go_install_args(install))
            .current_dir(stage)
            .env_clear()
            .envs((self.deps.env)())
            .env("GOBIN", stage)
            .env("GOFLAGS", "")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                failed(
                    LanguageServerFetchFailure::CommandFailed,
                    &format!("go install exited with {}", spawn_code(&error)),
                )
            })?;
        let (Some(mut stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take())
        else {
            return Err(failed(
                LanguageServerFetchFailure::CommandFailed,
                "go install exited with an error",
            ));
        };
        let mut out_text = Vec::new();
        let mut err_text = Vec::new();
        let limit = self.deps.go_timeout.unwrap_or(GO_INSTALL_TIMEOUT);
        let outcome = tokio::time::timeout(limit, async {
            let out_read = drain(&mut stdout, &mut out_text);
            let err_read = drain(&mut stderr, &mut err_text);
            tokio::pin!(out_read, err_read);
            let (mut out_open, mut err_open) = (true, true);
            while out_open || err_open {
                let exceeded = tokio::select! {
                    over = &mut out_read, if out_open => { out_open = false; over }
                    over = &mut err_read, if err_open => { err_open = false; over }
                };
                if exceeded {
                    let _ = child.kill().await;
                    return GoOutcome::TooMuch;
                }
            }
            GoOutcome::Exited(child.wait().await)
        })
        .await;
        report_lines(&out_text, hooks);
        report_lines(&err_text, hooks);
        match outcome {
            Err(_) => {
                let _ = child.start_kill();
                Err(failed(
                    LanguageServerFetchFailure::Timeout,
                    "go install took too long",
                ))
            }
            Ok(GoOutcome::TooMuch) => Err(failed(
                LanguageServerFetchFailure::CommandFailed,
                "go install printed too much",
            )),
            Ok(GoOutcome::Exited(Ok(status))) if status.success() => Ok(()),
            Ok(GoOutcome::Exited(Ok(status))) => {
                let code = status
                    .code()
                    .map_or_else(|| "an error".to_owned(), |code| code.to_string());
                Err(failed(
                    LanguageServerFetchFailure::CommandFailed,
                    &format!("go install exited with {code}"),
                ))
            }
            Ok(GoOutcome::Exited(Err(_))) => Err(failed(
                LanguageServerFetchFailure::CommandFailed,
                "go install exited with an error",
            )),
        }
    }
}

impl ManagedServerFiles for ManagedServers {
    fn can_fetch(&self, run: &LanguageServerRun) -> bool {
        matches!(run, LanguageServerRun::GoInstall(_)) || self.asset_for(run).is_some()
    }

    fn executable(&self, ext_id: &str, server_id: &str, run: &LanguageServerRun) -> Option<String> {
        let version = pinned_version(run)?;
        let relative = self.relative_executable(run)?;
        let path = node_path::join(&self.version_dir(ext_id, server_id, version), &relative);
        fs::symlink_metadata(&path)
            .ok()
            .filter(fs::Metadata::is_file)
            .map(|_| path.to_string_lossy().into_owned())
    }

    fn folder(&self, ext_id: &str, server_id: &str, version: &str) -> String {
        self.version_dir(ext_id, server_id, version)
            .to_string_lossy()
            .into_owned()
    }

    fn fetch<'a>(
        &'a self,
        ext_id: &'a str,
        server_id: &'a str,
        run: &'a LanguageServerRun,
        hooks: FetchHooks,
    ) -> BoxFuture<'a, Result<String, FetchError>> {
        let key = format!("{ext_id}/{server_id}@{}", pinned_version(run).unwrap_or(""));
        let pending = {
            let mut running = self.running.lock();
            match running.get(&key) {
                Some(pending) => pending.clone(),
                None => {
                    let started = self.start(key.clone(), ext_id, server_id, run, hooks);
                    running.insert(key, started.clone());
                    started
                }
            }
        };
        pending.boxed()
    }

    fn remove(&self, ext_id: &str, server_id: &str) {
        discard(&self.server_dir(ext_id, server_id));
    }
}
