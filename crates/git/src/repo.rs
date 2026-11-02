use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;

use ostia_base::Host;
use ostia_base::js::{JS_DOT, js_trim, non_empty, static_regex};
use ostia_base::node_path;
use ostia_base::path_guard::is_inside_path;
use regex::Regex;
use serde::Serialize;
use tokio::fs;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::git::{
    BlameLine, BranchRef, ChangeArea, CommitFile, CommitSummary, FileChange, GraphCommit,
    LineChanges,
};
use crate::history::{
    GRAPH_FORMAT, LOG_FORMAT, parse_blame_porcelain, parse_graph_log, parse_log, parse_name_status,
};
use crate::scope::{BRANCH_REF_FORMAT, parse_branch_refs};
use crate::status::{parse_porcelain_v2, parse_shortstat, text_line_count, with_untracked};

const MAX_OUTPUT: usize = 32 * 1024 * 1024;
pub const MAX_SIDE_BYTES: usize = 2 * 1024 * 1024;
const BINARY_SNIFF: usize = 8000;
const MAX_ERROR_TEXT: usize = 4000;
const SUBMODULES_MAX: usize = 10;
const MAX_COUNTED_UNTRACKED: usize = 500;
const LITERAL: &str = "--literal-pathspecs";

const NO_PROGRAMS: [&str; 10] = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "log.showSignature=false",
    "-c",
    "safe.bareRepository=explicit",
    "-c",
    "diff.submodule=short",
    "-c",
    "submodule.recurse=false",
];
const NO_HOOKS: [&str; 2] = ["-c", "core.hooksPath=/dev/null"];

const STATUS: [&str; 5] = [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=dirty",
];

const PATCH_COMMON: [&str; 4] = [
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=dirty",
];

static FILTER_KEY: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(&format!(
        r"^(?:local|worktree)\tfilter\.({JS_DOT}+)\.(clean|smudge|process)$"
    ))
});
static GITLINK: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?s)^160000 [0-9a-f]+ [0-9]\t(.+)$"));
static SHA: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[0-9a-f]{4,64}$"));

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RepoErrorCode {
    NotARepo,
    Binary,
    TooLarge,
    NotChanged,
    GitFailed,
    InvalidArgs,
    UnknownCommit,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoError {
    pub code: RepoErrorCode,
    pub message: String,
}

impl RepoError {
    fn new(code: RepoErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for RepoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RepoError {}

pub type RepoResult<T> = Result<T, RepoError>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DiffSides {
    pub original: String,
    pub modified: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CommitDetail {
    pub commit: CommitSummary,
    pub parent: Option<String>,
    pub files: Vec<CommitFile>,
}

struct RunResult {
    code: i32,
    stdout: Vec<u8>,
    stderr: String,
}

struct Submodule {
    path: String,
    dir: PathBuf,
}

struct Located {
    dir: PathBuf,
    path: String,
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn command(host: &Host, cwd: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(host.child_env())
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

async fn read_capped<R: AsyncRead + Unpin>(pipe: Option<R>) -> (Vec<u8>, bool) {
    let Some(pipe) = pipe else {
        return (Vec::new(), false);
    };
    let cap = u64::try_from(MAX_OUTPUT)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut buf = Vec::new();
    let _ = pipe.take(cap).read_to_end(&mut buf).await;
    let over = buf.len() > MAX_OUTPUT;
    buf.truncate(MAX_OUTPUT);
    (buf, over)
}

async fn capture(mut command: Command) -> RunResult {
    let Ok(mut child) = command.spawn() else {
        return RunResult {
            code: -1,
            stdout: Vec::new(),
            stderr: String::new(),
        };
    };
    let ((stdout, stdout_over), (stderr, stderr_over)) = tokio::join!(
        read_capped(child.stdout.take()),
        read_capped(child.stderr.take())
    );
    let over = stdout_over || stderr_over;
    if over {
        let _ = child.start_kill();
    }
    let status = child.wait().await;
    let code = if over {
        -1
    } else {
        status.ok().and_then(|status| status.code()).unwrap_or(-1)
    };
    RunResult {
        code,
        stdout,
        stderr: text(&stderr),
    }
}

async fn git_output(host: &Host, cwd: &Path, args: &[&str]) -> String {
    let mut full: Vec<&str> = NO_PROGRAMS.to_vec();
    full.extend_from_slice(args);
    let result = capture(command(host, cwd, &full)).await;
    if result.code == 0 {
        text(&result.stdout)
    } else {
        String::new()
    }
}

async fn no_repo_filters(host: &Host, cwd: &Path) -> Vec<String> {
    let listed = git_output(
        host,
        cwd,
        &[
            "config",
            "--show-scope",
            "--name-only",
            "--get-regexp",
            r"^filter\..*\.(clean|smudge|process)$",
        ],
    )
    .await;
    let mut off = Vec::new();
    for line in listed.split('\n') {
        if let Some(found) = FILTER_KEY.captures(line) {
            off.push("-c".to_owned());
            off.push(format!("filter.{}.{}=", &found[1], &found[2]));
        }
    }
    off
}

async fn run(host: &Host, cwd: &Path, args: &[&str], hooks: bool) -> RunResult {
    let filters = no_repo_filters(host, cwd).await;
    let mut full: Vec<&str> = NO_PROGRAMS.to_vec();
    full.extend(filters.iter().map(String::as_str));
    if !hooks {
        full.extend_from_slice(&NO_HOOKS);
    }
    full.extend_from_slice(args);
    capture(command(host, cwd, &full)).await
}

pub async fn run_ok(host: &Host, cwd: &Path, args: &[&str], hooks: bool) -> RepoResult<Vec<u8>> {
    let result = run(host, cwd, args, hooks).await;
    if result.code == 0 {
        return Ok(result.stdout);
    }
    let from_stdout = text(&result.stdout[..result.stdout.len().min(MAX_ERROR_TEXT)]);
    let subcommand = args.iter().find(|arg| !arg.starts_with('-')).unwrap_or(&"");
    let message = non_empty(Some(js_trim(&result.stderr)))
        .or_else(|| non_empty(Some(js_trim(&from_stdout))))
        .map_or_else(|| format!("git {subcommand} failed"), str::to_owned);
    Err(RepoError::new(RepoErrorCode::GitFailed, message))
}

pub async fn repo_root(host: &Host, cwd: &Path) -> Option<String> {
    let result = run(host, cwd, &["rev-parse", "--show-toplevel"], false).await;
    if result.code != 0 {
        return None;
    }
    let root = text(&result.stdout);
    non_empty(Some(js_trim(&root))).map(str::to_owned)
}

pub async fn worktree_key(host: &Host, cwd: &Path) -> Option<String> {
    let result = run(
        host,
        cwd,
        &["rev-parse", "--show-toplevel", "--absolute-git-dir"],
        false,
    )
    .await;
    if result.code != 0 {
        return None;
    }
    let out = text(&result.stdout);
    let mut lines = js_trim(&out).split('\n');
    let top = non_empty(lines.next())?;
    let git_dir = non_empty(lines.next())?;
    Some(format!("{top}\0{git_dir}"))
}

async fn real_or(path: &Path) -> PathBuf {
    fs::canonicalize(path)
        .await
        .unwrap_or_else(|_| path.to_path_buf())
}

async fn submodules(host: &Host, root: &Path) -> Vec<Submodule> {
    let listed = run(host, root, &["ls-files", "-s", "-z"], false).await;
    if listed.code != 0 {
        return Vec::new();
    }
    let paths: Vec<String> = text(&listed.stdout)
        .split('\0')
        .filter_map(|entry| GITLINK.captures(entry).map(|found| found[1].to_owned()))
        .take(SUBMODULES_MAX)
        .collect();
    let real_root = real_or(root).await;
    let mut found = Vec::new();
    for path in paths {
        let Ok(dir) = fs::canonicalize(node_path::join(root, &path)).await else {
            continue;
        };
        if dir == real_root || !is_inside_path(&real_root, &dir) {
            continue;
        }
        if fs::symlink_metadata(dir.join(".git")).await.is_err() {
            continue;
        }
        let top = run(host, &dir, &["rev-parse", "--show-toplevel"], false).await;
        let printed = text(&top.stdout);
        let toplevel = fs::canonicalize(js_trim(&printed)).await.ok();
        if top.code == 0 && toplevel.as_deref() == Some(dir.as_path()) {
            found.push(Submodule { path, dir });
        }
    }
    found
}

async fn in_submodule(host: &Host, root: &Path, path: &str) -> Option<Located> {
    for sub in submodules(host, root).await {
        if let Some(rest) = path
            .strip_prefix(sub.path.as_str())
            .and_then(|rest| rest.strip_prefix('/'))
        {
            return Some(Located {
                dir: sub.dir,
                path: rest.to_owned(),
            });
        }
    }
    None
}

async fn repo_of(host: &Host, root: &Path, path: &str) -> Located {
    match in_submodule(host, root, path).await {
        Some(located) => located,
        None => Located {
            dir: root.to_path_buf(),
            path: path.to_owned(),
        },
    }
}

pub async fn read_status(host: &Host, root: &Path) -> RepoResult<crate::git::RepoStatus> {
    let mut args = vec![STATUS[0], STATUS[1], "--branch"];
    args.extend_from_slice(&STATUS[2..]);
    let out = run_ok(host, root, &args, false).await?;
    let mut status = parse_porcelain_v2(&text(&out));
    for sub in submodules(host, root).await {
        let inner = run(host, &sub.dir, &STATUS, false).await;
        if inner.code != 0 {
            continue;
        }
        for change in parse_porcelain_v2(&text(&inner.stdout)).changes {
            status.changes.push(FileChange {
                path: format!("{}/{}", sub.path, change.path),
                orig_path: change
                    .orig_path
                    .as_ref()
                    .map(|orig| format!("{}/{orig}", sub.path)),
                area: change.area,
                code: change.code,
            });
        }
    }
    Ok(status)
}

fn as_text(buf: &[u8]) -> RepoResult<String> {
    if buf.len() > MAX_SIDE_BYTES {
        return Err(RepoError::new(
            RepoErrorCode::TooLarge,
            "file is too large to diff",
        ));
    }
    if buf[..buf.len().min(BINARY_SNIFF)].contains(&0) {
        return Err(RepoError::new(RepoErrorCode::Binary, "binary file"));
    }
    Ok(text(buf))
}

async fn blob(host: &Host, root: &Path, spec: &str) -> RepoResult<String> {
    let result = run(host, root, &["cat-file", "blob", spec], false).await;
    if result.code == 0 {
        as_text(&result.stdout)
    } else {
        Ok(String::new())
    }
}

async fn worktree(root: &Path, path: &str) -> RepoResult<String> {
    let full = node_path::join(root, path);
    let Ok(info) = fs::symlink_metadata(&full).await else {
        return Ok(String::new());
    };
    if info.file_type().is_symlink() {
        return Ok(fs::read_link(&full)
            .await
            .map(|target| target.to_string_lossy().into_owned())
            .unwrap_or_default());
    }
    match fs::read(&full).await {
        Ok(bytes) => as_text(&bytes),
        Err(_) => Ok(String::new()),
    }
}

async fn descend(host: &Host, root: &Path, change: &FileChange) -> (PathBuf, FileChange) {
    let mut root = root.to_path_buf();
    let mut change = change.clone();
    loop {
        let where_ = repo_of(host, &root, &change.path).await;
        if where_.dir == root {
            return (root, change);
        }
        let origin = match change.orig_path.as_deref() {
            Some(orig) => Some(repo_of(host, &root, orig).await),
            None => None,
        };
        change = FileChange {
            path: where_.path,
            orig_path: origin.map(|origin| origin.path),
            area: change.area,
            code: change.code,
        };
        root = where_.dir;
    }
}

pub async fn diff_sides(host: &Host, root: &Path, change: &FileChange) -> RepoResult<DiffSides> {
    let (root, change) = descend(host, root, change).await;
    let root = root.as_path();
    let base = change.orig_path.as_deref().unwrap_or(&change.path);
    let deleted = change.code == "D";
    match change.area {
        ChangeArea::Staged => Ok(DiffSides {
            original: blob(host, root, &format!("HEAD:{base}")).await?,
            modified: if deleted {
                String::new()
            } else {
                blob(host, root, &format!(":{}", change.path)).await?
            },
        }),
        ChangeArea::Unstaged => Ok(DiffSides {
            original: blob(host, root, &format!(":{}", change.path)).await?,
            modified: if deleted {
                String::new()
            } else {
                worktree(root, &change.path).await?
            },
        }),
        ChangeArea::Conflicted => Ok(DiffSides {
            original: blob(host, root, &format!("HEAD:{}", change.path)).await?,
            modified: worktree(root, &change.path).await?,
        }),
        ChangeArea::Untracked => Ok(DiffSides {
            original: String::new(),
            modified: worktree(root, &change.path).await?,
        }),
    }
}

pub async fn unified_patch(host: &Host, root: &Path, change: &FileChange) -> RepoResult<String> {
    let (root, change) = descend(host, root, change).await;
    let root = root.as_path();
    if change.area == ChangeArea::Untracked {
        let mut args = vec!["diff"];
        args.extend_from_slice(&PATCH_COMMON);
        args.extend_from_slice(&["--no-index", "--", "/dev/null", change.path.as_str()]);
        let result = run(host, root, &args, false).await;
        if result.code != 0 && result.code != 1 {
            return Err(RepoError::new(
                RepoErrorCode::GitFailed,
                js_trim(&result.stderr),
            ));
        }
        return Ok(text(&result.stdout));
    }
    let mut args = vec!["diff"];
    args.extend_from_slice(&PATCH_COMMON);
    if change.area == ChangeArea::Staged {
        args.push("--cached");
    }
    args.extend_from_slice(&["-M", "--"]);
    if let Some(orig) = change.orig_path.as_deref() {
        args.push(orig);
    }
    args.push(&change.path);
    Ok(text(&run_ok(host, root, &args, false).await?))
}

pub async fn repo_relative(root: &Path, cwd: &Path, input: &str) -> RepoResult<String> {
    let base = real_or(cwd).await;
    let abs = if input.starts_with('/') {
        PathBuf::from(input)
    } else {
        node_path::resolve(Path::new(input), &base)
    };
    let real = real_or(&abs).await;
    let real_root = real_or(root).await;
    if !is_inside_path(&real_root, &real) {
        return Err(RepoError::new(
            RepoErrorCode::NotChanged,
            format!("{input} is outside the repository"),
        ));
    }
    let skip = node_path::normal_parts(&real_root).len();
    let relative: Vec<String> = node_path::normal_parts(&real)
        .into_iter()
        .skip(skip)
        .map(|part| part.to_string_lossy().into_owned())
        .collect();
    Ok(relative.join("/"))
}

async fn untracked_lines(root: &Path, path: &str) -> i64 {
    let abs = node_path::join(root, path);
    let Ok(info) = fs::symlink_metadata(&abs).await else {
        return 0;
    };
    let fits = usize::try_from(info.len()).is_ok_and(|size| size <= MAX_SIDE_BYTES);
    if !info.is_file() || !fits {
        return 0;
    }
    match fs::read(&abs).await {
        Ok(buf) => text_line_count(&buf, BINARY_SNIFF),
        Err(_) => 0,
    }
}

pub async fn line_changes(host: &Host, root: &Path, untracked: &[&str]) -> Option<LineChanges> {
    let result = run(
        host,
        root,
        &[
            "-c",
            "diff.autoRefreshIndex=false",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--shortstat",
            "--ignore-submodules=all",
            "HEAD",
        ],
        false,
    )
    .await;
    let tracked = if result.code == 0 {
        parse_shortstat(&text(&result.stdout))
    } else {
        None
    };
    if untracked.is_empty() {
        return tracked;
    }
    let mut counted = Vec::with_capacity(untracked.len());
    for (index, path) in untracked.iter().enumerate() {
        counted.push(if index < MAX_COUNTED_UNTRACKED {
            untracked_lines(root, path).await
        } else {
            0
        });
    }
    Some(with_untracked(tracked.as_ref(), &counted))
}

async fn by_repo(host: &Host, root: &Path, paths: &[&str]) -> Vec<(PathBuf, Vec<String>)> {
    let mut groups: Vec<(PathBuf, Vec<String>)> = Vec::new();
    for path in paths {
        let where_ = repo_of(host, root, path).await;
        match groups.iter_mut().find(|(dir, _)| *dir == where_.dir) {
            Some((_, targets)) => targets.push(where_.path),
            None => groups.push((where_.dir, vec![where_.path])),
        }
    }
    groups
}

fn with_targets<'a>(head: &[&'a str], targets: &'a [String]) -> Vec<&'a str> {
    let mut args = head.to_vec();
    args.extend(targets.iter().map(String::as_str));
    args
}

pub async fn stage(host: &Host, root: &Path, paths: &[&str]) -> RepoResult<()> {
    if paths.is_empty() {
        run_ok(host, root, &[LITERAL, "add", "-A", "--", "."], false).await?;
        return Ok(());
    }
    for (dir, targets) in by_repo(host, root, paths).await {
        let args = with_targets(&[LITERAL, "add", "-A", "--"], &targets);
        run_ok(host, &dir, &args, false).await?;
    }
    Ok(())
}

async fn has_commit(host: &Host, dir: &Path) -> bool {
    run(host, dir, &["rev-parse", "--verify", "-q", "HEAD"], false)
        .await
        .code
        == 0
}

pub async fn unstage(host: &Host, root: &Path, paths: &[&str], has_head: bool) -> RepoResult<()> {
    let groups = if paths.is_empty() {
        vec![(root.to_path_buf(), vec![".".to_owned()])]
    } else {
        by_repo(host, root, paths).await
    };
    for (dir, targets) in groups {
        let committed = if dir == root {
            has_head
        } else {
            has_commit(host, &dir).await
        };
        let args = if committed {
            with_targets(&[LITERAL, "reset", "-q", "HEAD", "--"], &targets)
        } else {
            with_targets(
                &[
                    LITERAL,
                    "rm",
                    "-q",
                    "-r",
                    "--cached",
                    "--ignore-unmatch",
                    "--",
                ],
                &targets,
            )
        };
        run_ok(host, &dir, &args, false).await?;
    }
    Ok(())
}

fn paths_in(changes: &[FileChange], area: ChangeArea) -> Vec<&str> {
    changes
        .iter()
        .filter(|change| change.area == area)
        .map(|change| change.path.as_str())
        .collect()
}

pub async fn discard(host: &Host, root: &Path, changes: &[FileChange]) -> RepoResult<()> {
    let tracked = by_repo(host, root, &paths_in(changes, ChangeArea::Unstaged)).await;
    let untracked = by_repo(host, root, &paths_in(changes, ChangeArea::Untracked)).await;
    for (dir, paths) in tracked {
        let args = with_targets(&[LITERAL, "checkout", "-q", "--"], &paths);
        run_ok(host, &dir, &args, false).await?;
    }
    for (dir, paths) in untracked {
        let args = with_targets(&[LITERAL, "clean", "-q", "-f", "--"], &paths);
        run_ok(host, &dir, &args, false).await?;
    }
    Ok(())
}

pub async fn commit(host: &Host, root: &Path, message: &str) -> RepoResult<String> {
    run_ok(host, root, &["commit", "-q", "-m", message], true).await?;
    let head = run_ok(host, root, &["rev-parse", "HEAD"], false).await?;
    Ok(js_trim(&text(&head)).to_owned())
}

pub async fn log(host: &Host, root: &Path, limit: usize) -> Vec<CommitSummary> {
    let count = format!("-n{limit}");
    let format = format!("--format={LOG_FORMAT}");
    let result = run(
        host,
        root,
        &["log", &count, &format, "--no-color", "--no-show-signature"],
        false,
    )
    .await;
    if result.code != 0 {
        return Vec::new();
    }
    parse_log(&text(&result.stdout))
}

pub async fn branch_refs(
    host: &Host,
    root: &Path,
    head: Option<&str>,
) -> RepoResult<Vec<BranchRef>> {
    let format = format!("--format={BRANCH_REF_FORMAT}");
    let out = run_ok(
        host,
        root,
        &["for-each-ref", &format, "refs/heads", "refs/remotes"],
        false,
    )
    .await?;
    Ok(parse_branch_refs(&text(&out), head))
}

pub async fn graph_log(
    host: &Host,
    root: &Path,
    revisions: &[&str],
    limit: usize,
) -> RepoResult<Vec<GraphCommit>> {
    let count = format!("-n{limit}");
    let format = format!("--format={GRAPH_FORMAT}");
    let mut args: Vec<&str> = vec![
        "log",
        "--no-show-signature",
        "--date-order",
        "--decorate=full",
        "--no-color",
        &count,
        &format,
    ];
    args.extend_from_slice(revisions);
    let out = run_ok(host, root, &args, false).await?;
    Ok(parse_graph_log(&text(&out)))
}

async fn resolve_commit(host: &Host, root: &Path, sha: &str) -> RepoResult<String> {
    if !SHA.is_match(sha) {
        return Err(RepoError::new(
            RepoErrorCode::InvalidArgs,
            format!("{sha} is not a commit id"),
        ));
    }
    let spec = format!("{sha}^{{commit}}");
    let result = run(
        host,
        root,
        &["rev-parse", "--verify", "--quiet", &spec],
        false,
    )
    .await;
    if result.code != 0 {
        return Err(RepoError::new(
            RepoErrorCode::UnknownCommit,
            format!("no commit {sha}"),
        ));
    }
    Ok(js_trim(&text(&result.stdout)).to_owned())
}

async fn first_parent(host: &Host, root: &Path, sha: &str) -> Option<String> {
    let spec = format!("{sha}^1");
    let result = run(
        host,
        root,
        &["rev-parse", "--verify", "--quiet", &spec],
        false,
    )
    .await;
    (result.code == 0).then(|| js_trim(&text(&result.stdout)).to_owned())
}

pub async fn commit_detail(host: &Host, root: &Path, input: &str) -> RepoResult<CommitDetail> {
    let sha = resolve_commit(host, root, input).await?;
    let format = format!("--format={LOG_FORMAT}");
    let logged = run_ok(
        host,
        root,
        &["log", "-n1", "--no-show-signature", &format, &sha],
        false,
    )
    .await?;
    let Some(summary) = parse_log(&text(&logged)).into_iter().next() else {
        return Err(RepoError::new(
            RepoErrorCode::UnknownCommit,
            format!("no commit {sha}"),
        ));
    };
    let parent = first_parent(host, root, &sha).await;
    let out = match parent.as_deref() {
        Some(parent) => {
            run_ok(
                host,
                root,
                &[
                    "diff",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--name-status",
                    "-z",
                    "-M",
                    parent,
                    &sha,
                ],
                false,
            )
            .await?
        }
        None => {
            run_ok(
                host,
                root,
                &[
                    "diff-tree",
                    "--no-commit-id",
                    "--root",
                    "-r",
                    "-z",
                    "--name-status",
                    &sha,
                ],
                false,
            )
            .await?
        }
    };
    Ok(CommitDetail {
        commit: summary,
        parent,
        files: parse_name_status(&text(&out)),
    })
}

pub async fn commit_sides(
    host: &Host,
    root: &Path,
    detail: &CommitDetail,
    file: &CommitFile,
) -> RepoResult<DiffSides> {
    let base = file.orig_path.as_deref().unwrap_or(&file.path);
    let original = match detail.parent.as_deref() {
        Some(parent) if file.code != "A" => blob(host, root, &format!("{parent}:{base}")).await?,
        _ => String::new(),
    };
    let modified = if file.code == "D" {
        String::new()
    } else {
        blob(host, root, &format!("{}:{}", detail.commit.sha, file.path)).await?
    };
    Ok(DiffSides { original, modified })
}

pub async fn blame(host: &Host, root: &Path, rel: &str) -> RepoResult<Vec<BlameLine>> {
    let out = run_ok(
        host,
        root,
        &[LITERAL, "blame", "--no-textconv", "--porcelain", "--", rel],
        false,
    )
    .await?;
    if out.len() > MAX_SIDE_BYTES * 4 {
        return Err(RepoError::new(
            RepoErrorCode::TooLarge,
            "file is too large to blame",
        ));
    }
    Ok(parse_blame_porcelain(&text(&out)))
}

pub fn pick_change<'a>(
    changes: &'a [FileChange],
    path: &str,
    preferred: Option<ChangeArea>,
) -> Option<&'a FileChange> {
    let matches: Vec<&FileChange> = changes
        .iter()
        .filter(|change| change.path == path || change.orig_path.as_deref() == Some(path))
        .collect();
    if matches.is_empty() {
        return None;
    }
    if let Some(area) = preferred {
        return matches.into_iter().find(|change| change.area == area);
    }
    const ORDER: [ChangeArea; 4] = [
        ChangeArea::Conflicted,
        ChangeArea::Unstaged,
        ChangeArea::Untracked,
        ChangeArea::Staged,
    ];
    ORDER
        .iter()
        .find_map(|area| matches.iter().find(|change| change.area == *area).copied())
        .or_else(|| matches.first().copied())
}
