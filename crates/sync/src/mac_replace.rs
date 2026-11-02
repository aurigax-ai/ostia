use std::fs;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use ostia_base::PRODUCT_NAME;
use ostia_base::bounded_run::run_bounded;
use ostia_base::host::Host;
use ostia_base::js::js_trim;
use ostia_base::json_store::load_json;
use ostia_contract::build_info::{parse_build_info, release_version};
use ostia_contract::install_method::{ReplaceAvailability, ReplaceBlock, ReplaceFailure};
use ostia_contract::releases::{ReleaseInfo, dmg_asset_name};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::Notify;
use tokio::time::Instant;

use crate::install_cleanup::{remove_tree_force, remove_tree_force_sync};
use crate::install_method::dirname;
use crate::install_replace::{
    CHECKSUMS_FILE, CHECKSUMS_MAX_BYTES, DownloadJob, InstallingFn, ProgressFn, ReplaceError,
    UPDATE_ARCHIVE_MAX_BYTES, checksum_for, download_to, fetch_text, replaceable_at, suffixed,
    try_release_asset_url,
};

const MAC_TEAM_ID: &str = "4ZNCN9338G";
const MAC_BUNDLE_ID: &str = "ai.aurigax.ostia";
const DMG_APP: &str = "Ostia.app";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5 * 60);
pub const COMMAND_OUTPUT_MAX: usize = 1024 * 1024;
const SWAP_VERIFY_TIMEOUT: Duration = Duration::from_secs(60);
const NOTARIZED_LINE: &str = "source=Notarized Developer ID";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignaturePolicy {
    Release,
    Adhoc,
}

pub fn signature_policy(is_packaged: bool, host: &Host) -> SignaturePolicy {
    if is_packaged {
        return SignaturePolicy::Release;
    }
    if host.app_var("UPDATE_SIGNATURE") == Some("adhoc") {
        SignaturePolicy::Adhoc
    } else {
        SignaturePolicy::Release
    }
}

pub fn designated_requirement(policy: SignaturePolicy) -> String {
    let identifier = format!("identifier \"{MAC_BUNDLE_ID}\"");
    match policy {
        SignaturePolicy::Adhoc => identifier,
        SignaturePolicy::Release => format!(
            "anchor apple generic and certificate leaf[subject.OU] = \"{MAC_TEAM_ID}\" and {identifier}"
        ),
    }
}

pub fn staged_bundle_path(bundle: &Path) -> PathBuf {
    let name = bundle
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    dirname(bundle).join(format!(".{name}.new"))
}

pub fn old_bundle_path(bundle: &Path) -> PathBuf {
    suffixed(bundle, ".old")
}

pub async fn can_replace_bundle(bundle: &Path, is_arm64: bool) -> ReplaceAvailability {
    let blocked = |reason| ReplaceAvailability::Blocked { reason, path: None };
    if !is_arm64 {
        return blocked(ReplaceBlock::Unsupported);
    }
    let text = bundle.to_string_lossy();
    if text.contains("/AppTranslocation/") {
        return blocked(ReplaceBlock::Translocated);
    }
    if text.starts_with("/Volumes/") {
        return blocked(ReplaceBlock::ReadOnly);
    }
    replaceable_at(
        bundle,
        &[staged_bundle_path(bundle), old_bundle_path(bundle)],
    )
    .await
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandResult {
    pub code: i32,
    pub output: String,
}

pub type CommandFuture = Pin<Box<dyn Future<Output = CommandResult> + Send>>;
pub type RunCommand = Arc<dyn Fn(String, Vec<String>) -> CommandFuture + Send + Sync>;

async fn drain<R: AsyncRead + Unpin + Send + 'static>(
    stream: Option<R>,
    overflow: Arc<Notify>,
) -> (Vec<u8>, bool) {
    let mut bytes = Vec::new();
    let Some(stream) = stream else {
        return (bytes, false);
    };
    let mut limited = stream.take(COMMAND_OUTPUT_MAX as u64 + 1);
    let _ = limited.read_to_end(&mut bytes).await;
    let exceeded = bytes.len() > COMMAND_OUTPUT_MAX;
    if exceeded {
        bytes.truncate(COMMAND_OUTPUT_MAX);
        overflow.notify_one();
    }
    (bytes, exceeded)
}

pub async fn run_command(command: &str, args: &[String]) -> CommandResult {
    let spawned = Command::new(command)
        .args(args)
        .env_clear()
        .envs(Host::current().child_env())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let Ok(mut child) = spawned else {
        return CommandResult {
            code: 1,
            output: String::new(),
        };
    };
    let overflow = Arc::new(Notify::new());
    let stdout = tokio::spawn(drain(child.stdout.take(), Arc::clone(&overflow)));
    let stderr = tokio::spawn(drain(child.stderr.take(), Arc::clone(&overflow)));
    let waited = tokio::time::timeout(COMMAND_TIMEOUT, async {
        tokio::select! {
            status = child.wait() => status.ok(),
            () = overflow.notified() => None,
        }
    })
    .await;
    let status = waited.unwrap_or(None);
    if status.is_none() {
        let _ = child.kill().await;
    }
    let (stdout, stdout_exceeded) = stdout.await.unwrap_or_default();
    let (stderr, stderr_exceeded) = stderr.await.unwrap_or_default();
    let code = match status {
        _ if stdout_exceeded || stderr_exceeded => 1,
        Some(status) if status.success() => 0,
        Some(status) => status.code().unwrap_or(1),
        None => 1,
    };
    CommandResult {
        code,
        output: format!(
            "{}{}",
            String::from_utf8_lossy(&stdout),
            String::from_utf8_lossy(&stderr)
        ),
    }
}

pub fn command_runner() -> RunCommand {
    Arc::new(|command: String, args: Vec<String>| -> CommandFuture {
        Box::pin(async move { run_command(&command, &args).await })
    })
}

async fn call(run: &RunCommand, command: &str, args: &[&str]) -> CommandResult {
    run(
        command.to_owned(),
        args.iter().map(|arg| (*arg).to_owned()).collect(),
    )
    .await
}

fn notarized(output: &str) -> bool {
    output
        .split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .any(|line| line == NOTARIZED_LINE)
}

async fn bundle_version(bundle: &Path, run: &RunCommand) -> Option<String> {
    let plist = bundle
        .join("Contents")
        .join("Info.plist")
        .to_string_lossy()
        .into_owned();
    let result = call(
        run,
        "plutil",
        &[
            "-extract",
            "CFBundleShortVersionString",
            "raw",
            "-o",
            "-",
            plist.as_str(),
        ],
    )
    .await;
    (result.code == 0).then(|| js_trim(&result.output).to_owned())
}

fn build_info_version(bundle: &Path) -> Option<String> {
    let raw = load_json(
        &bundle
            .join("Contents")
            .join("Resources")
            .join("build-info.json"),
    )?;
    Some(release_version(&parse_build_info(&raw)?.version).to_owned())
}

async fn verify_bundle(
    bundle: &Path,
    version: &str,
    policy: SignaturePolicy,
    run: &RunCommand,
) -> Result<(), ReplaceError> {
    let target = bundle.to_string_lossy().into_owned();
    let strict = ["--verify", "--deep", "--strict"];
    let plain = [strict[0], strict[1], strict[2], target.as_str()];
    if call(run, "codesign", &plain).await.code != 0 {
        return Err(ReplaceFailure::BadSignature.into());
    }
    let requirement = format!("-R={}", designated_requirement(policy));
    let pinned = [
        strict[0],
        strict[1],
        strict[2],
        requirement.as_str(),
        target.as_str(),
    ];
    if call(run, "codesign", &pinned).await.code != 0 {
        return Err(ReplaceFailure::WrongTeam.into());
    }
    if policy == SignaturePolicy::Release {
        let assessed = call(run, "spctl", &["-a", "-t", "exec", "-vv", target.as_str()]).await;
        if assessed.code != 0 || !notarized(&assessed.output) {
            return Err(ReplaceFailure::NotNotarized.into());
        }
    }
    let (plist, built) = tokio::join!(bundle_version(bundle, run), async {
        build_info_version(bundle)
    });
    if plist.as_deref() != Some(version) || built.as_deref() != Some(version) {
        return Err(ReplaceFailure::WrongVersion.into());
    }
    Ok(())
}

async fn detach(mount_point: &Path, run: &RunCommand) {
    let mount = mount_point.to_string_lossy().into_owned();
    if call(run, "hdiutil", &["detach", mount.as_str()]).await.code == 0 {
        return;
    }
    call(run, "hdiutil", &["detach", "-force", mount.as_str()]).await;
}

pub struct ReplaceMacInstall {
    pub bundle: PathBuf,
    pub release: ReleaseInfo,
    pub base: String,
    pub run: RunCommand,
    pub policy: SignaturePolicy,
    pub timeout: Duration,
    pub on_progress: ProgressFn,
    pub on_installing: InstallingFn,
    pub work_root: Option<PathBuf>,
    pub is_arm64: bool,
}

pub fn replace_mac_install(
    options: ReplaceMacInstall,
) -> impl Future<Output = Result<(), ReplaceError>> + Send {
    let deadline = Instant::now() + options.timeout;
    replace_mac_install_until(options, deadline)
}

struct DmgJob<'a> {
    run: &'a RunCommand,
    base: &'a str,
    sums_url: &'a url::Url,
    dmg_url: &'a url::Url,
    asset: &'a str,
    published: &'a str,
    version: &'a str,
    policy: SignaturePolicy,
    work: &'a Path,
    staged: &'a Path,
    deadline: Instant,
}

async fn stage_dmg(
    job: DmgJob<'_>,
    on_progress: ProgressFn,
    on_installing: InstallingFn,
    mounted: &mut bool,
) -> Result<(), ReplaceError> {
    let sums = fetch_text(job.sums_url, job.base, CHECKSUMS_MAX_BYTES, job.deadline).await?;
    let expected = checksum_for(&sums, job.asset)
        .ok_or_else(|| ReplaceError::from(ReplaceFailure::NoChecksum))?;
    if expected != job.published {
        return Err(ReplaceFailure::ChecksumMismatch.into());
    }
    let image = job.work.join(job.asset);
    let actual = download_to(DownloadJob {
        url: job.dmg_url,
        base: job.base,
        file: image.clone(),
        max_bytes: UPDATE_ARCHIVE_MAX_BYTES,
        deadline: job.deadline,
        on_progress,
    })
    .await?;
    if actual != expected {
        return Err(ReplaceFailure::ChecksumMismatch.into());
    }
    on_installing();
    let mount_point = job.work.join("mount");
    tokio::fs::create_dir(&mount_point)
        .await
        .map_err(|_| ReplaceError::from(ReplaceFailure::ExtractFailed))?;
    let mount = mount_point.to_string_lossy().into_owned();
    let image_arg = image.to_string_lossy().into_owned();
    let attached = call(
        job.run,
        "hdiutil",
        &[
            "attach",
            "-nobrowse",
            "-readonly",
            "-noautoopen",
            "-mountpoint",
            mount.as_str(),
            image_arg.as_str(),
        ],
    )
    .await;
    if attached.code != 0 {
        return Err(ReplaceFailure::MountFailed.into());
    }
    *mounted = true;
    let source = mount_point.join(DMG_APP).to_string_lossy().into_owned();
    let target = job.staged.to_string_lossy().into_owned();
    let copied = call(job.run, "ditto", &[source.as_str(), target.as_str()]).await;
    if copied.code != 0 {
        return Err(ReplaceFailure::ExtractFailed.into());
    }
    detach(&mount_point, job.run).await;
    *mounted = false;
    verify_bundle(job.staged, job.version, job.policy, job.run).await
}

async fn replace_mac_install_until(
    options: ReplaceMacInstall,
    deadline: Instant,
) -> Result<(), ReplaceError> {
    let extract_failed = || ReplaceError::from(ReplaceFailure::ExtractFailed);
    let ReplaceMacInstall {
        bundle,
        release,
        base,
        run,
        policy,
        on_progress,
        on_installing,
        work_root,
        is_arm64,
        ..
    } = options;
    let version = release.version.clone();
    let asset = dmg_asset_name(&version);
    let dmg_url = try_release_asset_url(&base, &version, &asset).map_err(|_| extract_failed())?;
    let sums_url =
        try_release_asset_url(&base, &version, CHECKSUMS_FILE).map_err(|_| extract_failed())?;
    let (Some(dmg_url), Some(sums_url)) = (dmg_url, sums_url) else {
        return Err(ReplaceFailure::HttpError.into());
    };
    if can_replace_bundle(&bundle, is_arm64).await != ReplaceAvailability::Ok {
        return Err(ReplaceFailure::Blocked.into());
    }
    let staged = staged_bundle_path(&bundle);
    let root = work_root.unwrap_or_else(|| Host::current().tmp_dir());
    let work = tempfile::Builder::new()
        .prefix(&format!("{PRODUCT_NAME}-update-"))
        .tempdir_in(root)
        .map_err(|_| extract_failed())?
        .keep();
    let mut mounted = false;
    let outcome = match ostia_base::js::non_empty(release.dmg_sha256.as_deref()) {
        None => Err(ReplaceFailure::NoChecksum.into()),
        Some(published) => {
            stage_dmg(
                DmgJob {
                    run: &run,
                    base: &base,
                    sums_url: &sums_url,
                    dmg_url: &dmg_url,
                    asset: &asset,
                    published,
                    version: &version,
                    policy,
                    work: &work,
                    staged: &staged,
                    deadline,
                },
                on_progress,
                on_installing,
                &mut mounted,
            )
            .await
        }
    };
    let outcome = match outcome {
        Ok(()) => Ok(()),
        Err(error) => match remove_tree_force(&staged).await {
            Ok(()) => Err(error),
            Err(_) => Err(extract_failed()),
        },
    };
    if mounted {
        detach(&work.join("mount"), &run).await;
    }
    remove_tree_force(&work)
        .await
        .map_err(|_| extract_failed())?;
    outcome
}

pub async fn discard_staged(bundle: &Path) -> io::Result<()> {
    remove_tree_force(&staged_bundle_path(bundle)).await
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwapResult {
    Swapped,
    NothingStaged,
    Rejected,
    Failed,
}

pub fn verify_staged_sync(staged: &Path, policy: SignaturePolicy) -> bool {
    let args = [
        "--verify".to_owned(),
        "--strict".to_owned(),
        format!("-R={}", designated_requirement(policy)),
        staged.to_string_lossy().into_owned(),
    ];
    run_bounded(
        Path::new("codesign"),
        &args,
        &Host::current().child_env(),
        SWAP_VERIFY_TIMEOUT,
    )
    .is_some()
}

pub type RenameFn<'a> = dyn Fn(&Path, &Path) -> io::Result<()> + 'a;

pub struct SwapDeps<'a> {
    pub verify: &'a dyn Fn(&Path) -> bool,
    pub rename: Option<&'a RenameFn<'a>>,
}

fn is_folder(path: &Path) -> Option<bool> {
    fs::symlink_metadata(path)
        .ok()
        .map(|metadata| metadata.is_dir())
}

pub fn swap_staged_bundle(bundle: &Path, deps: SwapDeps<'_>) -> SwapResult {
    let default_rename = |from: &Path, to: &Path| fs::rename(from, to);
    let rename: &RenameFn<'_> = match deps.rename {
        Some(rename) => rename,
        None => &default_rename,
    };
    let staged = staged_bundle_path(bundle);
    let old = old_bundle_path(bundle);
    let Some(staged_is_folder) = is_folder(&staged) else {
        return SwapResult::NothingStaged;
    };
    if !staged_is_folder || !(deps.verify)(&staged) {
        return match remove_tree_force_sync(&staged) {
            Ok(()) => SwapResult::Rejected,
            Err(_) => SwapResult::Failed,
        };
    }
    if is_folder(&old).is_some() {
        return SwapResult::Failed;
    }
    if rename(bundle, &old).is_err() {
        return SwapResult::Failed;
    }
    if rename(&staged, bundle).is_ok() {
        return SwapResult::Swapped;
    }
    let _ = rename(&old, bundle);
    SwapResult::Failed
}
