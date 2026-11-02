use std::sync::mpsc::{Sender, channel};
use std::thread;

use tokio::sync::oneshot;

type Job<S> = Box<dyn FnOnce(&mut S) + Send>;

#[derive(Debug, thiserror::Error)]
#[error("the owner thread has stopped")]
pub struct OwnerGone;

pub struct OwnerThread<S> {
    jobs: Sender<Job<S>>,
}

impl<S> Clone for OwnerThread<S> {
    fn clone(&self) -> Self {
        Self {
            jobs: self.jobs.clone(),
        }
    }
}

impl<S: 'static> OwnerThread<S> {
    pub fn spawn<F>(name: &str, init: F) -> std::io::Result<Self>
    where
        F: FnOnce() -> S + Send + 'static,
    {
        let (jobs, inbox) = channel::<Job<S>>();
        thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || {
                let mut state = init();
                while let Ok(job) = inbox.recv() {
                    job(&mut state);
                }
            })?;
        Ok(Self { jobs })
    }

    pub fn post<F>(&self, job: F) -> Result<(), OwnerGone>
    where
        F: FnOnce(&mut S) + Send + 'static,
    {
        self.jobs.send(Box::new(job)).map_err(|_| OwnerGone)
    }

    pub async fn call<F, R>(&self, job: F) -> Result<R, OwnerGone>
    where
        F: FnOnce(&mut S) -> R + Send + 'static,
        R: Send + 'static,
    {
        let (reply, answer) = oneshot::channel();
        self.post(move |state| {
            let _ = reply.send(job(state));
        })?;
        answer.await.map_err(|_| OwnerGone)
    }
}
