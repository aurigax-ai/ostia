use std::fs::{File, FileType, Metadata};
use std::future::Future;
use std::io::{self, Read, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rustix::fs::{Mode, OFlags};

#[derive(Clone, Copy, Debug)]
pub struct EntryStat {
    pub dev: u64,
    pub ino: u64,
    pub mode: u32,
    pub uid: u32,
    file_type: FileType,
}

impl EntryStat {
    fn from_metadata(metadata: &Metadata) -> Self {
        Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
            mode: metadata.mode(),
            uid: metadata.uid(),
            file_type: metadata.file_type(),
        }
    }

    pub fn is_directory(&self) -> bool {
        self.file_type.is_dir()
    }

    pub fn is_file(&self) -> bool {
        self.file_type.is_file()
    }

    pub fn is_symbolic_link(&self) -> bool {
        self.file_type.is_symlink()
    }
}

#[derive(Clone, Debug)]
pub struct OpenFile {
    file: Option<Arc<File>>,
}

impl OpenFile {
    fn handle(&self) -> io::Result<Arc<File>> {
        self.file
            .clone()
            .ok_or_else(|| io::Error::from_raw_os_error(libc::EBADF))
    }

    pub fn fd(&self) -> io::Result<i32> {
        Ok(std::os::fd::AsRawFd::as_raw_fd(&*self.handle()?))
    }

    pub async fn stat(&self) -> io::Result<EntryStat> {
        let file = self.handle()?;
        blocking(move || {
            file.metadata()
                .map(|metadata| EntryStat::from_metadata(&metadata))
        })
        .await
    }

    pub async fn read_to_end(&mut self) -> io::Result<Vec<u8>> {
        let file = self.handle()?;
        blocking(move || {
            let mut bytes = Vec::new();
            (&*file).read_to_end(&mut bytes)?;
            Ok(bytes)
        })
        .await
    }

    pub async fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        let file = self.handle()?;
        let bytes = bytes.to_vec();
        blocking(move || (&*file).write_all(&bytes)).await
    }

    pub async fn close(mut self) -> io::Result<()> {
        self.file = None;
        Ok(())
    }
}

pub trait TransferFs: Send + Sync {
    fn lstat(&self, path: &Path) -> impl Future<Output = io::Result<EntryStat>> + Send;
    fn readdir(&self, path: &Path) -> impl Future<Output = io::Result<Vec<String>>> + Send;
    fn readlink(&self, path: &Path) -> impl Future<Output = io::Result<PathBuf>> + Send;
    fn mkdir(&self, path: &Path) -> impl Future<Output = io::Result<()>> + Send;
    fn symlink(&self, target: &Path, path: &Path) -> impl Future<Output = io::Result<()>> + Send;
    fn open(
        &self,
        path: &Path,
        flags: i32,
        mode: u32,
    ) -> impl Future<Output = io::Result<OpenFile>> + Send;
    fn rename(&self, from: &Path, to: &Path) -> impl Future<Output = io::Result<()>> + Send;
    fn rmdir(&self, path: &Path) -> impl Future<Output = io::Result<()>> + Send;
    fn unlink(&self, path: &Path) -> impl Future<Output = io::Result<()>> + Send;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NodeTransferFs;

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> io::Result<T> {
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(error) => Err(io::Error::other(error)),
    }
}

impl TransferFs for NodeTransferFs {
    async fn lstat(&self, path: &Path) -> io::Result<EntryStat> {
        let path = path.to_path_buf();
        blocking(move || {
            std::fs::symlink_metadata(path).map(|metadata| EntryStat::from_metadata(&metadata))
        })
        .await
    }

    async fn readdir(&self, path: &Path) -> io::Result<Vec<String>> {
        let path = path.to_path_buf();
        blocking(move || {
            std::fs::read_dir(path)?
                .map(|entry| Ok(entry?.file_name().to_string_lossy().into_owned()))
                .collect()
        })
        .await
    }

    async fn readlink(&self, path: &Path) -> io::Result<PathBuf> {
        let path = path.to_path_buf();
        blocking(move || std::fs::read_link(path)).await
    }

    async fn mkdir(&self, path: &Path) -> io::Result<()> {
        let path = path.to_path_buf();
        blocking(move || std::fs::create_dir(path)).await
    }

    async fn symlink(&self, target: &Path, path: &Path) -> io::Result<()> {
        let (target, path) = (target.to_path_buf(), path.to_path_buf());
        blocking(move || std::os::unix::fs::symlink(target, path)).await
    }

    async fn open(&self, path: &Path, flags: i32, mode: u32) -> io::Result<OpenFile> {
        let path = path.to_path_buf();
        blocking(move || {
            let fd = rustix::fs::open(
                &path,
                OFlags::from_bits_retain(flags.cast_unsigned()),
                Mode::from_bits_truncate(mode),
            )?;
            Ok(OpenFile {
                file: Some(Arc::new(File::from(fd))),
            })
        })
        .await
    }

    async fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        let (from, to) = (from.to_path_buf(), to.to_path_buf());
        blocking(move || std::fs::rename(from, to)).await
    }

    async fn rmdir(&self, path: &Path) -> io::Result<()> {
        let path = path.to_path_buf();
        blocking(move || std::fs::remove_dir(path)).await
    }

    async fn unlink(&self, path: &Path) -> io::Result<()> {
        let path = path.to_path_buf();
        blocking(move || std::fs::remove_file(path)).await
    }
}
