use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::task::AbortHandle;

pub const FLOW_HIGH_WATERMARK: i64 = 100_000;
pub const FLOW_LOW_WATERMARK: i64 = 5_000;
pub const FLOW_STALL_MS: u64 = 1_000;

const WINDOW_MARKS: FlowMarks = FlowMarks {
    high: FLOW_HIGH_WATERMARK,
    low: FLOW_LOW_WATERMARK,
};

pub trait FlowTarget {
    fn pause(&self);
    fn resume(&self);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FlowMarks {
    pub high: i64,
    pub low: i64,
}

type Shown = Arc<dyn Fn() -> bool + Send + Sync>;

struct LaneState {
    id: String,
    unacked: i64,
    marks: FlowMarks,
    shown: Shown,
}

#[derive(Clone, Copy)]
enum Command {
    Pause,
    Resume,
}

#[derive(Default)]
struct FlowState {
    lanes: HashMap<u64, LaneState>,
    current: HashMap<String, u64>,
    next_serial: u64,
    paused: bool,
    stall_generation: u64,
    commands: VecDeque<Command>,
    delivering: bool,
}

fn current_lane<'a>(st: &'a mut FlowState, id: &str) -> Option<&'a mut LaneState> {
    let serial = *st.current.get(id)?;
    st.lanes.get_mut(&serial)
}

struct Inner {
    target: Arc<dyn FlowTarget + Send + Sync>,
    state: Mutex<FlowState>,
}

impl Inner {
    fn update<R>(self: &Arc<Self>, change: impl FnOnce(&Arc<Self>, &mut FlowState) -> R) -> R {
        let result = {
            let mut st = self.state.lock();
            change(self, &mut st)
        };
        self.deliver_commands();
        result
    }

    fn deliver_commands(&self) {
        {
            let mut st = self.state.lock();
            if st.delivering || st.commands.is_empty() {
                return;
            }
            st.delivering = true;
        }
        loop {
            let command = {
                let mut st = self.state.lock();
                let Some(command) = st.commands.pop_front() else {
                    st.delivering = false;
                    return;
                };
                command
            };
            match command {
                Command::Pause => self.target.pause(),
                Command::Resume => self.target.resume(),
            }
        }
    }

    fn pause_pty(self: &Arc<Self>, st: &mut FlowState) {
        st.paused = true;
        self.arm_stall(st);
        st.commands.push_back(Command::Pause);
    }

    fn resume_pty(&self, st: &mut FlowState) {
        st.paused = false;
        st.stall_generation += 1;
        st.commands.push_back(Command::Resume);
    }

    fn arm_stall(self: &Arc<Self>, st: &mut FlowState) {
        st.stall_generation += 1;
        let generation = st.stall_generation;
        let inner = Arc::clone(self);
        let timer = tokio::time::sleep(Duration::from_millis(FLOW_STALL_MS));
        tokio::spawn(async move {
            timer.await;
            inner.update(|inner, st| {
                if st.stall_generation != generation {
                    return;
                }
                for lane in st.lanes.values_mut() {
                    lane.unacked = 0;
                }
                inner.resume_pty(st);
            });
        });
    }

    fn settle(&self, st: &mut FlowState) {
        if !st.paused {
            return;
        }
        let draining = st.current.values().all(|serial| {
            st.lanes
                .get(serial)
                .is_none_or(|lane| lane.unacked <= lane.marks.low)
        });
        if draining {
            self.resume_pty(st);
        }
    }
}

#[derive(Clone)]
pub struct PtyFlowControl {
    inner: Arc<Inner>,
}

pub struct FlowLane {
    inner: Arc<Inner>,
    serial: u64,
}

impl PtyFlowControl {
    pub fn new(target: Arc<dyn FlowTarget + Send + Sync>) -> Self {
        Self {
            inner: Arc::new(Inner {
                target,
                state: Mutex::new(FlowState::default()),
            }),
        }
    }

    pub fn is_paused(&self) -> bool {
        self.inner.state.lock().paused
    }

    pub fn open(&self, id: &str, shown: impl Fn() -> bool + Send + Sync + 'static) -> FlowLane {
        self.open_with_marks(id, shown, WINDOW_MARKS)
    }

    pub fn open_with_marks(
        &self,
        id: &str,
        shown: impl Fn() -> bool + Send + Sync + 'static,
        marks: FlowMarks,
    ) -> FlowLane {
        let serial = self.inner.update(|inner, st| {
            st.next_serial += 1;
            let serial = st.next_serial;
            st.lanes.insert(
                serial,
                LaneState {
                    id: id.to_owned(),
                    unacked: 0,
                    marks,
                    shown: Arc::new(shown),
                },
            );
            st.current.insert(id.to_owned(), serial);
            inner.settle(st);
            serial
        });
        FlowLane {
            inner: Arc::clone(&self.inner),
            serial,
        }
    }

    pub fn ack(&self, id: &str, chars: i64) {
        if chars <= 0 {
            return;
        }
        self.inner.update(|inner, st| {
            let Some(lane) = current_lane(st, id) else {
                return;
            };
            lane.unacked = (lane.unacked - chars).max(0);
            if st.paused {
                inner.arm_stall(st);
            }
            inner.settle(st);
        });
    }

    pub fn hidden(&self, id: &str) {
        self.inner.update(|inner, st| {
            let Some(lane) = current_lane(st, id) else {
                return;
            };
            lane.unacked = 0;
            inner.settle(st);
        });
    }

    pub fn release(&self, id: &str) {
        self.inner.update(|inner, st| {
            let Some(serial) = st.current.remove(id) else {
                return;
            };
            st.lanes.remove(&serial);
            inner.settle(st);
        });
    }

    pub fn dispose(&self) {
        let mut st = self.inner.state.lock();
        st.current.clear();
        st.paused = false;
        st.stall_generation += 1;
    }
}

impl FlowLane {
    pub fn sent(&self, chars: i64) {
        let shown = {
            let st = self.inner.state.lock();
            let Some(lane) = st.lanes.get(&self.serial) else {
                return;
            };
            Arc::clone(&lane.shown)
        };
        let visible = shown();
        self.inner.update(|inner, st| {
            let Some(lane) = st.lanes.get_mut(&self.serial) else {
                return;
            };
            if !visible {
                lane.unacked = 0;
                return;
            }
            lane.unacked += chars;
            let over = lane.unacked > lane.marks.high;
            if over && !st.paused {
                inner.pause_pty(st);
            }
        });
    }

    pub fn close(&self) {
        self.inner.update(|inner, st| {
            let Some(lane) = st.lanes.remove(&self.serial) else {
                return;
            };
            if st.current.get(&lane.id) != Some(&self.serial) {
                return;
            }
            st.current.remove(&lane.id);
            inner.settle(st);
        });
    }
}

impl Drop for FlowLane {
    fn drop(&mut self) {
        self.close();
    }
}

pub struct CoalescedOutput {
    shared: Arc<Coalesced>,
}

struct Coalesced {
    deliver: Box<dyn Fn(String) + Send + Sync>,
    order: Mutex<()>,
    pending: Mutex<Pending>,
}

#[derive(Default)]
struct Pending {
    chunks: Vec<String>,
    scheduled: Option<AbortHandle>,
    closed: bool,
}

impl Coalesced {
    fn flush(&self) {
        let _order = self.order.lock();
        let data = {
            let mut pending = self.pending.lock();
            if let Some(handle) = pending.scheduled.take() {
                handle.abort();
            }
            if pending.chunks.is_empty() {
                return;
            }
            std::mem::take(&mut pending.chunks).concat()
        };
        (self.deliver)(data);
    }
}

impl CoalescedOutput {
    pub fn new(deliver: impl Fn(String) + Send + Sync + 'static) -> Self {
        Self {
            shared: Arc::new(Coalesced {
                deliver: Box::new(deliver),
                order: Mutex::new(()),
                pending: Mutex::new(Pending::default()),
            }),
        }
    }

    pub fn push(&self, data: &str) {
        if data.is_empty() {
            return;
        }
        let mut pending = self.shared.pending.lock();
        if pending.closed {
            return;
        }
        pending.chunks.push(data.to_owned());
        if pending.scheduled.is_none() {
            let shared = Arc::clone(&self.shared);
            pending.scheduled = Some(tokio::spawn(async move { shared.flush() }).abort_handle());
        }
    }

    pub fn flush(&self) {
        self.shared.flush();
    }

    pub fn close(&self) {
        let mut pending = self.shared.pending.lock();
        pending.closed = true;
        if let Some(handle) = pending.scheduled.take() {
            handle.abort();
        }
        pending.chunks.clear();
    }
}
