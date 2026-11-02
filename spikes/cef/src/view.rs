use crate::frame::SharedSlot;
use crate::host::{Page, new_geometry, open_page};
use crate::input;
use cef::{ImplBrowser, ImplBrowserHost};
use gpui_kit::component::button::*;
use gpui_kit::*;
use std::time::Duration;

const TOOLBAR_HEIGHT: f32 = 40.0;

pub struct Settings {
    pub url: String,
    pub pages: usize,
    pub lazy_ms: u64,
    pub run_secs: u64,
    pub profile_dir: String,
}

impl Settings {
    pub fn from_env() -> Self {
        let number = |name: &str, default: u64| {
            std::env::var(name)
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(default)
        };
        Self {
            url: std::env::var("SPIKE_URL").unwrap_or_else(|_| "about:blank".into()),
            pages: number("SPIKE_PAGES", 1) as usize,
            lazy_ms: number("SPIKE_LAZY_MS", 0),
            run_secs: number("SPIKE_RUN_SECS", 0),
            profile_dir: std::env::var("SPIKE_PROFILE")
                .unwrap_or_else(|_| "/tmp/spike-cef-profile".into()),
        }
    }
}

pub struct BrowserView {
    settings: Settings,
    args: std::rc::Rc<cef::args::Args>,
    pages: Vec<Page>,
    active: usize,
    menu_open: bool,
    focus: FocusHandle,
    shown_version: u64,
    shown: Option<std::sync::Arc<RenderImage>>,
    last_size: (i32, i32),
    last_logged_frames: u64,
    init_tick: Option<u64>,
    ticks: u64,
}

impl BrowserView {
    pub fn new(
        settings: Settings,
        args: std::rc::Rc<cef::args::Args>,
        cx: &mut Context<Self>,
    ) -> Self {
        let view = Self {
            settings,
            args,
            pages: Vec::new(),
            active: 0,
            menu_open: false,
            focus: cx.focus_handle(),
            shown_version: 0,
            shown: None,
            last_size: (0, 0),
            last_logged_frames: 0,
            init_tick: None,
            ticks: 0,
        };
        cx.spawn(async move |this, cx| {
            let (lazy_ms, run_secs) = this
                .update(cx, |view, _| {
                    (view.settings.lazy_ms, view.settings.run_secs)
                })
                .unwrap_or((0, 0));
            cx.background_executor()
                .timer(Duration::from_millis(lazy_ms))
                .await;
            this.update(cx, |view, cx| view.start_cef(cx)).ok();
            let mut ticks: u64 = 0;
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(8))
                    .await;
                cef::do_message_loop_work();
                ticks += 1;
                let keep = this.update(cx, |view, cx| view.pull(ticks, cx)).is_ok();
                if !keep || (run_secs > 0 && ticks * 8 >= run_secs * 1000) {
                    break;
                }
            }
            this.update(cx, |view, _| view.close_all()).ok();
            for _ in 0..50 {
                cef::do_message_loop_work();
                cx.background_executor()
                    .timer(Duration::from_millis(10))
                    .await;
            }
            cef::shutdown();
            cx.update(|cx| cx.quit());
        })
        .detach();
        view
    }

    fn start_cef(&mut self, cx: &mut Context<Self>) {
        eprintln!("SPIKE cef-init-begin");
        if !crate::host::initialize_cef(&self.args, &self.settings.profile_dir) {
            eprintln!("SPIKE cef-init-failed");
            return;
        }
        eprintln!("SPIKE cef-init-done");
        self.init_tick = Some(self.ticks);
        cx.notify();
    }

    fn create_pages(&mut self, cx: &mut Context<Self>) {
        let (width, height) = self.last_size;
        for index in 0..self.settings.pages {
            let geometry = new_geometry(width.max(640), height.max(480), 1.0);
            let slot: SharedSlot = Default::default();
            let context_dir = format!("{}/ctx-{}", self.settings.profile_dir, index);
            match open_page(&self.settings.url, &context_dir, geometry, slot) {
                Some(page) => self.pages.push(page),
                None => eprintln!("SPIKE page-{index}-create-failed"),
            }
        }
        cx.notify();
    }

    fn close_all(&mut self) {
        for page in self.pages.drain(..) {
            if let Some(host) = page.browser.host() {
                host.close_browser(1);
            }
        }
    }

    fn pull(&mut self, ticks: u64, cx: &mut Context<Self>) {
        self.ticks = ticks;
        if self.init_tick.is_some_and(|at| ticks == at + 40) {
            self.create_pages(cx);
        }
        let Some(page) = self.pages.get(self.active) else {
            return;
        };
        let (version, frames, title) = {
            let slot = page.slot.borrow();
            (slot.version, slot.frames, slot.title.clone())
        };
        if version != self.shown_version {
            cx.notify();
        }
        if ticks % 125 == 0 {
            let total: u64 = self.pages.iter().map(|p| p.slot.borrow().frames).sum();
            eprintln!(
                "SPIKE t={}s frames_active={} frames_delta={} frames_all={} title={}",
                ticks / 125,
                frames,
                frames - self.last_logged_frames,
                total,
                title
            );
            self.last_logged_frames = frames;
        }
    }

    fn active_browser(&self) -> Option<&cef::Browser> {
        self.pages.get(self.active).map(|page| &page.browser)
    }

    fn local(&self, position: Point<Pixels>) -> (f32, f32) {
        (
            f32::from(position.x),
            f32::from(position.y) - TOOLBAR_HEIGHT,
        )
    }

    fn sync_size(&mut self, window: &Window) {
        let size = window.viewport_size();
        let width = f32::from(size.width) as i32;
        let height = f32::from(size.height) as i32 - TOOLBAR_HEIGHT as i32;
        if (width, height) == self.last_size || width <= 0 || height <= 0 {
            return;
        }
        self.last_size = (width, height);
        for page in &self.pages {
            page.geometry.width.set(width);
            page.geometry.height.set(height);
            page.geometry.scale.set(window.scale_factor());
            if let Some(host) = page.browser.host() {
                host.was_resized();
            }
        }
    }
}

impl Render for BrowserView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_size(window);
        let image = self.pages.get(self.active).and_then(|page| {
            let slot = page.slot.borrow();
            self.shown_version = slot.version;
            slot.image.clone()
        });
        if let Some(previous) = self.shown.take() {
            if image
                .as_ref()
                .is_none_or(|current| current.id != previous.id)
            {
                window.drop_image(previous).ok();
            }
        }
        self.shown = image.clone();

        let menu = self.menu_open.then(|| {
            deferred(
                div()
                    .absolute()
                    .top(px(TOOLBAR_HEIGHT))
                    .left(px(8.0))
                    .w(px(200.0))
                    .p_2()
                    .gap_1()
                    .flex()
                    .flex_col()
                    .bg(rgb(0x1f2933))
                    .border_1()
                    .border_color(rgb(0x52606d))
                    .occlude()
                    .child(
                        Button::new("m-reload")
                            .label("Reload")
                            .on_click(cx.listener(|view, _, _, cx| {
                                if let Some(browser) = view.active_browser() {
                                    browser.reload();
                                }
                                view.menu_open = false;
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("m-close")
                            .label("Close menu")
                            .on_click(cx.listener(|view, _, _, cx| {
                                view.menu_open = false;
                                cx.notify();
                            })),
                    ),
            )
            .with_priority(1)
        });

        let toolbar = div()
            .h(px(TOOLBAR_HEIGHT))
            .flex()
            .items_center()
            .gap_2()
            .px_2()
            .bg(rgb(0x323f4b))
            .child(
                Button::new("menu")
                    .primary()
                    .label("Menu")
                    .on_click(cx.listener(|view, _, _, cx| {
                        view.menu_open = !view.menu_open;
                        cx.notify();
                    })),
            )
            .children((0..self.pages.len()).map(|index| {
                Button::new(("page", index))
                    .label(format!("Page {}", index + 1))
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.active = index;
                        view.shown_version = 0;
                        cx.notify();
                    }))
            }));

        let surface = div()
            .id("surface")
            .track_focus(&self.focus)
            .flex_1()
            .relative()
            .overflow_hidden()
            .bg(rgb(0xffffff))
            .on_mouse_move(cx.listener(|view, event: &MouseMoveEvent, _, _| {
                if let Some(browser) = view.active_browser() {
                    let (x, y) = view.local(event.position);
                    let flags = input::modifier_flags(event.modifiers, event.pressed_button);
                    input::send_move(browser, &input::mouse_event(x, y, flags), false);
                }
            }))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::mouse_down))
            .on_mouse_down(MouseButton::Middle, cx.listener(Self::mouse_down))
            .on_mouse_down(MouseButton::Right, cx.listener(Self::mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::mouse_up))
            .on_mouse_up(MouseButton::Middle, cx.listener(Self::mouse_up))
            .on_mouse_up(MouseButton::Right, cx.listener(Self::mouse_up))
            .on_scroll_wheel(cx.listener(|view, event: &ScrollWheelEvent, _, _| {
                if let Some(browser) = view.active_browser() {
                    let (x, y) = view.local(event.position);
                    let delta = event.delta.pixel_delta(px(20.0));
                    let flags = input::modifier_flags(event.modifiers, None);
                    input::send_wheel(
                        browser,
                        &input::mouse_event(x, y, flags),
                        f32::from(delta.x),
                        f32::from(delta.y),
                    );
                }
            }))
            .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, _| {
                if let Some(browser) = view.active_browser() {
                    input::send_key_down(browser, &event.keystroke);
                }
            }))
            .on_key_up(cx.listener(|view, event: &KeyUpEvent, _, _| {
                if let Some(browser) = view.active_browser() {
                    input::send_key_up(browser, &event.keystroke);
                }
            }))
            .on_drop(cx.listener(|_, paths: &ExternalPaths, _, _| {
                eprintln!("SPIKE gpui-drop paths={:?}", paths.paths());
            }))
            .children(image.map(|image| img(image).size_full().object_fit(ObjectFit::Fill)))
            .children(menu);

        div()
            .size_full()
            .flex()
            .flex_col()
            .child(toolbar)
            .child(surface)
    }
}

impl BrowserView {
    fn mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        if let Some(browser) = self.active_browser() {
            if let Some(host) = browser.host() {
                host.set_focus(1);
            }
            let (x, y) = self.local(event.position);
            let flags = input::modifier_flags(event.modifiers, Some(event.button));
            input::send_click(
                browser,
                event.button,
                &input::mouse_event(x, y, flags),
                false,
                event.click_count,
            );
        }
    }

    fn mouse_up(&mut self, event: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        if let Some(browser) = self.active_browser() {
            let (x, y) = self.local(event.position);
            let flags = input::modifier_flags(event.modifiers, None);
            input::send_click(
                browser,
                event.button,
                &input::mouse_event(x, y, flags),
                true,
                event.click_count,
            );
        }
    }
}
