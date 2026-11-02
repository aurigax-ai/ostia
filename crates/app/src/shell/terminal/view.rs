use std::io::Read as _;
use std::rc::Rc;
use std::thread;

use anyhow::Result;
use futures::StreamExt as _;
use futures::channel::mpsc::unbounded;
use gpui_kit::prelude::*;
use gpui_kit::{
    AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, KeyDownEvent,
    MouseButton, Render, Window, div, px, rgb,
};
use ostia_ui::theme::UiTheme;

use super::element::{Grid, GridHandler, TerminalElement};
use super::frame::{Frame, Rgb};
use super::pty::Pty;
use super::screen::Screen;

const READ_CHUNK: usize = 64 * 1024;
const SCROLLBACK_LINES: usize = 10_000;
const INITIAL_COLS: u16 = 80;
const INITIAL_ROWS: u16 = 24;
const BATCH_LIMIT: usize = 64;
const PADDING_LEFT: f32 = 6.;
const PADDING_TOP: f32 = 4.;

enum PtyEvent {
    Output(Vec<u8>),
    Exit,
}

pub enum TerminalEvent {
    Exited,
    TitleChanged,
}

impl EventEmitter<TerminalEvent> for TerminalView {}

pub struct TerminalView {
    screen: Screen,
    pty: Pty,
    frame: Rc<Frame>,
    dirty: bool,
    focus: FocusHandle,
    grid: Option<Grid>,
    scheme_id: &'static str,
    title: String,
}

fn key_bytes(event: &KeyDownEvent) -> Option<Vec<u8>> {
    let stroke = &event.keystroke;
    if stroke.modifiers.platform || (stroke.modifiers.control && stroke.modifiers.shift) {
        return None;
    }
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

impl TerminalView {
    pub fn spawn<V: 'static>(argv: &[String], cx: &mut Context<V>) -> Result<Entity<Self>> {
        let (pty, mut reader) = Pty::spawn(INITIAL_COLS, INITIAL_ROWS, argv)?;
        let mut screen = Screen::new(INITIAL_COLS, INITIAL_ROWS, SCROLLBACK_LINES)?;
        let scheme = cx.ui_theme().scheme;
        screen.apply_scheme(scheme)?;
        let (sender, mut receiver) = unbounded::<PtyEvent>();
        thread::spawn(move || {
            let mut buffer = vec![0u8; READ_CHUNK];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let output = PtyEvent::Output(buffer[..read].to_vec());
                        if sender.unbounded_send(output).is_err() {
                            return;
                        }
                    }
                }
            }
            let _ = sender.unbounded_send(PtyEvent::Exit);
        });
        let unset = Rgb { r: 0, g: 0, b: 0 };
        Ok(cx.new(|cx| {
            cx.spawn(async move |this, cx| {
                while let Some(first) = receiver.next().await {
                    let mut batch = vec![first];
                    while batch.len() < BATCH_LIMIT {
                        match receiver.try_next() {
                            Ok(Some(event)) => batch.push(event),
                            _ => break,
                        }
                    }
                    let alive = this.update(cx, |view: &mut Self, cx| view.apply(batch, cx));
                    if alive.is_err() {
                        break;
                    }
                }
            })
            .detach();
            Self {
                screen,
                pty,
                frame: Rc::new(Frame::blank(unset, unset, unset)),
                dirty: true,
                focus: cx.focus_handle(),
                grid: None,
                scheme_id: scheme.id,
                title: String::new(),
            }
        }))
    }

    fn apply(&mut self, batch: Vec<PtyEvent>, cx: &mut Context<Self>) {
        for event in batch {
            match event {
                PtyEvent::Output(bytes) => {
                    self.screen.feed(&bytes);
                    self.dirty = true;
                }
                PtyEvent::Exit => cx.emit(TerminalEvent::Exited),
            }
        }
        let title = self.screen.title();
        if title != self.title {
            self.title = title;
            cx.emit(TerminalEvent::TitleChanged);
        }
        cx.notify();
    }

    pub fn title(&self) -> String {
        self.title.clone()
    }

    pub fn grid(&self) -> Option<Grid> {
        self.grid
    }

    pub fn focus_handle(&self) -> FocusHandle {
        self.focus.clone()
    }

    fn set_grid(&mut self, grid: Grid, cx: &mut Context<Self>) {
        if self.grid == Some(grid) {
            return;
        }
        self.grid = Some(grid);
        let resized = self
            .screen
            .resize(grid.cols, grid.rows, grid.cell_width, grid.cell_height)
            .and_then(|()| self.pty.resize(grid.cols, grid.rows));
        if let Err(error) = resized {
            tracing::warn!(%error, "terminal resize failed");
        }
        self.dirty = true;
        cx.notify();
    }

    fn sync_scheme(&mut self, cx: &mut Context<Self>) {
        let scheme = cx.ui_theme().scheme;
        if scheme.id == self.scheme_id {
            return;
        }
        self.scheme_id = scheme.id;
        if let Err(error) = self.screen.apply_scheme(scheme) {
            tracing::warn!(%error, "terminal colors failed");
        }
        self.dirty = true;
    }

    fn refresh_frame(&mut self) {
        if !self.dirty {
            return;
        }
        self.dirty = false;
        match self.screen.frame() {
            Ok(frame) => self.frame = Rc::new(frame),
            Err(error) => tracing::warn!(%error, "terminal frame failed"),
        }
    }
}

impl Focusable for TerminalView {
    fn focus_handle(&self, _cx: &gpui_kit::App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_scheme(cx);
        self.refresh_frame();
        let weak = cx.entity().downgrade();
        let on_grid: GridHandler = Rc::new(move |grid, _, cx| {
            let _ = weak.update(cx, |view, cx| view.set_grid(grid, cx));
        });
        let focus = self.focus.clone();
        div()
            .id("terminal")
            .track_focus(&self.focus)
            .size_full()
            .pl(px(PADDING_LEFT))
            .pt(px(PADDING_TOP))
            .bg(rgb(self.frame.background.packed()))
            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                window.focus(&focus, cx);
            })
            .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                if let Some(bytes) = key_bytes(event) {
                    if let Err(error) = view.pty.write(&bytes) {
                        tracing::warn!(%error, "terminal write failed");
                    }
                    cx.stop_propagation();
                }
            }))
            .child(TerminalElement {
                frame: self.frame.clone(),
                focused: self.focus.is_focused(window),
                current_grid: self.grid,
                on_grid,
            })
    }
}
