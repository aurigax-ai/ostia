#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::FileExt;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures_util::future::{BoxFuture, FutureExt};
use ostia_contract::archive_paths::archive_root;
use ostia_contract::file_browse::{BROWSE_LIMITS, BrowseLimits};
use ostia_contract::files_api::{
    ArchiveEntryProblem, FsBinaryResult, FsEntry, FsKind, FsTextResult,
};
use ostia_files::archive_file::{EntryProblem, EntryRead};
use ostia_files::archive_tree::RawEntry;
use ostia_files::archives::Archives;
use ostia_files::browse_providers::{BrowseKind, BrowseProviders, BrowseTarget, ProviderListing};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

const MIB: u64 = 1024 * 1024;

struct Fake {
    lists: AtomicUsize,
}

fn kind_of(name: &str) -> Option<(&'static str, &'static str)> {
    let has = |suffixes: &[&str]| suffixes.iter().any(|s| name.ends_with(s));
    if has(&[".zip", ".jar"]) {
        Some(("archives", "archives.zip"))
    } else if has(&[".7z"]) {
        Some(("archives", "archives.sevenzip"))
    } else if has(&[".tar.xz", ".txz"]) {
        Some(("archives", "archives.tar-xz"))
    } else if has(&[".tar.bz2", ".tbz2", ".tbz"]) {
        Some(("archives", "archives.tar-bz2"))
    } else if has(&[".tar", ".tgz", ".tar.gz", ".tzst", ".tar.zst"]) {
        Some(("archives", "archives.tar"))
    } else {
        None
    }
}

fn items_of(target: &BrowseTarget) -> Result<Vec<Value>, String> {
    let mut bytes = vec![0u8; usize::try_from(target.size).unwrap()];
    target.file.read_exact_at(&mut bytes, 0).unwrap();
    let parsed: Value = serde_json::from_slice(&bytes).unwrap();
    if let Some(error) = parsed.get("error").and_then(Value::as_str) {
        return Err(error.to_owned());
    }
    Ok(parsed["entries"].as_array().unwrap().clone())
}

fn data_of(item: &Value) -> Vec<u8> {
    item["data"]
        .as_str()
        .unwrap_or_default()
        .as_bytes()
        .to_vec()
}

fn declared_size(item: &Value) -> u64 {
    item.get("size")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| data_of(item).len() as u64)
}

fn raw_of(index: usize, item: &Value) -> RawEntry {
    let name = item["name"].as_str().unwrap().to_owned();
    RawEntry {
        index,
        dir: item["dir"].as_bool().unwrap_or_else(|| name.ends_with('/')),
        size: declared_size(item),
        encrypted: item["encrypted"].as_bool().unwrap_or(false),
        link: item.get("link").and_then(Value::as_str).map(str::to_owned),
        name,
    }
}

impl BrowseProviders for Fake {
    fn kind_for(&self, name: &str) -> Option<BrowseKind> {
        kind_of(name).map(|(ext_id, kind)| BrowseKind {
            ext_id: ext_id.to_owned(),
            kind: kind.to_owned(),
        })
    }

    fn browsable(&self) -> Arc<dyn Fn(&str) -> bool + Send + Sync> {
        Arc::new(|name| kind_of(name).is_some())
    }

    fn list(
        &self,
        target: BrowseTarget,
        limits: BrowseLimits,
        _cancel: CancellationToken,
    ) -> BoxFuture<'static, ProviderListing> {
        self.lists.fetch_add(1, Ordering::SeqCst);
        let parsed = items_of(&target);
        async move {
            let items = match parsed {
                Ok(items) => items,
                Err(error) => return ProviderListing::Failed { error },
            };
            let mut total = 0u64;
            let mut entries = Vec::new();
            let mut cut = false;
            for (index, item) in items.iter().enumerate() {
                let cost = 512 + declared_size(item).div_ceil(512) * 512;
                if total + cost > limits.scan_bytes {
                    cut = true;
                    break;
                }
                total += cost;
                entries.push(raw_of(index, item));
            }
            ProviderListing::Listed { entries, cut }
        }
        .boxed()
    }

    fn read(
        &self,
        target: BrowseTarget,
        index: usize,
        _max: u64,
        _limits: BrowseLimits,
        _cancel: CancellationToken,
    ) -> BoxFuture<'static, EntryRead> {
        let read = match items_of(&target) {
            Err(_) => EntryRead::Failed {
                problem: EntryProblem::Unreadable,
                size: None,
            },
            Ok(items) => match items.get(index) {
                None => EntryRead::Failed {
                    problem: EntryProblem::Gone,
                    size: None,
                },
                Some(item) if item["limit"].as_bool().unwrap_or(false) => EntryRead::Failed {
                    problem: EntryProblem::UnzipLimit,
                    size: None,
                },
                Some(item) => EntryRead::Ok {
                    data: data_of(item),
                },
            },
        };
        async move { read }.boxed()
    }
}

struct Env {
    dir: TempDir,
    fake: Arc<Fake>,
    archives: Archives,
}

fn env_with(limits: BrowseLimits) -> Env {
    let dir = TempDir::new().unwrap();
    let prefix = format!("{}/", dir.path().to_str().unwrap());
    let fake = Arc::new(Fake {
        lists: AtomicUsize::new(0),
    });
    let archives = Archives::new(
        Arc::new(move |path: &str| path.starts_with(&prefix).then(|| path.to_owned())),
        fake.clone(),
        limits,
    );
    Env {
        dir,
        fake,
        archives,
    }
}

fn env() -> Env {
    env_with(BROWSE_LIMITS)
}

fn put(env: &Env, name: &str, entries: Vec<Value>) -> String {
    put_json(env, name, &json!({"entries": entries}))
}

fn put_json(env: &Env, name: &str, value: &Value) -> String {
    let path = env.dir.path().join(name);
    fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
    path.to_str().unwrap().to_owned()
}

fn item(name: &str, data: &str) -> Value {
    json!({"name": name, "data": data})
}

fn flagged(name: &str, data: &str, extra: Value) -> Value {
    let mut value = item(name, data);
    for (key, field) in extra.as_object().unwrap() {
        value[key] = field.clone();
    }
    value
}

fn entry(name: &str, dir: bool) -> FsEntry {
    FsEntry {
        name: name.to_owned(),
        dir,
        archive: false,
        link: None,
        encrypted: false,
    }
}

fn link_entry(name: &str, target: &str) -> FsEntry {
    FsEntry {
        link: Some(target.to_owned()),
        ..entry(name, false)
    }
}

fn names(entries: &[FsEntry]) -> Vec<&str> {
    entries.iter().map(|e| e.name.as_str()).collect()
}

fn archive_problem(reason: ArchiveEntryProblem) -> FsTextResult {
    FsTextResult::Archive { reason }
}

async fn text(archives: &Archives, path: &str) -> String {
    match archives.read_text(path, 4 * MIB).await {
        FsTextResult::Ok { text, .. } => text,
        other => panic!("not read: {other:?}"),
    }
}

#[tokio::test]
async fn lists_and_opens_a_7z_through_the_browse_protocol_refusing_links_encrypted_entries_and_what_it_cannot_read()
 {
    let env = env();
    let hello = "hello 7z\n".repeat(40);
    let second = "second file in a folder\n".repeat(10);
    let root = archive_root(&put(
        &env,
        "lzma2.7z",
        vec![
            item("src/emptydir/", ""),
            item("src/sub/b.txt", &second),
            item("src/empty.txt", ""),
            item("src/a.txt", &hello),
            flagged("src/link", "", json!({"link": "a.txt"})),
            item("src/prog.exe", "MZ"),
        ],
    ));
    let listed = env.archives.list(&format!("{root}/src")).await;
    assert_eq!(
        names(&listed),
        ["emptydir", "sub", "empty.txt", "a.txt", "link", "prog.exe"]
    );
    assert!(listed.contains(&link_entry("link", "a.txt")));
    assert_eq!(
        text(&env.archives, &format!("{root}/src/a.txt")).await,
        hello
    );
    assert_eq!(
        text(&env.archives, &format!("{root}/src/sub/b.txt")).await,
        second
    );
    assert_eq!(
        env.archives
            .read_text(&format!("{root}/src/link"), MIB)
            .await,
        archive_problem(ArchiveEntryProblem::Link)
    );
    let locked = archive_root(&put(
        &env,
        "contentenc.7z",
        vec![flagged("src/a.txt", "x", json!({"encrypted": true}))],
    ));
    assert_eq!(
        env.archives
            .read_text(&format!("{locked}/src/a.txt"), MIB)
            .await,
        archive_problem(ArchiveEntryProblem::Encrypted)
    );
    for name in ["headerenc.7z", "bcj2.7z", "ppmd.7z"] {
        let path = put_json(&env, name, &json!({"error": "unsupported"}));
        assert!(
            env.archives.list(&archive_root(&path)).await.is_empty(),
            "{name}"
        );
    }
}

#[tokio::test]
async fn lists_and_opens_a_tar_xz_and_a_tar_bz2_like_a_tar_gz_and_refuses_compression_inside_them()
{
    let env = env();
    let plain = vec![
        item("docs/", ""),
        item("docs/readme.txt", "hello"),
        flagged("passwd", "", json!({"link": "../../etc/passwd"})),
    ];
    let expected = vec![
        entry("docs", true),
        link_entry("passwd", "../../etc/passwd"),
    ];
    for name in ["a.tar.xz", "b.txz", "c.tar.bz2", "d.tbz2", "e.tar.gz"] {
        let root = archive_root(&put(&env, name, plain.clone()));
        assert_eq!(env.archives.list(&root).await, expected, "{name}");
        assert_eq!(
            text(&env.archives, &format!("{root}/docs/readme.txt")).await,
            "hello",
            "{name}"
        );
        assert_eq!(
            env.archives.read_text(&format!("{root}/passwd"), MIB).await,
            archive_problem(ArchiveEntryProblem::Link),
            "{name}"
        );
    }
    for name in [
        "gz-in-xz.tar.xz",
        "xz-in-gz.tar.gz",
        "bz2-in-gz.tar.gz",
        "gz-in-bz2.tar.bz2",
        "xz-in-xz.tar.xz",
    ] {
        let path = put_json(&env, name, &json!({"error": "unsupported"}));
        assert!(
            env.archives.list(&archive_root(&path)).await.is_empty(),
            "{name}"
        );
    }
}

#[tokio::test]
async fn lists_a_zip_and_a_tar_gz_as_the_same_tree_and_opens_entries_without_extracting() {
    let env = env();
    let files = vec![
        item("docs/readme.txt", "hello"),
        item("docs/deep/note.md", "# note"),
        item("top.csv", "a,b"),
    ];
    for name in ["bundle.zip", "bundle.tar.gz"] {
        let root = archive_root(&put(&env, name, files.clone()));
        assert_eq!(
            env.archives.list(&root).await,
            vec![entry("docs", true), entry("top.csv", false)],
            "{name}"
        );
        assert_eq!(
            env.archives.list(&format!("{root}/docs")).await,
            vec![entry("deep", true), entry("readme.txt", false)],
            "{name}"
        );
        assert_eq!(
            env.archives.kind(&format!("{root}/docs")).await,
            Some(FsKind::Dir)
        );
        assert_eq!(
            env.archives.kind(&format!("{root}/top.csv")).await,
            Some(FsKind::File)
        );
        assert_eq!(
            text(&env.archives, &format!("{root}/docs/deep/note.md")).await,
            "# note"
        );
    }
    let mut left: Vec<String> = fs::read_dir(env.dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    left.sort();
    assert_eq!(left, ["bundle.tar.gz", "bundle.zip"]);
}

#[tokio::test]
async fn shows_traversal_names_literally_and_never_reads_or_writes_a_real_path() {
    let env = env();
    let root = archive_root(&put(
        &env,
        "evil.zip",
        vec![
            item("../../etc/passwd", "inside one"),
            item("/abs/file", "inside two"),
            item("C:/x", "inside three"),
            item("bell\u{7}.txt", "inside four"),
        ],
    ));
    let listed = env.archives.list(&root).await;
    assert_eq!(names(&listed), ["..", "abs", "C:", "bell\\u0007.txt"]);
    assert_eq!(
        text(&env.archives, &format!("{root}/../../etc/passwd")).await,
        "inside one"
    );
    assert_eq!(
        text(&env.archives, &format!("{root}/abs/file")).await,
        "inside two"
    );
    assert_eq!(
        text(&env.archives, &format!("{root}/C:/x")).await,
        "inside three"
    );
    let tar = archive_root(&put(
        &env,
        "evil.tar",
        vec![item("../up.txt", "tar inside")],
    ));
    assert_eq!(names(&env.archives.list(&tar).await), [".."]);
    assert_eq!(
        text(&env.archives, &format!("{tar}/../up.txt")).await,
        "tar inside"
    );
    let mut left: Vec<String> = fs::read_dir(env.dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    left.sort();
    assert_eq!(left, ["evil.tar", "evil.zip"]);
}

#[tokio::test]
async fn refuses_a_bomb_entry_by_its_declared_size_and_by_its_real_size() {
    let env = env();
    let root = archive_root(&put(
        &env,
        "bomb.zip",
        vec![
            flagged("big.bin", "", json!({"size": 1024 * MIB})),
            flagged("liar.bin", "", json!({"size": 1024, "limit": true})),
        ],
    ));
    assert_eq!(
        env.archives
            .read_binary(&format!("{root}/big.bin"), MIB)
            .await,
        FsBinaryResult::TooLarge { size: 1024 * MIB }
    );
    assert_eq!(
        env.archives
            .read_binary(&format!("{root}/liar.bin"), MIB)
            .await,
        FsBinaryResult::Archive {
            reason: ArchiveEntryProblem::UnzipLimit
        }
    );
}

#[tokio::test]
async fn shows_links_with_their_target_and_never_follows_them() {
    let env = env();
    let zip = archive_root(&put(
        &env,
        "links.zip",
        vec![flagged(
            "shadow",
            "/etc/shadow",
            json!({"link": "/etc/shadow"}),
        )],
    ));
    assert_eq!(
        env.archives.list(&zip).await,
        vec![link_entry("shadow", "/etc/shadow")]
    );
    assert_eq!(
        env.archives.read_text(&format!("{zip}/shadow"), MIB).await,
        archive_problem(ArchiveEntryProblem::Link)
    );
    let tar = archive_root(&put(
        &env,
        "links.tgz",
        vec![flagged("passwd", "", json!({"link": "../../etc/passwd"}))],
    ));
    assert_eq!(
        env.archives.list(&tar).await,
        vec![link_entry("passwd", "../../etc/passwd")]
    );
    assert_eq!(
        env.archives.read_text(&format!("{tar}/passwd"), MIB).await,
        archive_problem(ArchiveEntryProblem::Link)
    );
}

#[tokio::test]
async fn marks_encrypted_entries_and_refuses_to_open_them() {
    let env = env();
    let root = archive_root(&put(
        &env,
        "locked.zip",
        vec![flagged("secret.txt", "x", json!({"encrypted": true}))],
    ));
    assert_eq!(
        env.archives.list(&root).await,
        vec![FsEntry {
            encrypted: true,
            ..entry("secret.txt", false)
        }]
    );
    assert_eq!(
        env.archives
            .read_text(&format!("{root}/secret.txt"), MIB)
            .await,
        archive_problem(ArchiveEntryProblem::Encrypted)
    );
}

#[tokio::test]
async fn does_not_open_an_archive_inside_an_archive() {
    let env = env();
    let inner = serde_json::to_string(&json!({"entries": [item("deep.txt", "deep")]})).unwrap();
    let root = archive_root(&put(&env, "outer.zip", vec![item("inner.zip", &inner)]));
    assert_eq!(
        env.archives.list(&root).await,
        vec![entry("inner.zip", false)]
    );
    assert!(
        env.archives
            .list(&archive_root(&format!("{root}/inner.zip")))
            .await
            .is_empty()
    );
    match env
        .archives
        .read_binary(&format!("{root}/inner.zip"), MIB)
        .await
    {
        FsBinaryResult::Ok { data } => assert_eq!(data.len(), inner.len()),
        other => panic!("not read: {other:?}"),
    }
}

#[tokio::test]
async fn stops_a_tar_listing_at_the_scan_limit_and_refuses_paths_outside_the_roots() {
    let env = env();
    let small = {
        let small = env_with(BrowseLimits {
            scan_bytes: 8 * 4608,
            ..BROWSE_LIMITS
        });
        let items: Vec<Value> = (0..20)
            .map(|i| item(&format!("f{i}.txt"), &"x".repeat(4096)))
            .collect();
        let root = archive_root(&put(&small, "many.tgz", items));
        let listed = small.archives.list(&root).await;
        listed.len()
    };
    assert!(small > 0);
    assert!(small < 20);
    assert!(
        env.archives
            .list(&archive_root("/etc/archive.zip"))
            .await
            .is_empty()
    );
    assert!(env.archives.list("archive:not-a-path").await.is_empty());
}

#[tokio::test]
async fn lists_an_archive_once_until_the_file_changes() {
    let env = env();
    let path = put(&env, "a.zip", vec![item("one.txt", "1")]);
    let root = archive_root(&path);
    assert_eq!(names(&env.archives.list(&root).await), ["one.txt"]);
    assert_eq!(names(&env.archives.list(&root).await), ["one.txt"]);
    assert_eq!(env.fake.lists.load(Ordering::SeqCst), 1);
    put(
        &env,
        "a.zip",
        vec![item("one.txt", "1"), item("two.txt", "22")],
    );
    assert_eq!(
        names(&env.archives.list(&root).await),
        ["one.txt", "two.txt"]
    );
    assert_eq!(env.fake.lists.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn drops_the_oldest_cached_archive_past_the_cache_limit() {
    let env = env();
    let roots: Vec<String> = (0..17)
        .map(|i| archive_root(&put(&env, &format!("n{i}.zip"), vec![item("f.txt", "x")])))
        .collect();
    for root in &roots {
        env.archives.list(root).await;
    }
    assert_eq!(env.fake.lists.load(Ordering::SeqCst), 17);
    env.archives.list(&roots[16]).await;
    assert_eq!(env.fake.lists.load(Ordering::SeqCst), 17);
    env.archives.list(&roots[0]).await;
    assert_eq!(env.fake.lists.load(Ordering::SeqCst), 18);
}

#[tokio::test]
async fn lists_again_after_the_cache_is_dropped() {
    let env = env();
    let root = archive_root(&put(&env, "a.zip", vec![item("one.txt", "1")]));
    env.archives.list(&root).await;
    env.archives.drop_cache();
    env.archives.list(&root).await;
    assert_eq!(env.fake.lists.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn gives_an_empty_tree_for_an_unknown_kind_a_failed_listing_or_a_missing_archive() {
    let env = env();
    let unknown = archive_root(&put(&env, "notes.txt", vec![item("a", "b")]));
    assert!(env.archives.list(&unknown).await.is_empty());
    assert_eq!(env.archives.kind(&unknown).await, None);
    assert_eq!(env.fake.lists.load(Ordering::SeqCst), 0);
    let broken = archive_root(&put_json(&env, "broken.zip", &json!({"error": "corrupt"})));
    assert!(env.archives.list(&broken).await.is_empty());
    assert_eq!(env.archives.kind(&format!("{broken}/a")).await, None);
    let missing = archive_root(&format!("{}/missing.zip", env.dir.path().to_str().unwrap()));
    assert!(env.archives.list(&missing).await.is_empty());
}

#[tokio::test]
async fn reports_a_version_and_a_stat_for_files_only() {
    let env = env();
    let path = put(&env, "a.zip", vec![item("docs/one.txt", "12345")]);
    let root = archive_root(&path);
    let file = format!("{root}/docs/one.txt");
    let version = env.archives.version(&file).await.unwrap();
    assert!(version.starts_with("archive:"));
    assert!(version.ends_with(":archives:archives.zip"));
    assert_eq!(env.archives.version(&format!("{root}/docs")).await, None);
    assert_eq!(env.archives.version(&format!("{root}/nope")).await, None);
    let stat = env.archives.describe(&file).await.unwrap();
    assert_eq!(stat.size, 5);
    assert!(stat.modified > 0.0);
    assert_eq!(env.archives.describe(&format!("{root}/docs")).await, None);
    put(&env, "a.zip", vec![item("docs/one.txt", "123456")]);
    assert_ne!(env.archives.version(&file).await.unwrap(), version);
}

#[tokio::test]
async fn reads_text_with_the_version_and_refuses_binary_content() {
    let env = env();
    let root = archive_root(&put(
        &env,
        "a.zip",
        vec![
            item("t.txt", "plain"),
            item("b.bin", "ab\u{0}cd"),
            item("late.txt", &format!("{}\u{0}", "a".repeat(8192))),
        ],
    ));
    let file = format!("{root}/t.txt");
    assert_eq!(
        env.archives.read_text(&file, MIB).await,
        FsTextResult::Ok {
            text: "plain".to_owned(),
            version: env.archives.version(&file).await.unwrap(),
        }
    );
    assert_eq!(
        env.archives.read_text(&format!("{root}/b.bin"), MIB).await,
        FsTextResult::Binary
    );
    assert!(matches!(
        env.archives
            .read_text(&format!("{root}/late.txt"), MIB)
            .await,
        FsTextResult::Ok { .. }
    ));
}

#[tokio::test]
async fn refuses_a_missing_entry_as_gone_and_a_large_entry_as_too_large() {
    let env = env();
    let root = archive_root(&put(
        &env,
        "a.zip",
        vec![item("docs/one.txt", "0123456789")],
    ));
    assert_eq!(
        env.archives.read_text(&format!("{root}/nope"), MIB).await,
        archive_problem(ArchiveEntryProblem::Gone)
    );
    assert_eq!(
        env.archives.read_text(&format!("{root}/docs"), MIB).await,
        archive_problem(ArchiveEntryProblem::Gone)
    );
    assert_eq!(
        env.archives
            .read_binary(&format!("{root}/docs/one.txt"), 4)
            .await,
        FsBinaryResult::TooLarge { size: 10 }
    );
    assert_eq!(
        env.archives.read(&format!("{root}/docs/one.txt"), 4).await,
        EntryRead::Failed {
            problem: EntryProblem::TooLarge,
            size: Some(10)
        }
    );
}

#[tokio::test]
async fn handles_only_archive_paths_and_confines_only_those_inside_a_confined_archive() {
    let env = env();
    let inside = archive_root(&format!("{}/a.zip", env.dir.path().to_str().unwrap()));
    assert!(env.archives.handles(&inside));
    assert!(!env.archives.handles("/home/u/a.zip"));
    assert_eq!(
        env.archives.confine(&format!("{inside}/x")),
        Some(format!("{inside}/x"))
    );
    assert_eq!(env.archives.confine(&archive_root("/etc/a.zip")), None);
    assert_eq!(env.archives.confine("archive:broken"), None);
    assert_eq!(env.archives.confine("/home/u/a.zip"), None);
}
