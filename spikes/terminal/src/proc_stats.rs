use std::fs;

pub struct Sample {
    pub cpu_seconds: f64,
    pub pss_mb: f64,
}

pub fn sample_self() -> Sample {
    Sample {
        cpu_seconds: cpu_seconds("/proc/self/stat"),
        pss_mb: pss_kb("/proc/self/smaps_rollup") / 1024.0,
    }
}

pub fn pss_tree_mb(pids: &[u32]) -> f64 {
    pids.iter()
        .map(|pid| pss_kb(&format!("/proc/{pid}/smaps_rollup")))
        .sum::<f64>()
        / 1024.0
}

fn cpu_seconds(path: &str) -> f64 {
    let Ok(stat) = fs::read_to_string(path) else {
        return 0.0;
    };
    let Some(after_comm) = stat.rsplit_once(')').map(|(_, rest)| rest) else {
        return 0.0;
    };
    let fields: Vec<&str> = after_comm.split_whitespace().collect();
    let ticks = |index: usize| {
        fields
            .get(index)
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0)
    };
    (ticks(11) + ticks(12)) / 100.0
}

fn pss_kb(path: &str) -> f64 {
    let Ok(rollup) = fs::read_to_string(path) else {
        return 0.0;
    };
    rollup
        .lines()
        .find_map(|line| line.strip_prefix("Pss:"))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0)
}
