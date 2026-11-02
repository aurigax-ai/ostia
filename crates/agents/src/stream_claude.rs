use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::{BoxFuture, FutureExt};
use ostia_base::Error;
use ostia_contract::agent_stream::{StreamEnd, StreamEvent, last_turns, turns_started};
use ostia_contract::claude_stream::ClaudeStream;
use parking_lot::Mutex;
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, interval_at};

use crate::stream_source::{Backfill, Emit, StreamSource, StreamSourceError};
use crate::transcript_files::{read_new_lines, read_tail_window};

const TAIL_BYTES: u64 = 4 * 1024 * 1024;
const FULL_BYTES: u64 = 32 * 1024 * 1024;
const WIDEN: u64 = 4;
const TAIL_POLL: Duration = Duration::from_millis(300);
const FAILURES_MAX: usize = 20;

pub type FindTranscript = Box<dyn Fn() -> BoxFuture<'static, Option<PathBuf>> + Send + Sync>;

pub struct ClaudeSourceDeps {
    pub find: FindTranscript,
    pub session: String,
    pub closed: Box<dyn Fn(StreamEnd) + Send + Sync>,
}

#[derive(Default)]
struct State {
    parser: ClaudeStream,
    path: Option<PathBuf>,
    offset: u64,
    shown: usize,
    timer: Option<JoinHandle<()>>,
    failures: usize,
}

struct Core {
    find: FindTranscript,
    session: String,
    closed: Box<dyn Fn(StreamEnd) + Send + Sync>,
    state: Mutex<State>,
}

struct ClaudeSource {
    core: Arc<Core>,
}

pub fn claude_source(deps: ClaudeSourceDeps) -> impl StreamSource + 'static {
    ClaudeSource {
        core: Arc::new(Core {
            find: deps.find,
            session: deps.session,
            closed: deps.closed,
            state: Mutex::new(State::default()),
        }),
    }
}

fn is_missing(error: &Error) -> bool {
    matches!(error, Error::Io { source, .. } if source.kind() == std::io::ErrorKind::NotFound)
}

fn is_errno(error: &Error) -> bool {
    matches!(error, Error::Io { source, .. } if source.raw_os_error().is_some())
}

fn empty_backfill() -> Backfill {
    Backfill {
        events: Vec::new(),
        truncated: false,
    }
}

impl Core {
    async fn load(&self, turns: usize) -> ostia_base::Result<Backfill> {
        let path = (self.find)().await;
        self.state.lock().path.clone_from(&path);
        let Some(path) = path else {
            return Ok(empty_backfill());
        };
        let mut bytes = TAIL_BYTES;
        loop {
            let read = match read_tail_window(&path, bytes).await {
                Ok(read) => read,
                Err(error) if is_missing(&error) => return Ok(empty_backfill()),
                Err(error) => return Err(error),
            };
            let (events, end) = {
                let mut state = self.state.lock();
                state.parser = ClaudeStream::new();
                (state.parser.feed(&read.lines), read.end)
            };
            let enough = !read.truncated || turns_started(&events) > turns;
            if enough || bytes >= FULL_BYTES {
                self.state.lock().offset = end;
                return Ok(Backfill {
                    events: last_turns(&events, turns),
                    truncated: !enough,
                });
            }
            bytes = (bytes * WIDEN).min(FULL_BYTES);
        }
    }

    async fn poll(&self, emit: &Emit) -> ostia_base::Result<bool> {
        let known = self.state.lock().path.clone();
        let path = match known {
            Some(path) => path,
            None => {
                let found = (self.find)().await;
                self.state.lock().path.clone_from(&found);
                match found {
                    Some(path) => path,
                    None => return Ok(false),
                }
            }
        };
        let offset = self.state.lock().offset;
        let read = read_new_lines(&path, offset).await?;
        if read.reset {
            let shown = self.state.lock().shown;
            let again = self.load(shown).await?;
            let mut events = vec![StreamEvent::Session {
                session: self.session.clone(),
            }];
            events.extend(again.events);
            events.push(StreamEvent::Live);
            emit(events);
        } else {
            let events = {
                let mut state = self.state.lock();
                state.offset = read.end;
                state.parser.feed(&read.lines)
            };
            if !events.is_empty() {
                emit(events);
            }
        }
        Ok(true)
    }

    async fn run(self: Arc<Self>, emit: Emit, mut ticks: tokio::time::Interval) {
        loop {
            ticks.tick().await;
            match self.poll(&emit).await {
                Ok(true) => self.state.lock().failures = 0,
                Ok(false) => {}
                Err(error) => {
                    let errno = is_errno(&error);
                    if !errno {
                        tracing::error!(scope = "streamClaude", %error, "unexpected-error");
                    }
                    let exhausted = {
                        let mut state = self.state.lock();
                        state.failures = if errno {
                            state.failures + 1
                        } else {
                            FAILURES_MAX
                        };
                        let exhausted = state.failures >= FAILURES_MAX;
                        if exhausted {
                            state.timer = None;
                        }
                        exhausted
                    };
                    if exhausted {
                        (self.closed)(StreamEnd::Unavailable);
                        return;
                    }
                }
            }
        }
    }
}

impl StreamSource for ClaudeSource {
    fn backfill(&self, turns: usize) -> BoxFuture<'_, Result<Backfill, StreamSourceError>> {
        self.core.state.lock().shown = turns;
        let core = Arc::clone(&self.core);
        async move {
            core.load(turns)
                .await
                .map_err(|error| StreamSourceError::new(error.to_string()))
        }
        .boxed()
    }

    fn live(&self, emit: Emit) {
        let mut ticks = interval_at(Instant::now() + TAIL_POLL, TAIL_POLL);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let handle = tokio::spawn(Arc::clone(&self.core).run(emit, ticks));
        self.core.state.lock().timer = Some(handle);
    }

    fn close(&self) {
        if let Some(handle) = self.core.state.lock().timer.take() {
            handle.abort();
        }
    }
}
