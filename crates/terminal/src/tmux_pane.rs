use std::future::Future;
use std::sync::Arc;

use ostia_base::js::js_number;
use ostia_base::{EventHub, Result};
use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use crate::screen_replay::{SCREEN_INFO_FORMAT, screen_replay};
use crate::screen_title_filter::ScreenTitleFilter;
use crate::tmux_command::{META_OPTION, encode_meta, send_keys_commands, tmux_quote};

pub const LOST_EXIT_CODE: i32 = 1;

const REDRAW_RESET: &str = "\x1b[?1049l\x1b[0m\x1b[H\x1b[2J";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeptLink {
    Up,
    Reconnecting,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PaneExit {
    pub exit_code: i32,
}

pub trait PaneServer: Send + Sync + 'static {
    fn send(&self, line: &str);

    fn command(&self, line: &str) -> impl Future<Output = Result<Vec<String>>> + Send;

    fn batch(
        &self,
        lines: &[String],
        on_last_reply: &(dyn Fn() + Send + Sync),
    ) -> impl Future<Output = Result<Vec<Vec<String>>>> + Send;

    fn forget(&self, pane_id: &str);

    fn retry(&self);
}

struct PaneState {
    foreground: String,
    foreground_waiters: Vec<Box<dyn FnOnce() + Send>>,
    link: KeptLink,
    exited: bool,
    detached: bool,
    held: Option<Vec<String>>,
    unheard: String,
    titles: ScreenTitleFilter,
    cols: u32,
    rows: u32,
    data: Vec<UnboundedSender<String>>,
}

pub struct TmuxPane<S: PaneServer> {
    server: Arc<S>,
    window_id: String,
    pane_id: String,
    pid: u32,
    state: Mutex<PaneState>,
    links: EventHub<KeptLink>,
    exits: EventHub<PaneExit>,
}

fn text_rows(reply: Option<&[String]>) -> Vec<&str> {
    reply
        .unwrap_or_default()
        .iter()
        .map(String::as_str)
        .collect()
}

impl<S: PaneServer> TmuxPane<S> {
    pub fn new(server: S, window_id: &str, pane_id: &str, pid: u32, cols: u32, rows: u32) -> Self {
        Self {
            server: Arc::new(server),
            window_id: window_id.to_owned(),
            pane_id: pane_id.to_owned(),
            pid,
            state: Mutex::new(PaneState {
                foreground: String::new(),
                foreground_waiters: Vec::new(),
                link: KeptLink::Up,
                exited: false,
                detached: false,
                held: None,
                unheard: String::new(),
                titles: ScreenTitleFilter::new(),
                cols,
                rows,
                data: Vec::new(),
            }),
            links: EventHub::default(),
            exits: EventHub::default(),
        }
    }

    pub fn window_id(&self) -> &str {
        &self.window_id
    }

    pub fn pane_id(&self) -> &str {
        &self.pane_id
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn size(&self) -> (u32, u32) {
        let state = self.state.lock();
        (state.cols, state.rows)
    }

    pub fn has_exited(&self) -> bool {
        self.state.lock().exited
    }

    pub fn set_foreground(&self, command: &str) {
        let waiters = {
            let mut state = self.state.lock();
            command.clone_into(&mut state.foreground);
            std::mem::take(&mut state.foreground_waiters)
        };
        for waiter in waiters {
            waiter();
        }
    }

    pub fn after_foreground(&self, waiter: impl FnOnce() + Send + 'static) {
        self.state.lock().foreground_waiters.push(Box::new(waiter));
    }

    pub fn process(&self) -> String {
        self.state.lock().foreground.clone()
    }

    pub fn hold_early_output(&self, raw: &str) {
        let mut state = self.state.lock();
        let text = state.titles.push(raw);
        state.unheard = text;
    }

    pub fn skip_early_output(&self, raw: &str) {
        self.state.lock().titles.push(raw);
    }

    pub fn on_data(&self) -> UnboundedReceiver<String> {
        let (sender, receiver) = unbounded_channel();
        let mut state = self.state.lock();
        let unheard = std::mem::take(&mut state.unheard);
        if !unheard.is_empty() {
            let _ = sender.send(unheard);
        }
        state.data.push(sender);
        receiver
    }

    pub fn on_exit(&self) -> UnboundedReceiver<PaneExit> {
        self.exits.subscribe()
    }

    pub fn link_state(&self) -> KeptLink {
        self.state.lock().link
    }

    pub fn on_link(&self) -> UnboundedReceiver<KeptLink> {
        self.links.subscribe()
    }

    pub fn linked(&self, link: KeptLink) {
        {
            let mut state = self.state.lock();
            if state.link == link {
                return;
            }
            state.link = link;
        }
        self.links.emit(link);
    }

    pub fn retry_link(&self) {
        self.server.retry();
    }

    pub fn write(&self, data: &str) {
        if self.is_gone() {
            return;
        }
        for line in send_keys_commands(&self.pane_id, data) {
            self.server.send(&line);
        }
    }

    pub fn paste(&self, text: &str) {
        if self.is_gone() {
            return;
        }
        let buffer = tmux_quote(&format!("ostia-paste-{}", self.pane_id));
        let lines = [
            format!("set-buffer -b {buffer} -- {}", tmux_quote(text)),
            format!("paste-buffer -d -p -r -b {buffer} -t {}", self.pane_id),
        ];
        for line in lines {
            self.server.send(&line);
        }
    }

    pub fn resize(&self, cols: u32, rows: u32) {
        {
            let mut state = self.state.lock();
            if state.exited || state.detached || cols == 0 || rows == 0 {
                return;
            }
            if cols == state.cols && rows == state.rows {
                return;
            }
            state.cols = cols;
            state.rows = rows;
        }
        self.server.send(&format!(
            "resize-window -t {} -x {cols} -y {rows}",
            self.window_id
        ));
    }

    pub fn kill(&self) {
        {
            let mut state = self.state.lock();
            if state.exited || state.detached {
                return;
            }
            state.detached = true;
        }
        self.server.forget(&self.pane_id);
        self.kill_window();
    }

    pub fn detach(&self) {
        self.state.lock().detached = true;
        self.server.forget(&self.pane_id);
    }

    pub fn set_meta(&self, meta: &Value) {
        if self.is_gone() {
            return;
        }
        self.server.send(&format!(
            "set -w -t {} {META_OPTION} {}",
            self.window_id,
            tmux_quote(&encode_meta(meta))
        ));
    }

    pub async fn shell_pid(&self) -> Result<Option<u64>> {
        let replies = self
            .server
            .command(&format!(
                "display-message -p -t {} \"#{{pane_pid}}\"",
                self.pane_id
            ))
            .await?;
        let pid = js_number(replies.first().map_or("", String::as_str));
        let integer = pid.is_finite() && pid.fract() == 0.0 && pid > 0.0 && pid < u64::MAX as f64;
        Ok(integer.then_some(pid as u64))
    }

    pub async fn current_command(&self) -> Result<String> {
        let replies = self
            .server
            .command(&format!(
                "display-message -p -t {} \"#{{pane_current_command}}\"",
                self.pane_id
            ))
            .await?;
        let command = replies.first().cloned().unwrap_or_default();
        self.state.lock().foreground.clone_from(&command);
        Ok(command)
    }

    pub async fn redraw(&self) -> Result<()> {
        let (cols, rows) = {
            let state = self.state.lock();
            if state.exited || state.detached {
                return Ok(());
            }
            (state.cols, state.rows)
        };
        let screen = match self.capture(cols, rows, false).await {
            Ok(screen) => screen,
            Err(err) => {
                self.live();
                return Err(err);
            }
        };
        let mut state = self.state.lock();
        let held = state.held.take().unwrap_or_default();
        Self::emit_into(&mut state, format!("{REDRAW_RESET}{screen}"));
        if !held.is_empty() {
            Self::emit_into(&mut state, held.concat());
        }
        Ok(())
    }

    pub async fn snapshot(&self, cols: u32, rows: u32) -> Result<String> {
        self.capture(cols, rows, true).await
    }

    async fn capture(&self, cols: u32, rows: u32, history: bool) -> Result<String> {
        let resize = {
            let mut state = self.state.lock();
            state.held = Some(Vec::new());
            if cols > 0 && rows > 0 && (cols != state.cols || rows != state.rows) {
                state.cols = cols;
                state.rows = rows;
                true
            } else {
                false
            }
        };
        if resize {
            self.server.send(&format!(
                "resize-window -t {} -x {cols} -y {rows}",
                self.window_id
            ));
        }
        let alternate_lines = [format!(
            "display-message -p -t {} \"#{{alternate_on}}\"",
            self.pane_id
        )];
        let alternate_replies = self.server.batch(&alternate_lines, &|| {}).await?;
        let alternate = alternate_replies
            .first()
            .and_then(|reply| reply.first())
            .map_or("0", String::as_str);
        let on_alternate = alternate == "1";
        let mut lines = vec![if on_alternate {
            format!("capture-pane -p -e -a -t {}", self.pane_id)
        } else {
            format!(
                "capture-pane -p -e {}-t {}",
                if history { "-S - " } else { "" },
                self.pane_id
            )
        }];
        if on_alternate {
            lines.push(format!("capture-pane -p -e -t {}", self.pane_id));
        }
        lines.push(format!(
            "display-message -p -t {} {}",
            self.pane_id,
            tmux_quote(SCREEN_INFO_FORMAT)
        ));
        let replies = self
            .server
            .batch(&lines, &|| {
                self.state.lock().held = Some(Vec::new());
            })
            .await?;
        let info = replies
            .last()
            .map(|reply| reply.concat())
            .unwrap_or_default();
        let normal = text_rows(replies.first().map(Vec::as_slice));
        let alternate_rows = on_alternate.then(|| text_rows(replies.get(1).map(Vec::as_slice)));
        Ok(screen_replay(&info, &normal, alternate_rows.as_deref()))
    }

    pub fn live(&self) {
        let mut state = self.state.lock();
        let held = state.held.take();
        if let Some(held) = held.filter(|held| !held.is_empty()) {
            Self::emit_into(&mut state, held.concat());
        }
    }

    pub fn deliver(&self, raw: &str) {
        let mut state = self.state.lock();
        if state.detached {
            return;
        }
        let data = state.titles.push(raw);
        Self::emit_into(&mut state, data);
    }

    fn emit_into(state: &mut PaneState, data: String) {
        if state.detached || data.is_empty() {
            return;
        }
        if let Some(held) = state.held.as_mut() {
            held.push(data);
            return;
        }
        state
            .data
            .retain(|sender| sender.send(data.clone()).is_ok());
    }

    pub fn died(&self, exit_code: i32) {
        let detached = {
            let mut state = self.state.lock();
            if state.exited {
                return;
            }
            state.exited = true;
            state.detached
        };
        self.server.forget(&self.pane_id);
        self.kill_window();
        if detached {
            return;
        }
        self.exits.emit(PaneExit { exit_code });
    }

    pub fn lost(&self) {
        let detached = {
            let mut state = self.state.lock();
            if state.exited {
                return;
            }
            state.exited = true;
            state.detached
        };
        if detached {
            return;
        }
        self.exits.emit(PaneExit {
            exit_code: LOST_EXIT_CODE,
        });
    }

    fn is_gone(&self) -> bool {
        let state = self.state.lock();
        state.exited || state.detached
    }

    fn kill_window(&self) {
        self.server
            .send(&format!("kill-window -t {}", self.window_id));
    }
}
