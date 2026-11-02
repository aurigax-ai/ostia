use std::io::{ErrorKind, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const BUSY_RETRIES: u32 = 100;
const POLL: Duration = Duration::from_millis(10);

pub fn run_bounded(file: &Path, args: &[String], timeout: Duration) -> Option<String> {
    let mut child = spawn(file, args)?;
    let mut stdout = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).ok().map(|_| bytes)
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
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
    let bytes = reader.join().ok()??;
    status
        .success()
        .then(|| String::from_utf8_lossy(&bytes).into_owned())
}

fn spawn(file: &Path, args: &[String]) -> Option<Child> {
    for _ in 0..BUSY_RETRIES {
        let spawned = Command::new(file)
            .args(args)
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
