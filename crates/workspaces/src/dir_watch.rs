use std::path::Path;
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::thread;
use std::time::Duration;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher, recommended_watcher};

pub struct DirWatch {
    _watcher: RecommendedWatcher,
}

impl DirWatch {
    pub fn start(
        dir: &Path,
        debounce: Duration,
        on_change: impl Fn() + Send + 'static,
    ) -> Result<Self, String> {
        let (sender, receiver) = channel::<()>();
        let mut watcher = recommended_watcher(move |event: notify::Result<Event>| {
            let access = matches!(&event, Ok(event) if matches!(event.kind, EventKind::Access(_)));
            if !access {
                let _ = sender.send(());
            }
        })
        .map_err(|error| error.to_string())?;
        watcher
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(|error| error.to_string())?;
        thread::Builder::new()
            .name("dir-watch".to_owned())
            .spawn(move || {
                while receiver.recv().is_ok() {
                    loop {
                        match receiver.recv_timeout(debounce) {
                            Ok(()) => {}
                            Err(RecvTimeoutError::Timeout) => {
                                on_change();
                                break;
                            }
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self { _watcher: watcher })
    }
}
