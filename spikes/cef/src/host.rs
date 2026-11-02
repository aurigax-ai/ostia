use crate::frame::{SharedSlot, store_bgra};
use cef::{rc::Rc as CefRc, *};
use std::cell::Cell;
use std::rc::Rc;

pub struct Geometry {
    pub width: Cell<i32>,
    pub height: Cell<i32>,
    pub scale: Cell<f32>,
}

pub type SharedGeometry = Rc<Geometry>;

pub fn new_geometry(width: i32, height: i32, scale: f32) -> SharedGeometry {
    Rc::new(Geometry {
        width: Cell::new(width),
        height: Cell::new(height),
        scale: Cell::new(scale),
    })
}

#[derive(Clone)]
pub struct AppConfig {
    pub switches: Vec<(String, Option<String>)>,
}

impl AppConfig {
    pub fn from_env() -> Self {
        let raw = std::env::var("SPIKE_CEF_SWITCHES").unwrap_or_default();
        let switches = raw
            .split(',')
            .filter(|entry| !entry.is_empty())
            .map(|entry| match entry.split_once('=') {
                Some((name, value)) => (name.to_string(), Some(value.to_string())),
                None => (entry.to_string(), None),
            })
            .collect();
        Self { switches }
    }
}

wrap_app! {
    struct SpikeApp {
        config: AppConfig,
    }

    impl App {
        fn on_before_command_line_processing(
            &self,
            _process_type: Option<&CefString>,
            command_line: Option<&mut CommandLine>,
        ) {
            let Some(command_line) = command_line else {
                return;
            };
            command_line.append_switch(Some(&"enable-logging=stderr".into()));
            for (name, value) in &self.config.switches {
                match value {
                    Some(value) => command_line
                        .append_switch_with_value(Some(&name.as_str().into()), Some(&value.as_str().into())),
                    None => command_line.append_switch(Some(&name.as_str().into())),
                }
            }
        }
    }
}

pub fn build_app() -> App {
    SpikeApp::new(AppConfig::from_env())
}

#[derive(Clone)]
pub struct RenderState {
    pub slot: SharedSlot,
    pub geometry: SharedGeometry,
}

wrap_render_handler! {
    struct SpikeRenderHandler {
        state: RenderState,
    }

    impl RenderHandler {
        fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut Rect>) {
            if let Some(rect) = rect {
                rect.x = 0;
                rect.y = 0;
                rect.width = self.state.geometry.width.get().max(1);
                rect.height = self.state.geometry.height.get().max(1);
            }
        }

        fn screen_info(
            &self,
            _browser: Option<&mut Browser>,
            screen_info: Option<&mut ScreenInfo>,
        ) -> ::std::os::raw::c_int {
            match screen_info {
                Some(screen_info) => {
                    screen_info.device_scale_factor = self.state.geometry.scale.get();
                    true as _
                }
                None => false as _,
            }
        }

        fn screen_point(
            &self,
            _browser: Option<&mut Browser>,
            _view_x: ::std::os::raw::c_int,
            _view_y: ::std::os::raw::c_int,
            _screen_x: Option<&mut ::std::os::raw::c_int>,
            _screen_y: Option<&mut ::std::os::raw::c_int>,
        ) -> ::std::os::raw::c_int {
            false as _
        }

        fn on_paint(
            &self,
            _browser: Option<&mut Browser>,
            type_: PaintElementType,
            _dirty_rects: Option<&[Rect]>,
            buffer: *const u8,
            width: ::std::os::raw::c_int,
            height: ::std::os::raw::c_int,
        ) {
            if type_ != PaintElementType::default() || buffer.is_null() || width <= 0 || height <= 0 {
                return;
            }
            let length = width as usize * height as usize * 4;
            let bgra = unsafe { std::slice::from_raw_parts(buffer, length) };
            store_bgra(&self.state.slot, bgra, width as u32, height as u32);
        }
    }
}

wrap_display_handler! {
    struct SpikeDisplayHandler {
        slot: SharedSlot,
    }

    impl DisplayHandler {
        fn on_title_change(&self, _browser: Option<&mut Browser>, title: Option<&CefString>) {
            if let Some(title) = title {
                self.slot.borrow_mut().title = title.to_string();
            }
        }
    }
}

wrap_client! {
    struct SpikeClient {
        render_handler: RenderHandler,
        display_handler: DisplayHandler,
    }

    impl Client {
        fn render_handler(&self) -> Option<RenderHandler> {
            Some(self.render_handler.clone())
        }

        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(self.display_handler.clone())
        }
    }
}

pub fn initialize_cef(args: &cef::args::Args, root_cache: &str) -> bool {
    let settings = Settings {
        windowless_rendering_enabled: true as _,
        external_message_pump: true as _,
        root_cache_path: root_cache.into(),
        cache_path: root_cache.into(),
        ..Default::default()
    };
    let mut app = build_app();
    initialize(
        Some(args.as_main_args()),
        Some(&settings),
        Some(&mut app),
        std::ptr::null_mut(),
    ) == 1
}

pub struct Page {
    pub browser: Browser,
    pub slot: SharedSlot,
    pub geometry: SharedGeometry,
}

pub fn open_page(
    url: &str,
    context_dir: &str,
    geometry: SharedGeometry,
    slot: SharedSlot,
) -> Option<Page> {
    let window_info = WindowInfo {
        windowless_rendering_enabled: true as _,
        ..Default::default()
    };
    let browser_settings = BrowserSettings {
        windowless_frame_rate: 60,
        ..Default::default()
    };
    let context_settings = RequestContextSettings {
        cache_path: context_dir.into(),
        ..Default::default()
    };
    let mut context = request_context_create_context(Some(&context_settings), None);
    let mut client = SpikeClient::new(
        SpikeRenderHandler::new(RenderState {
            slot: slot.clone(),
            geometry: geometry.clone(),
        }),
        SpikeDisplayHandler::new(slot.clone()),
    );
    let browser = browser_host_create_browser_sync(
        Some(&window_info),
        Some(&mut client),
        Some(&url.into()),
        Some(&browser_settings),
        None,
        context.as_mut(),
    )?;
    Some(Page {
        browser,
        slot,
        geometry,
    })
}
