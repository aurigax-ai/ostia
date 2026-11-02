use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PowerEvent {
    Suspend,
    Resume,
}

pub trait PowerEvents {
    fn on(&mut self, event: PowerEvent, listener: Box<dyn Fn() + Send + Sync>);
}

pub trait PowerAware {
    fn suspend(&self);
    fn resume(&self);
}

pub fn watch_power<P, K>(power: &mut P, kept: Arc<K>)
where
    P: PowerEvents + ?Sized,
    K: PowerAware + Send + Sync + 'static,
{
    let suspending = Arc::clone(&kept);
    power.on(PowerEvent::Suspend, Box::new(move || suspending.suspend()));
    power.on(PowerEvent::Resume, Box::new(move || kept.resume()));
}
