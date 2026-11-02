use std::collections::BTreeMap;
use std::io::{ErrorKind, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

pub const MAX_OUTPUT: usize = 1024 * 1024;

const BUSY_RETRIES: u32 = 100;
const POLL: Duration = Duration::from_millis(10);

pub fn run_bounded(
    file: &Path,
    args: &[String],
    env: &BTreeMap<String, String>,
    timeout: Duration,
) -> Option<String> {
    let mut child = spawn(file, args, env)?;
    let stdout = child.stdout.take()?;
    let (send, receive) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let read = stdout
            .take(u64::try_from(MAX_OUTPUT + 1).unwrap_or(u64::MAX))
            .read_to_end(&mut bytes);
        let _ = send.send(read.ok().map(|_| bytes));
    });
    let deadline = Instant::now() + timeout;
    let mut output = None;
    let status = loop {
        if output.is_none() {
            match receive.try_recv() {
                Ok(read) => output = Some(read),
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => output = Some(None),
            }
            if matches!(&output, Some(Some(bytes)) if bytes.len() > MAX_OUTPUT) {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(POLL),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let bytes = match output {
        Some(read) => read?,
        None => match receive.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(read) => read?,
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => return None,
        },
    };
    (status.success() && bytes.len() <= MAX_OUTPUT)
        .then(|| String::from_utf8_lossy(&bytes).into_owned())
}

fn spawn(file: &Path, args: &[String], env: &BTreeMap<String, String>) -> Option<Child> {
    for _ in 0..BUSY_RETRIES {
        let spawned = Command::new(file)
            .args(args)
            .env_clear()
            .envs(env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        match spawned {
            Ok(child) => return Some(child),
            Err(error) if error.kind() == ErrorKind::ExecutableFileBusy => thread::sleep(POLL),
            Err(_) => return None,
        }
    }
    None
}
