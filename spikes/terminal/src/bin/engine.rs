use std::env;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use spike_terminal::proc_stats::{pss_tree_mb, sample_self};
use spike_terminal::screen::Screen;
use spike_terminal::serialize::{all_text, output_after_mark, prompt_marks, row_range_text};
use spike_terminal::session::{Event, Pane, SCROLLBACK_LINES, Sink, spawn_pane, spawn_panes};

const COLS: u16 = 100;
const ROWS: u16 = 30;
const BULK_COMMAND: &str = "seq -f 'line %g of the bulk output test with some padding text' 200000; printf '\\033]0;BULKDONE\\007'; sleep 1";
const BUSY_COMMAND: &str = "while :; do seq -f 'ostia-load %g xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' 20; sleep 0.05; done";

fn channel_sink() -> (Sink, mpsc::Receiver<Event>) {
    let (tx, rx) = mpsc::channel();
    let tx = std::sync::Mutex::new(tx);
    let sink: Sink = Arc::new(move |event| {
        if let Ok(tx) = tx.lock() {
            let _ = tx.send(event);
        }
    });
    (sink, rx)
}

fn main() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("bulk") => bulk(),
        Some("serialize") => serialize(),
        Some("idle") => idle(number(&args, 1, 30)?, number(&args, 2, 600)?),
        Some("busy") => busy(number(&args, 1, 6)?, number(&args, 2, 30)?),
        _ => bail!(
            "usage: engine bulk | serialize | idle <panes> <seconds> | busy <panes> <seconds>"
        ),
    }
}

fn number(args: &[String], index: usize, default: u64) -> Result<usize> {
    match args.get(index) {
        Some(value) => Ok(value.parse::<usize>()?),
        None => Ok(usize::try_from(default)?),
    }
}

fn bulk() -> Result<()> {
    let (sink, rx) = channel_sink();
    let started = Instant::now();
    let mut pane = spawn_pane(0, COLS, ROWS, &["sh", "-c", BULK_COMMAND], sink)?;
    let mut captured = Vec::new();
    let mut bytes = 0usize;
    let mut feed_time = Duration::ZERO;
    let mut done_at = None;
    while done_at.is_none() {
        match rx.recv_timeout(Duration::from_secs(60))? {
            Event::Output(_, chunk) => {
                bytes += chunk.len();
                let before = Instant::now();
                pane.screen.feed(&chunk);
                feed_time += before.elapsed();
                if pane.screen.title() == "BULKDONE" {
                    done_at = Some(started.elapsed());
                }
                captured.push(chunk);
            }
            Event::Exit(_) => bail!("shell exited before BULKDONE"),
        }
    }
    let before_frame = Instant::now();
    let frame = pane.screen.frame()?;
    let frame_time = before_frame.elapsed();
    let mut replay = Screen::new(COLS, ROWS, SCROLLBACK_LINES)?;
    let before_replay = Instant::now();
    for chunk in &captured {
        replay.feed(chunk);
    }
    let replay_time = before_replay.elapsed();
    println!(
        "BULK bytes={bytes} end_to_end_ms={} vt_write_ms_during_run={} vt_write_replay_ms={} replay_mb_per_s={:.0} frame_snapshot_us={} lines_in_frame={}",
        done_at.map_or(0, |d| d.as_millis()),
        feed_time.as_millis(),
        replay_time.as_millis(),
        bytes as f64 / 1_048_576.0 / replay_time.as_secs_f64(),
        frame_time.as_micros(),
        frame.lines.len(),
    );
    Ok(())
}

fn serialize() -> Result<()> {
    let mut pane = Screen::new(40, 6, SCROLLBACK_LINES)?;
    let script = concat!(
        "\x1b]133;A\x07$ \x1b]133;B\x07echo one\r\n\x1b]133;C\x07one\r\n\x1b]133;D;0\x07",
        "\x1b]133;A\x07$ \x1b]133;B\x07echo two\r\n\x1b]133;C\x07two\r\nextra\r\n\x1b]133;D;0\x07",
        "\x1b]133;A\x07$ \x1b]133;B\x07echo three\r\n\x1b]133;C\x07three\r\n\x1b]133;D;0\x07",
        "\x1b]133;A\x07$ \x1b]133;B\x07"
    );
    pane.feed(script.as_bytes());
    let total_rows = pane.terminal().total_rows()?;
    let marks = prompt_marks(&pane)?;
    println!(
        "SERIALIZE total_rows={total_rows} prompt_marks={}",
        marks.len()
    );
    for mark in &marks {
        println!("SERIALIZE mark row={}", mark.row);
    }
    let everything = all_text(&pane)?;
    println!("SERIALIZE all_text={everything:?}");
    let range = row_range_text(&pane, 1, 3)?;
    println!("SERIALIZE row_range(1..=3)={range:?}");
    let second = marks.get(1).ok_or_else(|| anyhow!("fewer than 2 marks"))?;
    println!(
        "SERIALIZE output_after_mark(1)={:?}",
        output_after_mark(&pane, *second)?
    );
    Ok(())
}

fn pids(panes: &[Pane]) -> Vec<u32> {
    panes
        .iter()
        .filter_map(|pane| pane.pty.process_id())
        .collect()
}

fn drain(rx: &mpsc::Receiver<Event>, panes: &mut [Pane], budget: Duration, fed: &mut usize) {
    let deadline = Instant::now() + budget;
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(Event::Output(index, chunk)) => {
                *fed += chunk.len();
                panes[index].screen.feed(&chunk);
            }
            Ok(Event::Exit(_)) | Err(_) => {}
        }
    }
}

fn idle(count: usize, seconds: usize) -> Result<()> {
    let (sink, rx) = channel_sink();
    let mut panes = spawn_panes(count, COLS, ROWS, &[], &sink)?;
    let mut fed = 0usize;
    drain(&rx, &mut panes, Duration::from_secs(20), &mut fed);
    let shells = pids(&panes);
    let start_wall = Instant::now();
    let start_cpu = sample_self().cpu_seconds;
    let mut pss_samples = Vec::new();
    while start_wall.elapsed() < Duration::from_secs(u64::try_from(seconds)?) {
        drain(&rx, &mut panes, Duration::from_secs(10), &mut fed);
        let own = sample_self();
        pss_samples.push(own.pss_mb + pss_tree_mb(&shells));
    }
    let wall = start_wall.elapsed().as_secs_f64();
    let cpu = sample_self().cpu_seconds - start_cpu;
    pss_samples.sort_by(f64::total_cmp);
    println!(
        "IDLE panes={count} seconds={wall:.0} cpu_pct_of_one_core={:.2} pss_mb_median={:.0} pss_mb_peak={:.0} bytes_fed={fed}",
        cpu / wall * 100.0,
        pss_samples[pss_samples.len() / 2],
        pss_samples[pss_samples.len() - 1],
    );
    for mut pane in panes {
        pane.pty.kill();
    }
    Ok(())
}

fn busy(count: usize, seconds: usize) -> Result<()> {
    let (sink, rx) = channel_sink();
    let mut panes = Vec::new();
    for index in 0..count {
        panes.push(spawn_pane(
            index,
            COLS,
            ROWS,
            &["sh", "-c", BUSY_COMMAND],
            sink.clone(),
        )?);
    }
    let mut fed = 0usize;
    let mut frames = 0usize;
    let mut frame_time = Duration::ZERO;
    let start_cpu = sample_self().cpu_seconds;
    let start_wall = Instant::now();
    let tick = Duration::from_millis(16);
    while start_wall.elapsed() < Duration::from_secs(u64::try_from(seconds)?) {
        drain(&rx, &mut panes, tick, &mut fed);
        let before = Instant::now();
        for pane in &mut panes {
            let _ = pane.screen.frame()?;
            frames += 1;
        }
        frame_time += before.elapsed();
    }
    let wall = start_wall.elapsed().as_secs_f64();
    println!(
        "BUSY panes={count} seconds={wall:.0} snapshot_rounds_per_s={:.1} snapshot_us_per_pane={} mb_fed={:.1} cpu_pct_of_one_core={:.1}",
        frames as f64 / count as f64 / wall,
        frame_time.as_micros() / frames.max(1) as u128,
        fed as f64 / 1_048_576.0,
        (sample_self().cpu_seconds - start_cpu) / wall * 100.0,
    );
    for mut pane in panes {
        pane.pty.kill();
    }
    Ok(())
}
