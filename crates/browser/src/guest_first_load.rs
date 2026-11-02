use std::future::Future;
use std::sync::Arc;

use ostia_base::js::non_empty;
use parking_lot::Mutex;
use tokio::runtime::Handle;
use tokio::sync::watch;

pub trait FirstLoadGuest: Send + Sync {
    fn is_destroyed(&self) -> bool;
    fn stop(&self);
    fn load_url(&self, url: &str, referrer: Option<&str>);
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NavigationDetails {
    pub url: Option<String>,
    pub is_main_frame: bool,
    pub is_same_document: bool,
}

impl NavigationDetails {
    fn new_document_url(&self) -> Option<&str> {
        if self.is_main_frame && !self.is_same_document {
            self.url.as_deref()
        } else {
            None
        }
    }
}

enum Phase {
    Waiting,
    Held,
    Watching { replaced: bool },
    Done,
}

type ReferrerOf = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;
type Defer = Arc<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

pub struct FirstLoadHold {
    guest: Arc<dyn FirstLoadGuest>,
    phase: Arc<Mutex<Phase>>,
    settled: watch::Receiver<bool>,
    referrer_of: ReferrerOf,
    defer: Defer,
    runtime: Handle,
}

pub fn hold_first_load<F, R, D>(
    guest: Arc<dyn FirstLoadGuest>,
    ready: F,
    referrer_of: R,
    defer: D,
) -> FirstLoadHold
where
    F: Future + Send + 'static,
    F::Output: Send,
    R: Fn(&str) -> Option<String> + Send + Sync + 'static,
    D: Fn(Box<dyn FnOnce() + Send>) + Send + Sync + 'static,
{
    let runtime = Handle::current();
    let (settle, settled) = watch::channel(false);
    runtime.spawn(async move {
        let _ = ready.await;
        settle.send_replace(true);
    });
    FirstLoadHold {
        guest,
        phase: Arc::new(Mutex::new(Phase::Waiting)),
        settled,
        referrer_of: Arc::new(referrer_of),
        defer: Arc::new(defer),
        runtime,
    }
}

impl FirstLoadHold {
    pub fn navigation_started(&self, details: &NavigationDetails) {
        let Some(url) = details.new_document_url() else {
            return;
        };
        {
            let mut phase = self.phase.lock();
            match &mut *phase {
                Phase::Waiting => {
                    if *self.settled.borrow() {
                        *phase = Phase::Done;
                        return;
                    }
                    *phase = Phase::Held;
                }
                Phase::Watching { replaced } => {
                    *replaced = true;
                    return;
                }
                Phase::Held | Phase::Done => return,
            }
        }
        let url = url.to_owned();
        let guest = self.guest.clone();
        let phase = self.phase.clone();
        let settled = self.settled.clone();
        let referrer_of = self.referrer_of.clone();
        let runtime = self.runtime.clone();
        (self.defer)(Box::new(move || {
            if guest.is_destroyed() {
                return;
            }
            guest.stop();
            *phase.lock() = Phase::Watching { replaced: false };
            runtime.spawn(reload_when_settled(guest, phase, settled, referrer_of, url));
        }));
    }
}

async fn reload_when_settled(
    guest: Arc<dyn FirstLoadGuest>,
    phase: Arc<Mutex<Phase>>,
    mut settled: watch::Receiver<bool>,
    referrer_of: ReferrerOf,
    url: String,
) {
    let _ = settled.wait_for(|done| *done).await;
    if guest.is_destroyed() {
        return;
    }
    let replaced = matches!(
        std::mem::replace(&mut *phase.lock(), Phase::Done),
        Phase::Watching { replaced: true }
    );
    if replaced {
        return;
    }
    let referrer = referrer_of(&url);
    guest.load_url(&url, non_empty(referrer.as_deref()));
}
