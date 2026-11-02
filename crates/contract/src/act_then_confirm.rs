use parking_lot::Mutex;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, interval_at, sleep};

pub type Wake = Arc<dyn Fn() + Send + Sync>;
pub type Off = Box<dyn FnOnce() + Send>;

#[derive(Clone)]
pub struct Subscribe(Arc<dyn Fn(Wake) -> Off + Send + Sync>);

impl Subscribe {
    pub fn new(attach: impl Fn(Wake) -> Off + Send + Sync + 'static) -> Self {
        Self(Arc::new(attach))
    }

    pub fn attach(&self, wake: Wake) -> Off {
        (self.0)(wake)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Settled<T> {
    Confirmed(T),
    Mismatch { reason: String, value: Option<T> },
}

pub fn confirmed<T>(value: T) -> Settled<T> {
    Settled::Confirmed(value)
}

pub fn mismatch<T>(reason: impl Into<String>, value: Option<T>) -> Settled<T> {
    Settled::Mismatch {
        reason: reason.into(),
        value,
    }
}

#[derive(Clone, Default)]
pub struct ChangeSignal {
    wakes: Arc<Mutex<Vec<(u64, Wake)>>>,
    next_id: Arc<Mutex<u64>>,
}

impl ChangeSignal {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscribe(&self) -> Subscribe {
        let wakes = self.wakes.clone();
        let next_id = self.next_id.clone();
        Subscribe::new(move |wake| {
            let id = {
                let mut next = next_id.lock();
                *next += 1;
                *next
            };
            wakes.lock().push((id, wake));
            let wakes = wakes.clone();
            Box::new(move || wakes.lock().retain(|(held, _)| *held != id))
        })
    }

    pub fn fire(&self) {
        let snapshot: Vec<Wake> = self
            .wakes
            .lock()
            .iter()
            .map(|(_, wake)| wake.clone())
            .collect();
        for wake in snapshot {
            wake();
        }
    }
}

pub fn poll_every(period: Duration) -> Subscribe {
    Subscribe::new(move |wake| {
        let mut ticks = interval_at(Instant::now() + period, period);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let task: JoinHandle<()> = tokio::spawn(async move {
            loop {
                ticks.tick().await;
                wake();
            }
        });
        Box::new(move || task.abort())
    })
}

pub fn any_of(subscriptions: Vec<Subscribe>) -> Subscribe {
    Subscribe::new(move |wake| {
        let offs: Vec<Off> = subscriptions
            .iter()
            .map(|subscribe| subscribe.attach(wake.clone()))
            .collect();
        Box::new(move || {
            for off in offs {
                off();
            }
        })
    })
}

pub struct ConfirmSpec<Act, Observe, OnTimeout> {
    pub act: Act,
    pub observe: Observe,
    pub signal: Subscribe,
    pub timeout: Duration,
    pub on_timeout: OnTimeout,
}

struct Unsubscribe(Option<Off>);

impl Drop for Unsubscribe {
    fn drop(&mut self) {
        if let Some(off) = self.0.take() {
            off();
        }
    }
}

pub async fn act_then_confirm<T, ActFut, ObserveFut, TimeoutFut>(
    mut spec: ConfirmSpec<
        impl FnOnce() -> ActFut,
        impl FnMut() -> ObserveFut,
        impl FnOnce() -> TimeoutFut,
    >,
) -> Settled<T>
where
    ActFut: Future<Output = ()>,
    ObserveFut: Future<Output = Option<Settled<T>>>,
    TimeoutFut: Future<Output = Settled<T>>,
{
    (spec.act)().await;
    if let Some(first) = (spec.observe)().await {
        return first;
    }
    let (sender, mut wakes) = mpsc::unbounded_channel::<()>();
    let wake_sender = sender.clone();
    let wake: Wake = Arc::new(move || {
        let _ = wake_sender.send(());
    });
    let _unsubscribe = Unsubscribe(Some(spec.signal.attach(wake)));
    let deadline = sleep(spec.timeout);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            biased;
            () = &mut deadline => return (spec.on_timeout)().await,
            seen = (spec.observe)() => {
                if let Some(settled) = seen {
                    return settled;
                }
            }
        }
        tokio::select! {
            biased;
            () = &mut deadline => return (spec.on_timeout)().await,
            _ = wakes.recv() => {
                while wakes.try_recv().is_ok() {}
            }
        }
    }
}
