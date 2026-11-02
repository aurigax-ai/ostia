use std::cell::RefCell;
use std::env;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use futures::StreamExt as _;
use futures::channel::mpsc::unbounded;
use gpui_kit::{
    App, Bounds, Context, FocusHandle, InteractiveElement as _, IntoElement, KeyDownEvent,
    ParentElement as _, Render, Styled as _, Window, WindowBounds, WindowOptions, div, px, rgb,
    size,
};
use spike_terminal::element::{LINE_HEIGHT, TerminalElement};
use spike_terminal::frame::Frame;
use spike_terminal::proc_stats::{pss_tree_mb, sample_self};
use spike_terminal::session::{Event, Pane, Sink, spawn_panes};

const PANE_COLS: u16 = 48;
const PANE_ROWS: u16 = 16;
const PANE_WIDTH: f32 = 272.0;
const GRID_COLUMNS: usize = 6;
const BATCH_LIMIT: usize = 64;
const BUSY_COMMAND: &str = "while :; do seq -f 'ostia-load %g xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' 20; sleep 0.05; done\n";

#[derive(Default)]
struct Stats {
    painted: u64,
    pending_key: Option<(usize, Instant)>,
    latencies_us: Vec<u128>,
}

struct Settings {
    panes: usize,
    loaders: usize,
    seconds: u64,
    synthetic_keys: bool,
}

fn setting(name: &str, default: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

struct Grid {
    panes: Vec<Pane>,
    frames: Vec<Rc<Frame>>,
    dirty: Vec<bool>,
    focus: FocusHandle,
    active: usize,
    stats: Rc<RefCell<Stats>>,
}

impl Grid {
    fn apply(&mut self, event: Event) {
        if let Event::Output(index, bytes) = event {
            self.panes[index].screen.feed(&bytes);
            self.dirty[index] = true;
        }
    }

    fn send(&mut self, index: usize, bytes: &[u8]) {
        self.stats.borrow_mut().pending_key = Some((index, Instant::now()));
        let _ = self.panes[index].pty.write(bytes);
    }

    fn pids(&self) -> Vec<u32> {
        self.panes
            .iter()
            .filter_map(|pane| pane.pty.process_id())
            .collect()
    }
}

fn key_bytes(event: &KeyDownEvent) -> Option<Vec<u8>> {
    let stroke = &event.keystroke;
    if stroke.modifiers.control {
        let letter = stroke.key.chars().next().filter(char::is_ascii_lowercase)?;
        return Some(vec![letter as u8 & 0x1f]);
    }
    let named: Option<&[u8]> = match stroke.key.as_str() {
        "enter" => Some(b"\r"),
        "backspace" => Some(&[0x7f]),
        "tab" => Some(b"\t"),
        "escape" => Some(&[0x1b]),
        "up" => Some(b"\x1b[A"),
        "down" => Some(b"\x1b[B"),
        "right" => Some(b"\x1b[C"),
        "left" => Some(b"\x1b[D"),
        _ => None,
    };
    match named {
        Some(bytes) => Some(bytes.to_vec()),
        None => stroke
            .key_char
            .as_ref()
            .map(|text| text.as_bytes().to_vec()),
    }
}

impl Render for Grid {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        for index in 0..self.panes.len() {
            if self.dirty[index] {
                if let Ok(frame) = self.panes[index].screen.frame() {
                    self.frames[index] = Rc::new(frame);
                }
                self.dirty[index] = false;
            }
        }
        let panes = self.frames.iter().enumerate().map(|(index, frame)| {
            let stats = self.stats.clone();
            let on_paint: Rc<dyn Fn()> = Rc::new(move || {
                let mut stats = stats.borrow_mut();
                stats.painted += 1;
                if let Some((pending, at)) = stats.pending_key {
                    if pending == index {
                        stats.latencies_us.push(at.elapsed().as_micros());
                        stats.pending_key = None;
                    }
                }
            });
            div()
                .w(px(PANE_WIDTH))
                .h(px(LINE_HEIGHT * f32::from(PANE_ROWS)))
                .child(TerminalElement {
                    frame: frame.clone(),
                    on_paint,
                })
        });
        div()
            .id("grid")
            .size_full()
            .bg(rgb(0x202020))
            .flex()
            .flex_wrap()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|grid, event: &KeyDownEvent, _window, cx| {
                if let Some(bytes) = key_bytes(event) {
                    let active = grid.active;
                    grid.send(active, &bytes);
                    cx.notify();
                }
            }))
            .children(panes)
    }
}

fn percentile(sorted: &[u128], fraction: f64) -> u128 {
    sorted
        .get(((sorted.len() as f64 * fraction) as usize).min(sorted.len().saturating_sub(1)))
        .copied()
        .unwrap_or(0)
}

fn main() -> Result<()> {
    let settings = Settings {
        panes: usize::try_from(setting("SPIKE_PANES", 30))?,
        loaders: usize::try_from(setting("SPIKE_LOADERS", 0))?,
        seconds: setting("SPIKE_SECONDS", 60),
        synthetic_keys: setting("SPIKE_KEYS", 0) == 1,
    };
    let (tx, mut rx) = unbounded::<Event>();
    let sink: Sink = Arc::new(move |event| {
        let _ = tx.unbounded_send(event);
    });
    let panes = spawn_panes(settings.panes, PANE_COLS, PANE_ROWS, &[], &sink)?;
    let mut panes = panes;
    for pane in panes.iter_mut().take(settings.loaders) {
        pane.pty.write(BUSY_COMMAND.as_bytes())?;
    }
    let rows = settings.panes.div_ceil(GRID_COLUMNS);
    let window_size = size(
        px(PANE_WIDTH * GRID_COLUMNS as f32),
        px(LINE_HEIGHT * f32::from(PANE_ROWS) * rows as f32),
    );

    gpui_kit::application().run(move |cx: &mut App| {
        gpui_kit::init(cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                gpui_kit::point(px(0.0), px(0.0)),
                window_size,
            ))),
            ..WindowOptions::default()
        };
        let opened = gpui_kit::open_window(options, cx, move |window, cx| {
            cx.new(|cx| {
                let focus = cx.focus_handle();
                window.focus(&focus, cx);
                let count = panes.len();
                let stats = Rc::new(RefCell::new(Stats::default()));
                let grid = Grid {
                    panes,
                    frames: Vec::new(),
                    dirty: vec![true; count],
                    focus,
                    active: 0,
                    stats,
                };
                let blank = Rc::new(Frame {
                    lines: Vec::new(),
                    cursor: None,
                    background: spike_terminal::frame::Rgb { r: 0, g: 0, b: 0 },
                    foreground: spike_terminal::frame::Rgb {
                        r: 255,
                        g: 255,
                        b: 255,
                    },
                });
                let mut grid = grid;
                grid.frames = vec![blank; count];

                cx.spawn(async move |this, cx| {
                    while let Some(first) = rx.next().await {
                        let mut batch = vec![first];
                        while batch.len() < BATCH_LIMIT {
                            match rx.try_next() {
                                Ok(Some(event)) => batch.push(event),
                                _ => break,
                            }
                        }
                        let alive = this.update(cx, |grid, cx| {
                            for event in batch {
                                grid.apply(event);
                            }
                            cx.notify();
                        });
                        if alive.is_err() {
                            break;
                        }
                    }
                })
                .detach();

                cx.spawn(async move |this, cx| {
                    let started = Instant::now();
                    let mut last_painted = 0u64;
                    let mut last_cpu = sample_self().cpu_seconds;
                    let mut last_at = started;
                    loop {
                        cx.background_executor().timer(Duration::from_secs(10)).await;
                        let report = this.update(cx, |grid, _| {
                            let own = sample_self();
                            let now = Instant::now();
                            let wall = (now - last_at).as_secs_f64();
                            let painted = grid.stats.borrow().painted;
                            let line = format!(
                                "STAT t={:.0}s paints_per_s={:.0} cpu_pct_of_one_core={:.1} pss_mb_total={:.0}",
                                started.elapsed().as_secs_f64(),
                                (painted - last_painted) as f64 / wall,
                                (own.cpu_seconds - last_cpu) / wall * 100.0,
                                own.pss_mb + pss_tree_mb(&grid.pids()),
                            );
                            last_painted = painted;
                            last_cpu = own.cpu_seconds;
                            last_at = now;
                            line
                        });
                        match report {
                            Ok(line) => println!("{line}"),
                            Err(_) => break,
                        }
                    }
                })
                .detach();

                if settings.synthetic_keys {
                    cx.spawn(async move |this, cx| {
                        loop {
                            cx.background_executor()
                                .timer(Duration::from_millis(100))
                                .await;
                            let sent = this.update(cx, |grid, cx| {
                                let active = grid.active;
                                grid.send(active, b"x");
                                cx.notify();
                            });
                            if sent.is_err() {
                                break;
                            }
                        }
                    })
                    .detach();
                }

                let seconds = settings.seconds;
                cx.spawn(async move |this, cx| {
                    cx.background_executor()
                        .timer(Duration::from_secs(seconds))
                        .await;
                    let _ = this.update(cx, |grid, cx| {
                        let mut latencies = grid.stats.borrow().latencies_us.clone();
                        latencies.sort_unstable();
                        println!(
                            "KEYSTROKE samples={} p50_us={} p95_us={} max_us={}",
                            latencies.len(),
                            percentile(&latencies, 0.5),
                            percentile(&latencies, 0.95),
                            latencies.last().copied().unwrap_or(0),
                        );
                        for pane in &mut grid.panes {
                            pane.pty.kill();
                        }
                        cx.quit();
                    });
                })
                .detach();
                grid
            })
        });
        if let Err(error) = opened {
            eprintln!("open_window failed: {error}");
            cx.quit();
        }
    });
    Ok(())
}
