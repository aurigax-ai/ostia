use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc::{Sender, channel};
use std::thread;

use tokio::sync::oneshot;

type Job<S> = Box<dyn FnOnce(&mut S) + Send>;

#[derive(Debug, thiserror::Error)]
#[error("the owner thread did not finish the job")]
pub struct JobLost;

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

fn panic_text(payload: &(dyn Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("no message")
}

impl<S: 'static> OwnerThread<S> {
    pub fn spawn<F>(name: &str, init: F) -> std::io::Result<Self>
    where
        F: FnOnce() -> S + Send + 'static,
    {
        let (jobs, inbox) = channel::<Job<S>>();
        let owner = name.to_owned();
        thread::Builder::new().name(name.to_owned()).spawn(move || {
            let mut state = match catch_unwind(AssertUnwindSafe(init)) {
                Ok(state) => state,
                Err(payload) => {
                    tracing::error!(owner = %owner, panic = panic_text(&*payload), "owner thread failed to start");
                    return;
                }
            };
            while let Ok(job) = inbox.recv() {
                if let Err(payload) = catch_unwind(AssertUnwindSafe(|| job(&mut state))) {
                    tracing::error!(owner = %owner, panic = panic_text(&*payload), "owner thread job panicked");
                }
            }
        })?;
        Ok(Self { jobs })
    }

    pub fn post<F>(&self, job: F) -> Result<(), JobLost>
    where
        F: FnOnce(&mut S) + Send + 'static,
    {
        self.jobs.send(Box::new(job)).map_err(|_| JobLost)
    }

    pub async fn call<F, R>(&self, job: F) -> Result<R, JobLost>
    where
        F: FnOnce(&mut S) -> R + Send + 'static,
        R: Send + 'static,
    {
        let (reply, answer) = oneshot::channel();
        self.post(move |state| {
            let _ = reply.send(job(state));
        })?;
        answer.await.map_err(|_| JobLost)
    }
}
