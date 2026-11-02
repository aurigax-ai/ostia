use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use ostia_base::OwnerThread;

pub use crate::history_spill::BlockEnd;
use crate::history_spill::SpillSink;
use crate::spill_terminal::SpillTerminal;

#[derive(Clone, Debug, PartialEq, Eq)]
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

#[derive(Clone, Debug, PartialEq, Eq)]
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
    Reply {
        id: u64,
        tail: Option<Vec<String>>,
        pending_end: Option<Option<BlockEnd>>,
    },
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

#[derive(Default)]
struct Sessions {
    terminals: HashMap<u64, SpillTerminal>,
}

fn handle(sessions: &mut Sessions, port: &Arc<dyn SpillHostPort>, request: SpillRequest) {
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
            match SpillTerminal::new(cols, rows, sink, seq_offset) {
                Ok(terminal) => {
                    sessions.terminals.insert(session, terminal);
                }
                Err(err) => {
                    tracing::error!(error = %err, "spill terminal failed to start");
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
                .map(SpillTerminal::tail)
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
    let owner = OwnerThread::spawn("spill-host", Sessions::default)?;
    let reply_port = port.clone();
    port.on_message(Arc::new(move |request| {
        let reply_port = reply_port.clone();
        let _ = owner.post(move |sessions| handle(sessions, &reply_port, request));
    }));
    Ok(())
}
