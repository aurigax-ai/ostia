#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::sync::Arc;

use futures_util::future::{BoxFuture, FutureExt};
use ostia_base::host::Host;
use ostia_contract::archive_paths::archive_root;
use ostia_contract::file_browse::{BROWSE_LIMITS, BrowseLimits};
use ostia_contract::files_api::{FsBinaryResult, FsEntry, FsKind, FsTextResult};
use ostia_files::archive_file::{EntryProblem, EntryRead};
use ostia_files::archive_tree::RawEntry;
use ostia_files::archives::Archives;
use ostia_files::browse_providers::{BrowseKind, BrowseProviders, BrowseTarget, ProviderListing};
use ostia_files::file_sources::{FileSources, local_source};
use ostia_files::fs_range::FsRangeResult;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

type Confine = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

struct ZipOnly;

fn is_zip(name: &str) -> bool {
    name.ends_with(".zip")
}

fn items_of(target: &BrowseTarget) -> Vec<Value> {
    use std::os::unix::fs::FileExt;
    let mut bytes = vec![0u8; usize::try_from(target.size).unwrap()];
    target.file.read_exact_at(&mut bytes, 0).unwrap();
    let parsed: Value = serde_json::from_slice(&bytes).unwrap();
    parsed["entries"].as_array().unwrap().clone()
}

fn data_of(item: &Value) -> Vec<u8> {
    item["data"]
        .as_str()
        .unwrap_or_default()
        .as_bytes()
        .to_vec()
}

impl BrowseProviders for ZipOnly {
    fn kind_for(&self, name: &str) -> Option<BrowseKind> {
        is_zip(name).then(|| BrowseKind {
            ext_id: "archives".to_owned(),
            kind: "archives.zip".to_owned(),
        })
    }

    fn browsable(&self) -> Arc<dyn Fn(&str) -> bool + Send + Sync> {
        Arc::new(is_zip)
    }

    fn list(
        &self,
        target: BrowseTarget,
        _limits: BrowseLimits,
        _cancel: CancellationToken,
    ) -> BoxFuture<'static, ProviderListing> {
        let entries = items_of(&target)
            .iter()
            .enumerate()
            .map(|(index, item)| RawEntry {
                index,
                name: item["name"].as_str().unwrap().to_owned(),
                dir: false,
                size: data_of(item).len() as u64,
                encrypted: false,
                link: None,
            })
            .collect();
        async move {
            ProviderListing::Listed {
                entries,
                cut: false,
            }
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
        let read = match items_of(&target).get(index) {
            Some(item) => EntryRead::Ok {
                data: data_of(item),
            },
            None => EntryRead::Failed {
                problem: EntryProblem::Gone,
                size: None,
            },
        };
        async move { read }.boxed()
    }
}

fn zip_of(entries: &[(&str, &str)]) -> Vec<u8> {
    let items: Vec<Value> = entries
        .iter()
        .map(|(name, data)| json!({"name": name, "data": data}))
        .collect();
    serde_json::to_vec(&json!({"entries": items})).unwrap()
}

fn sources_in(dir: &TempDir) -> FileSources {
    let root = dir.path().canonicalize().unwrap();
    let prefix = format!("{}/", root.to_str().unwrap());
    let confine: Confine =
        Arc::new(move |path: &str| path.starts_with(&prefix).then(|| path.to_owned()));
    let providers = Arc::new(ZipOnly);
    let roots_list = vec![root.to_str().unwrap().to_owned()];
    let browsable_providers = providers.clone();
    FileSources::new(
        local_source(
            Arc::new(move || roots_list.clone()),
            confine.clone(),
            Arc::new(move || browsable_providers.browsable()),
            Host::current(),
        ),
        vec![Arc::new(Archives::new(confine, providers, BROWSE_LIMITS))],
    )
}

fn entry(name: &str, dir: bool, archive: bool) -> FsEntry {
    FsEntry {
        name: name.to_owned(),
        dir,
        archive,
        link: None,
        encrypted: false,
    }
}

fn fresh() -> (TempDir, String, FileSources) {
    let dir = TempDir::new().unwrap();
    let root = dir
        .path()
        .canonicalize()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    let sources = sources_in(&dir);
    (dir, root, sources)
}

#[tokio::test]
async fn answers_a_folder_path_from_disk_and_an_archive_path_from_inside_the_archive() {
    let (_dir, root, sources) = fresh();
    fs::create_dir(format!("{root}/sub")).unwrap();
    fs::write(format!("{root}/note.txt"), "on disk").unwrap();
    let zip = format!("{root}/bundle.zip");
    fs::write(&zip, zip_of(&[("inside.txt", "packed")])).unwrap();
    let local = sources.of(&root);
    assert!(local.watchable());
    fs::write(format!("{root}/plain.tar"), "not browsable here").unwrap();
    assert_eq!(
        local.list(&root).await,
        vec![
            entry("sub", true, false),
            entry("bundle.zip", false, true),
            entry("note.txt", false, false),
            entry("plain.tar", false, false),
        ]
    );
    assert_eq!(local.kind(&format!("{root}/sub")).await, Some(FsKind::Dir));
    assert_eq!(
        local
            .describe(&format!("{root}/note.txt"))
            .await
            .unwrap()
            .size,
        7
    );
    let entry_path = format!("{}/inside.txt", archive_root(&zip));
    let inside = sources.of(&entry_path);
    assert!(!std::ptr::addr_eq(
        Arc::as_ptr(&inside),
        Arc::as_ptr(&local)
    ));
    assert!(!inside.watchable());
    assert!(matches!(
        inside.read_text(&entry_path, 1024).await,
        FsTextResult::Ok { text, .. } if text == "packed"
    ));
    assert_eq!(inside.describe(&entry_path).await.unwrap().size, 6);
}

#[tokio::test]
async fn refuses_paths_outside_the_roots_in_both_sources() {
    let (_dir, _root, sources) = fresh();
    assert_eq!(sources.of("/etc").list("/etc").await, Vec::<FsEntry>::new());
    assert_eq!(sources.of("/etc/hosts").kind("/etc/hosts").await, None);
    let outside = format!("{}/x", archive_root("/etc/archive.zip"));
    let read = sources.of(&outside).read_binary(&outside, 1024).await;
    assert!(
        !matches!(read, FsBinaryResult::Ok { .. }),
        "read of an archive outside the roots: {read:?}"
    );
}

#[tokio::test]
async fn reads_byte_ranges_from_the_disk_and_leaves_an_archive_entry_to_full_reads() {
    let (_dir, root, sources) = fresh();
    let path = format!("{root}/clip.bin");
    fs::write(&path, "0123456789").unwrap();
    let zip = format!("{root}/bundle.zip");
    fs::write(&zip, zip_of(&[("inside.txt", "packed")])).unwrap();
    let Some(FsRangeResult::Ok { mut reader }) = sources.of(&path).read_range(&path, 2, 4).await
    else {
        panic!("no range");
    };
    assert_eq!(reader.size(), 10);
    assert_eq!(reader.read().await.unwrap(), Some(b"234".to_vec()));
    reader.close().await;
    let entry_path = format!("{}/inside.txt", archive_root(&zip));
    assert!(
        sources
            .of(&entry_path)
            .read_range(&entry_path, 0, 1)
            .await
            .is_none()
    );
}
