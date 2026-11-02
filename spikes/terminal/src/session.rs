use std::sync::Arc;
use std::thread;

use std::io::Read as _;

use anyhow::Result;

use crate::pty::Pty;
use crate::screen::Screen;

pub const READ_CHUNK: usize = 64 * 1024;
pub const SCROLLBACK_LINES: usize = 10_000;

pub enum Event {
    Output(usize, Vec<u8>),
    Exit(usize),
}

pub type Sink = Arc<dyn Fn(Event) + Send + Sync>;

pub struct Pane {
    pub screen: Screen,
    pub pty: Pty,
}

pub fn spawn_pane(index: usize, cols: u16, rows: u16, argv: &[&str], sink: Sink) -> Result<Pane> {
    let (pty, mut reader) = Pty::spawn(cols, rows, argv)?;
    thread::spawn(move || {
        let mut buffer = vec![0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => sink(Event::Output(index, buffer[..read].to_vec())),
            }
        }
        sink(Event::Exit(index));
    });
    Ok(Pane {
        screen: Screen::new(cols, rows, SCROLLBACK_LINES)?,
        pty,
    })
}

pub fn spawn_panes(
    count: usize,
    cols: u16,
    rows: u16,
    argv: &[&str],
    sink: &Sink,
) -> Result<Vec<Pane>> {
    (0..count)
        .map(|index| spawn_pane(index, cols, rows, argv, sink.clone()))
        .collect()
}
