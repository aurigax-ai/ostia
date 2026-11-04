#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, BorrowedFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender};

use ostia_files::at_fs::{AtFs, EntryStat};
use ostia_files::at_transfer_fs::{AtTransferFs, FD_DIR};
use ostia_files::transfer_fs::TransferFs;
use parking_lot::Mutex;
use rustix::fs::{Mode, OFlags};
use tempfile::TempDir;

const S_IFDIR: u32 = 0o040_000;

#[derive(Clone)]
struct FakeAt {
    log: Arc<Mutex<Vec<String>>>,
    open_target: Arc<PathBuf>,
    fail: bool,
    hold: Option<Arc<Hold>>,
}

struct Hold {
    entered: Mutex<Sender<()>>,
    release: Mutex<Receiver<()>>,
    seen: Mutex<Option<io::Result<u64>>>,
}

fn ino_of(dir: BorrowedFd<'_>) -> io::Result<u64> {
    Ok(File::from(dir.try_clone_to_owned()?).metadata()?.ino())
}

impl FakeAt {
    fn new(open_target: &Path) -> Self {
        Self {
            log: Arc::new(Mutex::new(Vec::new())),
            open_target: Arc::new(open_target.to_path_buf()),
            fail: false,
            hold: None,
        }
    }

    fn record(&self, line: String) -> io::Result<()> {
        self.log.lock().push(line);
        if self.fail {
            Err(io::Error::from_raw_os_error(libc::EBADF))
        } else {
            Ok(())
        }
    }

    fn calls(&self) -> Vec<String> {
        self.log.lock().clone()
    }
}

impl AtFs for FakeAt {
    fn openat(
        &self,
        dir: BorrowedFd<'_>,
        name: &str,
        flags: OFlags,
        mode: Mode,
    ) -> io::Result<OwnedFd> {
        if let Some(hold) = &self.hold {
            hold.entered.lock().send(()).unwrap();
            hold.release.lock().recv().unwrap();
            *hold.seen.lock() = Some(ino_of(dir));
        }
        self.record(format!(
            "openat {} {name} {} {:o}",
            ino_of(dir)?,
            flags.bits(),
            mode.bits()
        ))?;
        Ok(File::options()
            .read(true)
            .write(true)
            .open(&*self.open_target)?
            .into())
    }

    fn lstatat(&self, dir: BorrowedFd<'_>, name: &str) -> io::Result<EntryStat> {
        self.record(format!("lstatat {} {name}", ino_of(dir)?))?;
        Ok(EntryStat {
            dev: 11,
            ino: 22,
            mode: S_IFDIR | 0o755,
            uid: 33,
        })
    }

    fn mkdirat(&self, dir: BorrowedFd<'_>, name: &str) -> io::Result<()> {
        self.record(format!("mkdirat {} {name}", ino_of(dir)?))
    }

    fn symlinkat(&self, target: &str, dir: BorrowedFd<'_>, name: &str) -> io::Result<()> {
        self.record(format!("symlinkat {target} {} {name}", ino_of(dir)?))
    }

    fn readlinkat(&self, dir: BorrowedFd<'_>, name: &str) -> io::Result<String> {
        self.record(format!("readlinkat {} {name}", ino_of(dir)?))?;
        Ok("link-target".to_owned())
    }

    fn renameat(
        &self,
        from_dir: BorrowedFd<'_>,
        from: &str,
        to_dir: BorrowedFd<'_>,
        to: &str,
    ) -> io::Result<()> {
        self.record(format!(
            "renameat {} {from} {} {to}",
            ino_of(from_dir)?,
            ino_of(to_dir)?
        ))
    }

    fn unlinkat(&self, dir: BorrowedFd<'_>, name: &str, folder: bool) -> io::Result<()> {
        self.record(format!("unlinkat {} {name} {folder}", ino_of(dir)?))
    }

    fn list(&self, dir: BorrowedFd<'_>) -> io::Result<Vec<String>> {
        self.record(format!("list {}", ino_of(dir)?))?;
        Ok(vec!["one".to_owned(), "two".to_owned()])
    }

    fn path_of(&self, fd: BorrowedFd<'_>) -> io::Result<String> {
        self.record(format!("path_of {}", ino_of(fd)?))?;
        Ok("/the/folder".to_owned())
    }
}

struct Fixture {
    tmp: TempDir,
    dir: File,
    fake: FakeAt,
}

impl Fixture {
    fn new() -> Self {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("target.txt"), "hello").unwrap();
        let dir = File::open(tmp.path()).unwrap();
        let fake = FakeAt::new(&tmp.path().join("target.txt"));
        Self { tmp, dir, fake }
    }

    fn fs(&self) -> AtTransferFs<FakeAt> {
        AtTransferFs::new(self.fake.clone())
    }

    fn fd(&self) -> i32 {
        self.dir.as_raw_fd()
    }

    fn ino(&self) -> u64 {
        self.dir.metadata().unwrap().ino()
    }

    fn at(&self, name: &str) -> PathBuf {
        PathBuf::from(format!("{FD_DIR}/{}/{name}", self.fd()))
    }

    fn bare(&self) -> PathBuf {
        PathBuf::from(format!("{FD_DIR}/{}", self.fd()))
    }
}

#[test]
fn names_the_fd_folder_as_dev_fd() {
    assert_eq!(FD_DIR, "/dev/fd");
}

#[tokio::test]
async fn lstat_of_an_fd_relative_name_goes_to_lstatat_and_keeps_the_stat() {
    let fx = Fixture::new();
    let stat = fx.fs().lstat(&fx.at("entry")).await.unwrap();
    assert_eq!(fx.fake.calls(), [format!("lstatat {} entry", fx.ino())]);
    assert_eq!((stat.dev, stat.ino, stat.uid), (11, 22, 33));
    assert_eq!(stat.mode, S_IFDIR | 0o755);
    assert!(stat.is_directory());
    assert!(!stat.is_file());
}

#[tokio::test]
async fn lstat_of_a_plain_path_goes_to_the_real_file_system() {
    let fx = Fixture::new();
    let stat = fx
        .fs()
        .lstat(&fx.tmp.path().join("target.txt"))
        .await
        .unwrap();
    assert!(stat.is_file());
    assert!(fx.fake.calls().is_empty());
}

#[tokio::test]
async fn readdir_of_an_fd_lists_that_folder_through_the_seam() {
    let fx = Fixture::new();
    let names = fx.fs().readdir(&fx.bare()).await.unwrap();
    assert_eq!(names, ["one", "two"]);
    assert_eq!(fx.fake.calls(), [format!("list {}", fx.ino())]);
}

#[tokio::test]
async fn readdir_of_an_fd_with_a_name_still_lists_the_fd_folder_as_ts_does() {
    let fx = Fixture::new();
    let names = fx.fs().readdir(&fx.at("ignored")).await.unwrap();
    assert_eq!(names, ["one", "two"]);
    assert_eq!(fx.fake.calls(), [format!("list {}", fx.ino())]);
}

#[tokio::test]
async fn readdir_of_a_plain_path_goes_to_the_real_file_system() {
    let fx = Fixture::new();
    let names = fx.fs().readdir(fx.tmp.path()).await.unwrap();
    assert_eq!(names, ["target.txt"]);
    assert!(fx.fake.calls().is_empty());
}

#[tokio::test]
async fn readlink_of_a_bare_fd_asks_for_the_path_of_the_fd() {
    let fx = Fixture::new();
    let path = fx.fs().readlink(&fx.bare()).await.unwrap();
    assert_eq!(path, Path::new("/the/folder"));
    assert_eq!(fx.fake.calls(), [format!("path_of {}", fx.ino())]);
}

#[tokio::test]
async fn readlink_of_an_fd_relative_name_goes_to_readlinkat() {
    let fx = Fixture::new();
    let path = fx.fs().readlink(&fx.at("link")).await.unwrap();
    assert_eq!(path, Path::new("link-target"));
    assert_eq!(fx.fake.calls(), [format!("readlinkat {} link", fx.ino())]);
}

#[tokio::test]
async fn mkdir_and_symlink_of_an_fd_relative_name_go_to_the_seam() {
    let fx = Fixture::new();
    let fs = fx.fs();
    fs.mkdir(&fx.at("made")).await.unwrap();
    fs.symlink(Path::new("../there"), &fx.at("ln"))
        .await
        .unwrap();
    assert_eq!(
        fx.fake.calls(),
        [
            format!("mkdirat {} made", fx.ino()),
            format!("symlinkat ../there {} ln", fx.ino()),
        ]
    );
}

#[tokio::test]
async fn mkdir_and_symlink_of_a_bare_fd_go_to_the_real_file_system_and_not_the_seam() {
    let fx = Fixture::new();
    let fs = fx.fs();
    let _ = fs.mkdir(&fx.bare()).await;
    let _ = fs.symlink(Path::new("x"), &fx.bare()).await;
    assert!(fx.fake.calls().is_empty());
}

#[tokio::test]
async fn rmdir_removes_a_folder_and_unlink_removes_a_non_folder_through_unlinkat() {
    let fx = Fixture::new();
    let fs = fx.fs();
    fs.rmdir(&fx.at("old-dir")).await.unwrap();
    fs.unlink(&fx.at("old-file")).await.unwrap();
    assert_eq!(
        fx.fake.calls(),
        [
            format!("unlinkat {} old-dir true", fx.ino()),
            format!("unlinkat {} old-file false", fx.ino()),
        ]
    );
}

#[tokio::test]
async fn open_of_an_fd_relative_name_passes_flags_and_mode_to_openat_and_wraps_the_fd() {
    let fx = Fixture::new();
    let flags = libc::O_RDWR | libc::O_CREAT;
    let mut file = fx.fs().open(&fx.at("data"), flags, 0o600).await.unwrap();
    assert_eq!(
        fx.fake.calls(),
        [format!("openat {} data {flags} 600", fx.ino())]
    );
    assert_eq!(file.read_to_end().await.unwrap(), b"hello");
    file.write_all(b"!").await.unwrap();
    assert!(file.stat().await.unwrap().is_file());
    file.close().await.unwrap();
    assert_eq!(
        std::fs::read_to_string(fx.tmp.path().join("target.txt")).unwrap(),
        "hello!"
    );
}

#[tokio::test]
async fn open_of_a_plain_path_goes_to_the_real_file_system() {
    let fx = Fixture::new();
    let mut file = fx
        .fs()
        .open(&fx.tmp.path().join("target.txt"), libc::O_RDONLY, 0o666)
        .await
        .unwrap();
    assert_eq!(file.read_to_end().await.unwrap(), b"hello");
    assert!(fx.fake.calls().is_empty());
}

#[tokio::test]
async fn rename_between_two_fd_relative_names_goes_to_renameat() {
    let fx = Fixture::new();
    fx.fs().rename(&fx.at("from"), &fx.at("to")).await.unwrap();
    assert_eq!(
        fx.fake.calls(),
        [format!("renameat {} from {} to", fx.ino(), fx.ino())]
    );
}

#[tokio::test]
async fn rename_goes_to_the_real_file_system_when_either_side_is_not_an_fd_relative_name() {
    let fx = Fixture::new();
    let fs = fx.fs();
    let plain = fx.tmp.path().join("target.txt");
    let moved = fx.tmp.path().join("moved.txt");
    fs.rename(&plain, &moved).await.unwrap();
    assert!(moved.exists());
    assert!(fs.rename(&fx.at("absent"), &plain).await.is_err());
    assert!(fs.rename(&moved, &fx.bare()).await.is_err());
    assert!(fx.fake.calls().is_empty());
}

#[tokio::test]
async fn takes_a_path_as_fd_relative_only_when_it_is_dev_fd_digits_and_one_name() {
    let fx = Fixture::new();
    let fs = fx.fs();
    let fd = fx.fd();
    for path in [
        format!("{FD_DIR}/{fd}/a/b"),
        format!("{FD_DIR}/x{fd}/name"),
        format!("{FD_DIR}/-{fd}/name"),
        format!("{FD_DIR}//name"),
        format!("/dev/fdx/{fd}/name"),
        format!("/dev/{fd}/name"),
        FD_DIR.to_owned(),
    ] {
        let _ = fs.lstat(Path::new(&path)).await;
        assert!(fx.fake.calls().is_empty(), "{path}");
    }
}

#[tokio::test]
async fn reads_leading_zeros_in_the_fd_number_and_an_empty_name_after_a_trailing_slash() {
    let fx = Fixture::new();
    let fs = fx.fs();
    fs.lstat(Path::new(&format!("{FD_DIR}/000{}/name", fx.fd())))
        .await
        .unwrap();
    fs.lstat(Path::new(&format!("{FD_DIR}/{}/", fx.fd())))
        .await
        .unwrap();
    assert_eq!(
        fx.fake.calls(),
        [
            format!("lstatat {} name", fx.ino()),
            format!("lstatat {} ", fx.ino()),
        ]
    );
}

#[tokio::test]
async fn passes_an_error_from_the_seam_on_unchanged() {
    let mut fx = Fixture::new();
    fx.fake.fail = true;
    let fs = fx.fs();
    let error = fs.lstat(&fx.at("x")).await.unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::EBADF));
    let error = fs.readdir(&fx.bare()).await.unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::EBADF));
    let error = fs.unlink(&fx.at("x")).await.unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::EBADF));
    let error = fs
        .open(&fx.at("x"), libc::O_RDONLY, 0o666)
        .await
        .map(|_| ())
        .unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::EBADF));
}

#[tokio::test]
async fn keeps_the_folder_open_for_a_job_after_the_caller_closes_its_descriptor() {
    let mut fx = Fixture::new();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let hold = Arc::new(Hold {
        entered: Mutex::new(entered_tx),
        release: Mutex::new(release_rx),
        seen: Mutex::new(None),
    });
    fx.fake.hold = Some(Arc::clone(&hold));
    let expected = fx.ino();
    let path = fx.at("data");
    let fs = fx.fs();
    let job = tokio::spawn(async move { fs.open(&path, libc::O_RDONLY, 0).await.map(|_| ()) });
    tokio::task::spawn_blocking(move || entered_rx.recv().unwrap())
        .await
        .unwrap();
    let Fixture { dir, .. } = fx;
    drop(dir);
    release_tx.send(()).unwrap();
    job.await.unwrap().unwrap();
    let seen = hold.seen.lock().take().unwrap();
    assert_eq!(seen.unwrap(), expected);
}
