#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;

use ostia_files::fs_range::{FsRangeResult, RANGE_CHUNK_MAX, RangeReader, read_range_confined};
use tempfile::TempDir;

const MIB: usize = 1024 * 1024;

struct Fixture {
    dir: TempDir,
    outside: TempDir,
}

impl Fixture {
    fn new() -> Self {
        Self {
            dir: TempDir::new().unwrap(),
            outside: TempDir::new().unwrap(),
        }
    }

    fn path(&self, name: &str) -> String {
        self.dir.path().join(name).to_string_lossy().into_owned()
    }

    fn confine(&self) -> impl Fn(&str) -> Option<PathBuf> + use<> {
        let prefix = format!("{}/", self.dir.path().display());
        move |path| path.starts_with(&prefix).then(|| PathBuf::from(path))
    }

    async fn read(&self, path: &str, start: i64, end: i64) -> FsRangeResult {
        read_range_confined(path, start, end, self.confine()).await
    }
}

async fn drain(mut reader: RangeReader) -> Vec<Vec<u8>> {
    let mut chunks = Vec::new();
    while let Some(chunk) = reader.read().await.unwrap() {
        chunks.push(chunk);
    }
    reader.close().await;
    chunks
}

fn reader_of(result: FsRangeResult) -> RangeReader {
    match result {
        FsRangeResult::Ok { reader } => reader,
        _ => panic!("expected a reader"),
    }
}

#[tokio::test]
async fn reads_exactly_the_requested_bytes_and_reports_the_file_size() {
    let fixture = Fixture::new();
    fs::write(fixture.dir.path().join("a.bin"), "0123456789").unwrap();
    let reader = reader_of(fixture.read(&fixture.path("a.bin"), 3, 6).await);
    assert_eq!(reader.size(), 10);
    let bytes: Vec<u8> = drain(reader).await.concat();
    assert_eq!(String::from_utf8(bytes).unwrap(), "3456");
}

#[tokio::test]
async fn splits_a_long_range_into_chunks_of_at_most_1_mib() {
    let fixture = Fixture::new();
    let file = fs::File::create(fixture.dir.path().join("big.bin")).unwrap();
    file.set_len(3 * MIB as u64).unwrap();
    let end = 5 + 2 * MIB as i64 + 99;
    let reader = reader_of(fixture.read(&fixture.path("big.bin"), 5, end).await);
    let sizes: Vec<usize> = drain(reader).await.iter().map(Vec::len).collect();
    assert_eq!(sizes, vec![RANGE_CHUNK_MAX, RANGE_CHUNK_MAX, 100]);
}

#[tokio::test]
async fn refuses_paths_outside_the_roots_symlinks_folders_and_bad_bounds() {
    let fixture = Fixture::new();
    fs::write(fixture.outside.path().join("secret"), "secret").unwrap();
    fs::write(fixture.dir.path().join("a.bin"), "0123456789").unwrap();
    symlink(
        fixture.outside.path().join("secret"),
        fixture.dir.path().join("link.bin"),
    )
    .unwrap();
    fs::create_dir(fixture.dir.path().join("folder")).unwrap();
    let outside_secret = fixture
        .outside
        .path()
        .join("secret")
        .to_string_lossy()
        .into_owned();
    assert!(matches!(
        fixture.read(&outside_secret, 0, 1).await,
        FsRangeResult::Denied
    ));
    assert!(matches!(
        fixture.read(&fixture.path("link.bin"), 0, 1).await,
        FsRangeResult::Unreadable
    ));
    assert!(matches!(
        fixture.read(&fixture.path("folder"), 0, 1).await,
        FsRangeResult::Unreadable
    ));
    assert!(matches!(
        fixture.read(&fixture.path("missing"), 0, 1).await,
        FsRangeResult::Unreadable
    ));
    assert!(matches!(
        fixture.read(&fixture.path("a.bin"), 10, 12).await,
        FsRangeResult::Unsatisfiable
    ));
    assert!(matches!(
        fixture.read(&fixture.path("a.bin"), 5, 2).await,
        FsRangeResult::Unsatisfiable
    ));
    assert!(matches!(
        fixture.read(&fixture.path("a.bin"), -1, 2).await,
        FsRangeResult::Unsatisfiable
    ));
}

#[tokio::test]
async fn throws_instead_of_padding_when_the_file_shrank_and_stops_after_close() {
    let fixture = Fixture::new();
    let path = fixture.dir.path().join("shrink.bin");
    fs::write(&path, vec![0u8; 100]).unwrap();
    let mut reader = reader_of(fixture.read(&fixture.path("shrink.bin"), 0, 99).await);
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(10)
        .unwrap();
    assert!(reader.read().await.is_err());
    assert!(reader.read().await.unwrap().is_none());
}

#[tokio::test]
async fn reads_the_last_byte_of_a_file_and_ends_after_it() {
    let fixture = Fixture::new();
    fs::write(fixture.dir.path().join("a.bin"), "0123456789").unwrap();
    let reader = reader_of(fixture.read(&fixture.path("a.bin"), 9, 9).await);
    assert_eq!(drain(reader).await, vec![b"9".to_vec()]);
}

#[tokio::test]
async fn returns_nothing_after_close_and_closes_twice_without_failing() {
    let fixture = Fixture::new();
    fs::write(fixture.dir.path().join("a.bin"), "0123456789").unwrap();
    let mut reader = reader_of(fixture.read(&fixture.path("a.bin"), 0, 9).await);
    reader.close().await;
    reader.close().await;
    assert!(reader.read().await.unwrap().is_none());
}

#[tokio::test]
async fn asks_the_confine_function_first_and_checks_the_bounds_before_the_file() {
    let fixture = Fixture::new();
    assert!(matches!(
        fixture.read(&fixture.path("missing"), 5, 2).await,
        FsRangeResult::Unsatisfiable
    ));
    let denied = read_range_confined("/etc/hostname", 5, 2, |_: &str| None).await;
    assert!(matches!(denied, FsRangeResult::Denied));
}

#[tokio::test]
async fn refuses_a_bound_beyond_the_largest_safe_integer() {
    let fixture = Fixture::new();
    fs::write(fixture.dir.path().join("a.bin"), "0123456789").unwrap();
    let path = fixture.path("a.bin");
    let unsafe_bound = (1i64 << 53) + 1;
    assert!(matches!(
        fixture.read(&path, 0, unsafe_bound).await,
        FsRangeResult::Unsatisfiable
    ));
    assert!(matches!(
        fixture.read(&path, unsafe_bound, unsafe_bound + 1).await,
        FsRangeResult::Unsatisfiable
    ));
    assert!(matches!(
        fixture.read(&path, 0, i64::MAX).await,
        FsRangeResult::Unsatisfiable
    ));
}
