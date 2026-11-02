use std::collections::{BTreeMap, VecDeque};
use std::fs::{DirBuilder, File, OpenOptions};
use std::future::Future;
use std::os::unix::fs::{DirBuilderExt, FileExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ostia_base::OwnerThread;
use ostia_base::js::utf16_len;
use parking_lot::Mutex;
use tokio::runtime::Handle;
use tokio::sync::oneshot;

use crate::history_records::{HistoryKey, open_lines, seal_lines};

pub const RECORD_BYTES: usize = 256 * 1024;
const SEGMENT_BYTES: u64 = 16 * 1024 * 1024;
const IDLE_FLUSH: Duration = Duration::from_millis(1000);
const MAX_BLOCKS: usize = 20_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryBlock {
    pub seq: u64,
    pub start: u64,
    pub end: Option<u64>,
    pub end_col: u64,
    pub exit_code: Option<i32>,
    pub command: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct HistoryChunk {
    pub first: u64,
    pub lines: Vec<String>,
}

impl std::fmt::Debug for HistoryChunk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HistoryChunk")
            .field("first", &self.first)
            .field("lines", &self.lines.len())
            .finish()
    }
}

type LimitBytes = Arc<dyn Fn() -> Option<u64> + Send + Sync>;
type EnsureSpace = Arc<dyn Fn(&PaneHistory) -> bool + Send + Sync>;
type OnFailed = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone)]
pub struct PaneHistoryDeps {
    pub dir: PathBuf,
    pub key: HistoryKey,
    pub limit_bytes: LimitBytes,
    pub ensure_space: EnsureSpace,
    pub on_failed: OnFailed,
    pub segment_bytes: Option<u64>,
}

struct Segment {
    id: u64,
    path: PathBuf,
    size: u64,
    file: Arc<File>,
}

#[derive(Clone)]
struct StoredChunk {
    first: u64,
    count: u64,
    segment: u64,
    path: PathBuf,
    offset: u64,
    length: usize,
}

struct Pending {
    id: u64,
    first: u64,
    count: u64,
    batches: Vec<String>,
    bytes: usize,
}

#[derive(Default)]
struct Inner {
    first: u64,
    end: u64,
    bytes: i64,
    seq_offset: u64,
    failure: Option<String>,
    stored: Vec<StoredChunk>,
    unwritten: Vec<Pending>,
    open: Option<u64>,
    segments: Vec<Segment>,
    blocks: BTreeMap<u64, HistoryBlock>,
    generation: u64,
    next_segment: u64,
    next_segment_id: u64,
    next_chunk: u64,
    timer: Option<u64>,
    timer_generation: u64,
    disposed: bool,
}

struct Shared {
    inner: Mutex<Inner>,
    deps: PaneHistoryDeps,
    worker: Mutex<Option<OwnerThread<()>>>,
    runtime: Option<Handle>,
}

#[derive(Clone)]
pub struct PaneHistory {
    shared: Arc<Shared>,
}

pub fn errno_code(err: &std::io::Error) -> String {
    let named = match err.raw_os_error() {
        Some(libc::ENOENT) => "ENOENT",
        Some(libc::EACCES) => "EACCES",
        Some(libc::EEXIST) => "EEXIST",
        Some(libc::ENOSPC) => "ENOSPC",
        Some(libc::EPERM) => "EPERM",
        Some(libc::EISDIR) => "EISDIR",
        Some(libc::ENOTDIR) => "ENOTDIR",
        Some(libc::ENOTEMPTY) => "ENOTEMPTY",
        Some(libc::EROFS) => "EROFS",
        Some(libc::EMFILE) => "EMFILE",
        Some(libc::ENFILE) => "ENFILE",
        Some(libc::EIO) => "EIO",
        Some(libc::EBUSY) => "EBUSY",
        Some(libc::EDQUOT) => "EDQUOT",
        Some(libc::ENAMETOOLONG) => "ENAMETOOLONG",
        Some(libc::EINVAL) => "EINVAL",
        _ => return err.to_string(),
    };
    named.to_string()
}

fn remove_segments(segments: Vec<Segment>) {
    for segment in segments {
        let path = segment.path.clone();
        drop(segment);
        let _ = std::fs::remove_file(path);
    }
}

fn overlaps(first: u64, count: u64, from: u64, until: u64) -> bool {
    first + count > from && first < until
}

impl PaneHistory {
    pub fn new(deps: PaneHistoryDeps) -> Self {
        Self {
            shared: Arc::new(Shared {
                inner: Mutex::new(Inner::default()),
                deps,
                worker: Mutex::new(None),
                runtime: Handle::try_current().ok(),
            }),
        }
    }

    pub fn same_as(&self, other: &PaneHistory) -> bool {
        Arc::ptr_eq(&self.shared, &other.shared)
    }

    pub fn first(&self) -> u64 {
        self.shared.inner.lock().first
    }

    pub fn end(&self) -> u64 {
        self.shared.inner.lock().end
    }

    pub fn bytes(&self) -> i64 {
        self.shared.inner.lock().bytes
    }

    pub fn seq_offset(&self) -> u64 {
        self.shared.inner.lock().seq_offset
    }

    pub fn set_seq_offset(&self, value: u64) {
        self.shared.inner.lock().seq_offset = value;
    }

    pub fn failure(&self) -> Option<String> {
        self.shared.inner.lock().failure.clone()
    }

    pub fn live(&self) -> bool {
        let inner = self.shared.inner.lock();
        !inner.disposed && inner.failure.is_none()
    }

    pub fn droppable(&self) -> bool {
        self.shared.inner.lock().segments.len() > 1
    }

    pub fn append(&self, batch: &str, count: u64) {
        let flush_now = {
            let mut inner = self.shared.inner.lock();
            if inner.disposed || inner.failure.is_some() || count == 0 {
                return;
            }
            let open_id = match inner.open {
                Some(id) => id,
                None => {
                    let id = inner.next_chunk;
                    inner.next_chunk += 1;
                    let first = inner.end;
                    inner.unwritten.push(Pending {
                        id,
                        first,
                        count: 0,
                        batches: Vec::new(),
                        bytes: 0,
                    });
                    inner.open = Some(id);
                    id
                }
            };
            let mut full = false;
            if let Some(chunk) = inner.unwritten.iter_mut().find(|c| c.id == open_id) {
                chunk.batches.push(batch.to_string());
                chunk.count += count;
                chunk.bytes += utf16_len(batch) + 1;
                full = chunk.bytes >= RECORD_BYTES;
            }
            inner.end += count;
            if !full {
                self.arm_timer(&mut inner);
            }
            full
        };
        if flush_now {
            drop(self.start_flush());
        }
    }

    pub fn flush(&self) -> impl Future<Output = ()> + Send + use<> {
        let done = self.start_flush();
        async move {
            let _ = done.await;
        }
    }

    pub fn block_started(&self, seq: u64, start: u64, command: Option<&str>) {
        let mut inner = self.shared.inner.lock();
        if inner.disposed || inner.failure.is_some() {
            return;
        }
        inner.blocks.insert(
            seq,
            HistoryBlock {
                seq,
                start,
                end: None,
                end_col: 0,
                exit_code: None,
                command: command.map(ToString::to_string),
            },
        );
        if inner.blocks.len() > MAX_BLOCKS
            && let Some(oldest) = inner.blocks.keys().next().copied()
        {
            inner.blocks.remove(&oldest);
        }
    }

    pub fn block_ended(
        &self,
        seq: u64,
        end: u64,
        end_col: u64,
        exit_code: i32,
        command: Option<&str>,
    ) {
        let mut inner = self.shared.inner.lock();
        let Some(block) = inner.blocks.get_mut(&seq) else {
            return;
        };
        block.end = Some(end);
        block.end_col = end_col;
        block.exit_code = Some(exit_code);
        if let Some(command) = command.filter(|text| !text.is_empty()) {
            block.command = Some(command.to_string());
        }
    }

    pub fn block(&self, seq: u64) -> Option<HistoryBlock> {
        let inner = self.shared.inner.lock();
        inner
            .blocks
            .get(&seq)
            .filter(|block| block.start >= inner.first)
            .cloned()
    }

    pub fn chunks(&self, from: u64, until: u64) -> ChunkStream {
        let inner = self.shared.inner.lock();
        let stored = inner
            .stored
            .iter()
            .filter(|c| overlaps(c.first, c.count, from, until))
            .cloned()
            .collect();
        let pending = inner
            .unwritten
            .iter()
            .filter(|c| overlaps(c.first, c.count, from, until))
            .map(|c| HistoryChunk {
                first: c.first,
                lines: c
                    .batches
                    .join("\n")
                    .split('\n')
                    .map(ToString::to_string)
                    .collect(),
            })
            .collect();
        ChunkStream {
            history: self.clone(),
            generation: inner.generation,
            stored,
            pending,
        }
    }

    pub async fn read(&self, from: u64, count: u64) -> Vec<String> {
        let (start, stop) = {
            let inner = self.shared.inner.lock();
            (
                from.max(inner.first),
                inner.end.min(from.saturating_add(count)),
            )
        };
        let mut out = Vec::new();
        if stop <= start {
            return out;
        }
        let mut stream = self.chunks(start, stop);
        while let Some(chunk) = stream.next().await {
            let length = u64::try_from(chunk.lines.len()).unwrap_or(u64::MAX);
            let a = start.max(chunk.first) - chunk.first;
            let b = stop.min(chunk.first + length).saturating_sub(chunk.first);
            if a < b {
                let from_index = usize::try_from(a).unwrap_or(usize::MAX);
                let to_index = usize::try_from(b).unwrap_or(usize::MAX);
                out.extend(chunk.lines[from_index..to_index].iter().cloned());
            }
        }
        out
    }

    pub fn wipe(&self) {
        let old = {
            let mut inner = self.shared.inner.lock();
            inner.timer = None;
            inner.generation += 1;
            inner.open = None;
            inner.unwritten.clear();
            inner.stored.clear();
            inner.blocks.clear();
            inner.first = inner.end;
            inner.bytes = 0;
            std::mem::take(&mut inner.segments)
        };
        drop(self.enqueue(move || remove_segments(old)));
    }

    pub fn drop_oldest_segment(&self) {
        let removed = {
            let mut inner = self.shared.inner.lock();
            if inner.segments.len() <= 1 {
                return;
            }
            let segment = inner.segments.remove(0);
            inner.stored.retain(|c| c.segment != segment.id);
            inner.bytes -= i64::try_from(segment.size).unwrap_or(i64::MAX);
            inner.first = inner
                .stored
                .first()
                .map(|c| c.first)
                .or_else(|| inner.unwritten.first().map(|c| c.first))
                .unwrap_or(inner.end);
            let first = inner.first;
            let stale: Vec<u64> = inner
                .blocks
                .iter()
                .take_while(|(_, block)| block.start < first)
                .map(|(seq, _)| *seq)
                .collect();
            for seq in stale {
                inner.blocks.remove(&seq);
            }
            segment
        };
        remove_segments(vec![removed]);
    }

    pub fn dispose(&self) -> impl Future<Output = ()> + Send + use<> {
        let done = self.start_dispose();
        async move {
            let _ = done.await;
        }
    }

    pub fn start_dispose(&self) -> oneshot::Receiver<()> {
        let already = {
            let mut inner = self.shared.inner.lock();
            let was = inner.disposed;
            inner.disposed = true;
            was
        };
        if already {
            return self.enqueue(|| {});
        }
        self.wipe();
        let dir = self.shared.deps.dir.clone();
        self.enqueue(move || match std::fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                tracing::warn!(code = %errno_code(&err), "history-dispose-failed");
            }
        })
    }

    pub fn fail(&self, reason: &str) {
        {
            let mut inner = self.shared.inner.lock();
            if inner.disposed || inner.failure.is_some() {
                return;
            }
            inner.failure = Some(reason.to_string());
        }
        (self.shared.deps.on_failed)(reason);
        self.wipe();
    }

    fn start_flush(&self) -> oneshot::Receiver<()> {
        let job = {
            let mut inner = self.shared.inner.lock();
            inner.timer = None;
            inner.open.take().and_then(|id| {
                inner
                    .unwritten
                    .iter()
                    .find(|c| c.id == id)
                    .map(|c| (c.id, c.first, c.count, c.batches.clone(), inner.generation))
            })
        };
        let history = self.clone();
        self.enqueue(move || {
            if let Some((id, first, count, batches, generation)) = job {
                history.write_chunk(id, first, count, &batches, generation);
            }
        })
    }

    fn enqueue<F>(&self, job: F) -> oneshot::Receiver<()>
    where
        F: FnOnce() + Send + 'static,
    {
        let (done, receiver) = oneshot::channel();
        let worker = {
            let mut slot = self.shared.worker.lock();
            if slot.is_none() {
                match OwnerThread::spawn("pane-history", || ()) {
                    Ok(owner) => *slot = Some(owner),
                    Err(err) => {
                        tracing::error!(code = %errno_code(&err), "history-worker-failed");
                    }
                }
            }
            slot.clone()
        };
        if let Some(worker) = worker {
            let _ = worker.post(move |()| {
                job();
                let _ = done.send(());
            });
        }
        receiver
    }

    fn arm_timer(&self, inner: &mut Inner) {
        if inner.timer.is_some() {
            return;
        }
        let Some(runtime) = &self.shared.runtime else {
            return;
        };
        inner.timer_generation += 1;
        let generation = inner.timer_generation;
        inner.timer = Some(generation);
        let history = self.clone();
        runtime.spawn(async move {
            tokio::time::sleep(IDLE_FLUSH).await;
            let due = {
                let mut inner = history.shared.inner.lock();
                if inner.timer == Some(generation) {
                    inner.timer = None;
                    true
                } else {
                    false
                }
            };
            if due {
                drop(history.start_flush());
            }
        });
    }

    fn write_chunk(&self, id: u64, first: u64, count: u64, batches: &[String], generation: u64) {
        if count == 0 {
            return;
        }
        let outcome = self.try_write_chunk(id, first, count, batches, generation);
        if let Err(reason) = outcome {
            self.fail(&reason);
        }
    }

    fn current(&self, generation: u64) -> bool {
        self.shared.inner.lock().generation == generation
    }

    fn try_write_chunk(
        &self,
        id: u64,
        first: u64,
        count: u64,
        batches: &[String],
        generation: u64,
    ) -> Result<(), String> {
        let sealed = seal_lines(&self.shared.deps.key, batches).map_err(|err| err.to_string())?;
        if !self.current(generation) {
            return Ok(());
        }
        let length = u64::try_from(sealed.len()).unwrap_or(u64::MAX);
        let (segment_id, path, file, offset) = self.segment_for(length)?;
        {
            let mut inner = self.shared.inner.lock();
            if let Some(segment) = inner.segments.iter_mut().find(|s| s.id == segment_id) {
                segment.size += length;
            }
        }
        file.write_all_at(&sealed, offset)
            .map_err(|err| errno_code(&err))?;
        {
            let mut inner = self.shared.inner.lock();
            if inner.generation != generation {
                return Ok(());
            }
            inner.stored.push(StoredChunk {
                first,
                count,
                segment: segment_id,
                path,
                offset,
                length: sealed.len(),
            });
            inner.unwritten.retain(|c| c.id != id);
            inner.bytes += i64::try_from(length).unwrap_or(i64::MAX);
        }
        self.enforce_limit();
        Ok(())
    }

    fn segment_for(&self, length: u64) -> Result<(u64, PathBuf, Arc<File>, u64), String> {
        let limit = self.shared.deps.segment_bytes.unwrap_or(SEGMENT_BYTES);
        {
            let inner = self.shared.inner.lock();
            if let Some(last) = inner.segments.last()
                && last.size + length <= limit
            {
                return Ok((last.id, last.path.clone(), last.file.clone(), last.size));
            }
        }
        if !(self.shared.deps.ensure_space)(self) {
            return Err("disk-full".to_string());
        }
        if self.shared.inner.lock().disposed {
            return Err("disposed".to_string());
        }
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.shared.deps.dir)
            .map_err(|err| errno_code(&err))?;
        let (number, segment_id) = {
            let mut inner = self.shared.inner.lock();
            let number = inner.next_segment;
            inner.next_segment += 1;
            let id = inner.next_segment_id;
            inner.next_segment_id += 1;
            (number, id)
        };
        let path = self.shared.deps.dir.join(format!("{number:06}.seg"));
        let file = Arc::new(
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
                .map_err(|err| errno_code(&err))?,
        );
        self.shared.inner.lock().segments.push(Segment {
            id: segment_id,
            path: path.clone(),
            size: 0,
            file: file.clone(),
        });
        Ok((segment_id, path, file, 0))
    }

    fn enforce_limit(&self) {
        let Some(limit) = (self.shared.deps.limit_bytes)() else {
            return;
        };
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        loop {
            let over = {
                let inner = self.shared.inner.lock();
                inner.bytes > limit && inner.segments.len() > 1
            };
            if !over {
                return;
            }
            self.drop_oldest_segment();
        }
    }
}

pub struct ChunkStream {
    history: PaneHistory,
    generation: u64,
    stored: VecDeque<StoredChunk>,
    pending: VecDeque<HistoryChunk>,
}

impl ChunkStream {
    pub async fn next(&mut self) -> Option<HistoryChunk> {
        if !self.history.current(self.generation) {
            return None;
        }
        if let Some(chunk) = self.stored.pop_front() {
            let key = self.history.shared.deps.key;
            let first = chunk.first;
            let lines = tokio::task::spawn_blocking(move || read_chunk(&key, &chunk))
                .await
                .unwrap_or_default();
            return Some(HistoryChunk { first, lines });
        }
        self.pending.pop_front()
    }
}

fn read_chunk(key: &HistoryKey, chunk: &StoredChunk) -> Vec<String> {
    let blank = || vec![String::new(); usize::try_from(chunk.count).unwrap_or(0)];
    let read = |path: &Path| -> std::io::Result<Vec<u8>> {
        let file = File::open(path)?;
        let mut buffer = vec![0u8; chunk.length];
        file.read_exact_at(&mut buffer, chunk.offset)?;
        Ok(buffer)
    };
    match read(&chunk.path) {
        Ok(buffer) => open_lines(key, &buffer).unwrap_or_else(|_| blank()),
        Err(_) => blank(),
    }
}
