use rustix::io::Errno;
use rustix::process::{Pid, test_kill_process};

pub fn is_running(pid: i32) -> bool {
    let Some(pid) = Pid::from_raw(pid) else {
        return pid == 0;
    };
    match test_kill_process(pid) {
        Ok(()) => true,
        Err(errno) => errno == Errno::PERM,
    }
}

pub fn current_uid() -> u32 {
    rustix::process::getuid().as_raw()
}

pub fn parent_pid() -> Option<i32> {
    rustix::process::getppid().map(Pid::as_raw_pid)
}
