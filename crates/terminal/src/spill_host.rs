use std::collections::HashMap;
use std::fmt;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use ostia_base::OwnerThread;

pub use crate::history_spill::BlockEnd;
use crate::history_spill::SpillSink;
use crate::spill_terminal::SpillTerminal;

#[derive(Clone, PartialEq, Eq)]
pub enum SpillRequest {
    Open {
        session: u64,
        cols: u16,
        rows: u16,
        end: u64,
        seq_offset: u64,
    },
    Write {
        session: u64,
        data: Vec<u8>,
        chars: usize,
    },
    Resync {
        session: u64,
        screen: String,
    },
    Restore {
        session: u64,
        history: String,
        hold: bool,
    },
    Resize {
        session: u64,
        cols: u16,
        rows: u16,
    },
    Tail {
        session: u64,
        id: u64,
    },
    PendingEnd {
        session: u64,
        seq: u64,
        id: u64,
    },
    Close {
        session: u64,
    },
}

#[derive(Clone, PartialEq, Eq)]
pub enum SpillEvent {
    Append {
        session: u64,
        text: String,
        count: u64,
    },
    BlockStarted {
        session: u64,
        seq: u64,
        start: u64,
        command: Option<String>,
    },
    BlockEnded {
        session: u64,
        seq: u64,
        end: u64,
        end_col: u64,
        exit_code: i32,
        command: Option<String>,
    },
    Wipe {
        session: u64,
    },
    Flush {
        session: u64,
    },
    Parsed {
        session: u64,
        chars: usize,
    },
    Closed {
        session: u64,
        seq_end: u64,
    },
    Failed {
        session: u64,
        reason: String,
    },
    Reply {
        id: u64,
        tail: Option<Vec<String>>,
        pending_end: Option<Option<BlockEnd>>,
    },
}

impl fmt::Debug for SpillRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Open {
                session,
                cols,
                rows,
                end,
                seq_offset,
            } => f
                .debug_struct("Open")
                .field("session", session)
                .field("cols", cols)
                .field("rows", rows)
                .field("end", end)
                .field("seq_offset", seq_offset)
                .finish(),
            Self::Write {
                session,
                data,
                chars,
            } => f
                .debug_struct("Write")
                .field("session", session)
                .field("bytes", &data.len())
                .field("chars", chars)
                .finish(),
            Self::Resync { session, screen } => f
                .debug_struct("Resync")
                .field("session", session)
                .field("bytes", &screen.len())
                .finish(),
            Self::Restore {
                session,
                history,
                hold,
            } => f
                .debug_struct("Restore")
                .field("session", session)
                .field("bytes", &history.len())
                .field("hold", hold)
                .finish(),
            Self::Resize {
                session,
                cols,
                rows,
            } => f
                .debug_struct("Resize")
                .field("session", session)
                .field("cols", cols)
                .field("rows", rows)
                .finish(),
            Self::Tail { session, id } => f
                .debug_struct("Tail")
                .field("session", session)
                .field("id", id)
                .finish(),
            Self::PendingEnd { session, seq, id } => f
                .debug_struct("PendingEnd")
                .field("session", session)
                .field("seq", seq)
                .field("id", id)
                .finish(),
            Self::Close { session } => f.debug_struct("Close").field("session", session).finish(),
        }
    }
}

impl fmt::Debug for SpillEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Append {
                session,
                text,
                count,
            } => f
                .debug_struct("Append")
                .field("session", session)
                .field("bytes", &text.len())
                .field("count", count)
                .finish(),
            Self::BlockStarted {
                session,
                seq,
                start,
                ..
            } => f
                .debug_struct("BlockStarted")
                .field("session", session)
                .field("seq", seq)
                .field("start", start)
                .finish_non_exhaustive(),
            Self::BlockEnded {
                session,
                seq,
                end,
                end_col,
                exit_code,
                ..
            } => f
                .debug_struct("BlockEnded")
                .field("session", session)
                .field("seq", seq)
                .field("end", end)
                .field("end_col", end_col)
                .field("exit_code", exit_code)
                .finish_non_exhaustive(),
            Self::Wipe { session } => f.debug_struct("Wipe").field("session", session).finish(),
            Self::Flush { session } => f.debug_struct("Flush").field("session", session).finish(),
            Self::Parsed { session, chars } => f
                .debug_struct("Parsed")
                .field("session", session)
                .field("chars", chars)
                .finish(),
            Self::Closed { session, seq_end } => f
                .debug_struct("Closed")
                .field("session", session)
                .field("seq_end", seq_end)
                .finish(),
            Self::Failed { session, reason } => f
                .debug_struct("Failed")
                .field("session", session)
                .field("reason", reason)
                .finish(),
            Self::Reply {
                id,
                tail,
                pending_end,
            } => f
                .debug_struct("Reply")
                .field("id", id)
                .field("tail", &tail.as_ref().map(Vec::len))
                .field("pending_end", pending_end)
                .finish(),
        }
    }
}

pub trait SpillHostPort: Send + Sync {
    fn post_message(&self, event: SpillEvent);
    fn on_message(&self, listener: Arc<dyn Fn(SpillRequest) + Send + Sync>);
}

struct PostingSink {
    port: Arc<dyn SpillHostPort>,
    session: u64,
    end: AtomicU64,
}

impl SpillSink for PostingSink {
    fn end(&self) -> u64 {
        self.end.load(Ordering::SeqCst)
    }

    fn live(&self) -> bool {
        true
    }

    fn append(&self, lines: &[String]) {
        let count = u64::try_from(lines.len()).unwrap_or(u64::MAX);
        self.end.fetch_add(count, Ordering::SeqCst);
        self.port.post_message(SpillEvent::Append {
            session: self.session,
            text: lines.join("\n"),
            count,
        });
    }

    fn block_started(&self, seq: u64, start: u64, command: Option<&str>) {
        self.port.post_message(SpillEvent::BlockStarted {
            session: self.session,
            seq,
            start,
            command: command.map(ToString::to_string),
        });
    }

    fn block_ended(&self, seq: u64, end: u64, end_col: u64, exit_code: i32, command: Option<&str>) {
        self.port.post_message(SpillEvent::BlockEnded {
            session: self.session,
            seq,
            end,
            end_col,
            exit_code,
            command: command.map(ToString::to_string),
        });
    }

    fn wipe(&self) {
        self.port.post_message(SpillEvent::Wipe {
            session: self.session,
        });
    }

    fn flush(&self) {
        self.port.post_message(SpillEvent::Flush {
            session: self.session,
        });
    }
}

pub trait HostedTerminal {
    fn write(&mut self, data: &[u8]);
    fn resync(&mut self, screen: &str);
    fn restore(&mut self, history: &str, hold: bool);
    fn resize(&mut self, cols: u16, rows: u16);
    fn tail(&self) -> Vec<String>;
    fn pending_end(&self, seq: u64) -> Option<BlockEnd>;
    fn close(&mut self) -> u64;
}

impl HostedTerminal for SpillTerminal {
    fn write(&mut self, data: &[u8]) {
        SpillTerminal::write(self, data);
    }

    fn resync(&mut self, screen: &str) {
        SpillTerminal::resync(self, screen);
    }

    fn restore(&mut self, history: &str, hold: bool) {
        SpillTerminal::restore(self, history, hold);
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        SpillTerminal::resize(self, cols, rows);
    }

    fn tail(&self) -> Vec<String> {
        SpillTerminal::tail(self)
    }

    fn pending_end(&self, seq: u64) -> Option<BlockEnd> {
        SpillTerminal::pending_end(self, seq)
    }

    fn close(&mut self) -> u64 {
        SpillTerminal::close(self)
    }
}

pub type OpenTerminal = Box<
    dyn Fn(u16, u16, Arc<dyn SpillSink>, u64) -> Result<Box<dyn HostedTerminal>, String>
        + Send
        + Sync,
>;

fn open_spill_terminal(
    cols: u16,
    rows: u16,
    sink: Arc<dyn SpillSink>,
    seq_offset: u64,
) -> Result<Box<dyn HostedTerminal>, String> {
    let terminal = SpillTerminal::new(cols, rows, sink, seq_offset)?;
    Ok(Box::new(terminal))
}

struct Sessions {
    terminals: HashMap<u64, Box<dyn HostedTerminal>>,
    open: OpenTerminal,
}

const PANICKED: &str = "spill terminal panicked";

enum Recovery {
    Session(u64),
    Write(u64),
    Tail(u64, u64),
    PendingEnd(u64, u64),
}

impl Recovery {
    fn of(request: &SpillRequest) -> Self {
        match request {
            SpillRequest::Write { session, .. } => Self::Write(*session),
            SpillRequest::Tail { session, id } => Self::Tail(*session, *id),
            SpillRequest::PendingEnd { session, id, .. } => Self::PendingEnd(*session, *id),
            SpillRequest::Open { session, .. }
            | SpillRequest::Resync { session, .. }
            | SpillRequest::Restore { session, .. }
            | SpillRequest::Resize { session, .. }
            | SpillRequest::Close { session } => Self::Session(*session),
        }
    }

    fn session(&self) -> u64 {
        match self {
            Self::Session(session)
            | Self::Write(session)
            | Self::Tail(session, _)
            | Self::PendingEnd(session, _) => *session,
        }
    }
}

fn recover(sessions: &mut Sessions, port: &Arc<dyn SpillHostPort>, recovery: &Recovery) {
    let session = recovery.session();
    if let Some(terminal) = sessions.terminals.remove(&session) {
        let _ = catch_unwind(AssertUnwindSafe(move || drop(terminal)));
    }
    port.post_message(SpillEvent::Failed {
        session,
        reason: PANICKED.to_owned(),
    });
    match recovery {
        Recovery::Tail(_, id) => port.post_message(SpillEvent::Reply {
            id: *id,
            tail: Some(Vec::new()),
            pending_end: None,
        }),
        Recovery::PendingEnd(_, id) => port.post_message(SpillEvent::Reply {
            id: *id,
            tail: None,
            pending_end: Some(None),
        }),
        Recovery::Session(_) | Recovery::Write(_) => {}
    }
}

fn handle(sessions: &mut Sessions, port: &Arc<dyn SpillHostPort>, request: SpillRequest) {
    let recovery = Recovery::of(&request);
    if catch_unwind(AssertUnwindSafe(|| dispatch(sessions, port, request))).is_err() {
        recover(sessions, port, &recovery);
    }
}

fn dispatch(sessions: &mut Sessions, port: &Arc<dyn SpillHostPort>, request: SpillRequest) {
    match request {
        SpillRequest::Open {
            session,
            cols,
            rows,
            end,
            seq_offset,
        } => {
            let sink = Arc::new(PostingSink {
                port: port.clone(),
                session,
                end: AtomicU64::new(end),
            });
            match (sessions.open)(cols, rows, sink, seq_offset) {
                Ok(terminal) => {
                    sessions.terminals.insert(session, terminal);
                }
                Err(reason) => {
                    tracing::error!(error = %reason, "spill terminal failed to start");
                    port.post_message(SpillEvent::Failed { session, reason });
                }
            }
        }
        SpillRequest::Write {
            session,
            data,
            chars,
        } => {
            if let Some(terminal) = sessions.terminals.get_mut(&session) {
                terminal.write(&data);
            }
            port.post_message(SpillEvent::Parsed { session, chars });
        }
        SpillRequest::Resync { session, screen } => {
            if let Some(terminal) = sessions.terminals.get_mut(&session) {
                terminal.resync(&screen);
            }
        }
        SpillRequest::Restore {
            session,
            history,
            hold,
        } => {
            if let Some(terminal) = sessions.terminals.get_mut(&session) {
                terminal.restore(&history, hold);
            }
        }
        SpillRequest::Resize {
            session,
            cols,
            rows,
        } => {
            if let Some(terminal) = sessions.terminals.get_mut(&session) {
                terminal.resize(cols, rows);
            }
        }
        SpillRequest::Tail { session, id } => {
            let tail = sessions
                .terminals
                .get(&session)
                .map(|terminal| terminal.tail())
                .unwrap_or_default();
            port.post_message(SpillEvent::Reply {
                id,
                tail: Some(tail),
                pending_end: None,
            });
        }
        SpillRequest::PendingEnd { session, seq, id } => {
            let pending_end = sessions
                .terminals
                .get(&session)
                .and_then(|terminal| terminal.pending_end(seq));
            port.post_message(SpillEvent::Reply {
                id,
                tail: None,
                pending_end: Some(pending_end),
            });
        }
        SpillRequest::Close { session } => {
            let seq_end = sessions
                .terminals
                .remove(&session)
                .map_or(0, |mut terminal| terminal.close());
            port.post_message(SpillEvent::Closed { session, seq_end });
        }
    }
}

pub fn serve_spill(port: Arc<dyn SpillHostPort>) -> std::io::Result<()> {
    serve_spill_with(port, Box::new(open_spill_terminal))
}

pub fn serve_spill_with(port: Arc<dyn SpillHostPort>, open: OpenTerminal) -> std::io::Result<()> {
    let owner = OwnerThread::spawn("spill-host", move || Sessions {
        terminals: HashMap::new(),
        open,
    })?;
    let reply_port = port.clone();
    port.on_message(Arc::new(move |request| {
        let reply_port = reply_port.clone();
        let _ = owner.post(move |sessions| handle(sessions, &reply_port, request));
    }));
    Ok(())
}
