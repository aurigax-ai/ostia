use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, interval_at};

pub type AddressProbe = Arc<dyn Fn() -> Option<String> + Send + Sync>;
pub type RebindFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
pub type Rebind = Arc<dyn Fn() -> RebindFuture + Send + Sync>;

pub struct BindFollowerOptions {
    pub every_ms: u64,
    pub resolve: AddressProbe,
    pub bound: AddressProbe,
    pub rebind: Rebind,
}

struct Probes {
    resolve: AddressProbe,
    bound: AddressProbe,
    rebind: Rebind,
}

struct BusyGuard(Arc<AtomicBool>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

struct Inner {
    every: Duration,
    probes: Arc<Probes>,
    busy: Arc<AtomicBool>,
    timer: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct BindFollower {
    inner: Arc<Inner>,
}

fn tick(probes: &Probes, busy: &Arc<AtomicBool>) {
    if busy.load(Ordering::SeqCst) || (probes.resolve)() == (probes.bound)() {
        return;
    }
    busy.store(true, Ordering::SeqCst);
    let guard = BusyGuard(Arc::clone(busy));
    let work = (probes.rebind)();
    tokio::spawn(async move {
        let _guard = guard;
        work.await;
    });
}

impl BindFollower {
    pub fn create(options: BindFollowerOptions) -> Self {
        Self {
            inner: Arc::new(Inner {
                every: Duration::from_millis(options.every_ms),
                probes: Arc::new(Probes {
                    resolve: options.resolve,
                    bound: options.bound,
                    rebind: options.rebind,
                }),
                busy: Arc::new(AtomicBool::new(false)),
                timer: Mutex::new(None),
            }),
        }
    }

    pub fn start(&self) {
        let mut timer = self.inner.timer.lock();
        if timer.is_some() {
            return;
        }
        let mut ticks = interval_at(Instant::now() + self.inner.every, self.inner.every);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let probes = Arc::clone(&self.inner.probes);
        let busy = Arc::clone(&self.inner.busy);
        *timer = Some(tokio::spawn(async move {
            loop {
                ticks.tick().await;
                tick(&probes, &busy);
            }
        }));
    }

    pub fn stop(&self) {
        if let Some(timer) = self.inner.timer.lock().take() {
            timer.abort();
        }
    }
}
