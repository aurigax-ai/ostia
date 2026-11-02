use rustix::io::Errno;
use rustix::process::{Pid, test_kill_process, test_kill_process_group};

pub fn is_running(pid: i32) -> bool {
    let probe = if pid < 0 {
        let Some(group) = pid.checked_neg().and_then(Pid::from_raw) else {
            return false;
        };
        test_kill_process_group(group)
    } else {
        let Some(process) = Pid::from_raw(pid) else {
            return true;
        };
        test_kill_process(process)
    };
    match probe {
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
