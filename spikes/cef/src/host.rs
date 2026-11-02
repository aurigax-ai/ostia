use crate::frame::{SharedSlot, store_bgra};
use cef::wrapper::byte_read_handler::{ByteReadHandler, ByteStream};
use cef::wrapper::stream_resource_handler::StreamResourceHandler;
use cef::*;
use std::cell::Cell;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

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

wrap_browser_process_handler! {
    struct SpikeBrowserProcessHandler {
        ready: Rc<Cell<bool>>,
    }

    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            self.ready.set(true);
        }
    }
}

wrap_app! {
    struct SpikeApp {
        config: AppConfig,
        ready: Rc<Cell<bool>>,
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

        fn on_register_custom_schemes(&self, registrar: Option<&mut SchemeRegistrar>) {
            if let Some(registrar) = registrar {
                let options = SchemeOptions::STANDARD.get_raw()
                    | SchemeOptions::SECURE.get_raw()
                    | SchemeOptions::CORS_ENABLED.get_raw()
                    | SchemeOptions::FETCH_ENABLED.get_raw();
                registrar.add_custom_scheme(Some(&"spike".into()), options as _);
            }
        }

        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(SpikeBrowserProcessHandler::new(self.ready.clone()))
        }
    }
}

pub fn build_app(ready: Rc<Cell<bool>>) -> App {
    SpikeApp::new(AppConfig::from_env(), ready)
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

pub fn initialize_cef(args: &cef::args::Args, root_cache: &str, ready: Rc<Cell<bool>>) -> bool {
    let settings = Settings {
        windowless_rendering_enabled: true as _,
        external_message_pump: true as _,
        root_cache_path: root_cache.into(),
        cache_path: match std::env::var("SPIKE_GLOBAL_CACHE").as_deref() {
            Ok("child") => format!("{root_cache}/Default").as_str().into(),
            Ok("none") => "".into(),
            _ => root_cache.into(),
        },
        cookieable_schemes_list: "spike".into(),
        ..Default::default()
    };
    let mut app = build_app(ready);
    initialize(
        Some(args.as_main_args()),
        Some(&settings),
        Some(&mut app),
        std::ptr::null_mut(),
    ) == 1
}

pub struct Page {
    pub devtools: Option<Registration>,
    pub browser: Browser,
    pub slot: SharedSlot,
    pub geometry: SharedGeometry,
}

#[derive(Clone, Copy, Debug)]
pub enum ContextKind {
    Disk,
    DiskWithHandler,
    DiskFresh,
    DiskProfileName,
    Memory,
    Global,
}

pub const CONTEXT_ORDER: [ContextKind; 6] = [
    ContextKind::Disk,
    ContextKind::DiskWithHandler,
    ContextKind::DiskFresh,
    ContextKind::DiskProfileName,
    ContextKind::Global,
    ContextKind::Memory,
];

pub fn open_page(
    url: &str,
    kind: ContextKind,
    context_dir: &str,
    scheme_root: &str,
    geometry: SharedGeometry,
    slot: SharedSlot,
) -> Option<Page> {
    let window_info = WindowInfo {
        windowless_rendering_enabled: true as _,
        runtime_style: RuntimeStyle::ALLOY,
        ..Default::default()
    };
    let browser_settings = BrowserSettings {
        windowless_frame_rate: 60,
        ..Default::default()
    };
    let profile_name_dir = format!(
        "{}/Profile 1",
        context_dir
            .rsplit_once('/')
            .map_or(context_dir, |(root, _)| root)
    );
    let cache_path = match kind {
        ContextKind::Disk | ContextKind::DiskWithHandler => {
            std::fs::create_dir_all(context_dir).ok();
            context_dir
        }
        ContextKind::DiskFresh => {
            std::fs::remove_dir_all(context_dir).ok();
            context_dir
        }
        ContextKind::DiskProfileName => profile_name_dir.as_str(),
        ContextKind::Memory | ContextKind::Global => "",
    };
    let context_settings = RequestContextSettings {
        cache_path: cache_path.into(),
        ..Default::default()
    };
    let mut handler = SpikeContextHandler::new(());
    let mut context = match kind {
        ContextKind::Global => request_context_get_global_context(),
        ContextKind::DiskWithHandler => {
            request_context_create_context(Some(&context_settings), Some(&mut handler))
        }
        _ => request_context_create_context(Some(&context_settings), None),
    };
    eprintln!(
        "SPIKE request-context kind={kind:?} created={}",
        context.is_some()
    );
    if let Some(context) = context.as_ref() {
        eprintln!(
            "SPIKE scheme-registered={}",
            register_scheme(context, scheme_root)
        );
    }
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
        devtools: None,
        browser,
        slot,
        geometry,
    })
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html",
        Some("webm") => "video/webm",
        Some("js") => "text/javascript",
        _ => "application/octet-stream",
    }
}

wrap_scheme_handler_factory! {
    struct SpikeSchemeFactory {
        root: String,
    }

    impl SchemeHandlerFactory {
        fn create(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _scheme_name: Option<&CefString>,
            request: Option<&mut Request>,
        ) -> Option<ResourceHandler> {
            let url = CefString::from(&request?.url()).to_string();
            let path = url.trim_start_matches("spike://app/");
            let path = if path.is_empty() { "page.html" } else { path };
            let bytes = std::fs::read(format!("{}/{}", self.root, path)).ok()?;
            let mut read_handler = ByteReadHandler::new(Arc::new(Mutex::new(ByteStream::new(bytes))));
            let stream = stream_reader_create_for_handler(Some(&mut read_handler))?;
            Some(StreamResourceHandler::new_with_stream(mime_for(path).to_string(), stream))
        }
    }
}

pub fn register_scheme(context: &RequestContext, root: &str) -> bool {
    let mut factory = SpikeSchemeFactory::new(root.to_string());
    context.register_scheme_handler_factory(
        Some(&"spike".into()),
        Some(&"app".into()),
        Some(&mut factory),
    ) == 1
}

wrap_request_context_handler! {
    struct SpikeContextHandler {
        unit: (),
    }

    impl RequestContextHandler {}
}

#[derive(Clone)]
pub struct DevtoolsCounters {
    pub paused: Rc<Cell<u32>>,
}

wrap_dev_tools_message_observer! {
    struct SpikeDevtoolsObserver {
        counters: DevtoolsCounters,
    }

    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(
            &self,
            _browser: Option<&mut Browser>,
            message_id: ::std::os::raw::c_int,
            success: ::std::os::raw::c_int,
            result: Option<&[u8]>,
        ) {
            let text = result.map(|bytes| String::from_utf8_lossy(&bytes[..bytes.len().min(100)]).to_string());
            eprintln!("SPIKE devtools result id={message_id} success={success} body={text:?}");
        }

        fn on_dev_tools_event(
            &self,
            browser: Option<&mut Browser>,
            method: Option<&CefString>,
            params: Option<&[u8]>,
        ) {
            let method = method.map(|m| m.to_string()).unwrap_or_default();
            if method != "Fetch.requestPaused" {
                return;
            }
            self.counters.paused.set(self.counters.paused.get() + 1);
            let body = params.map(|bytes| String::from_utf8_lossy(bytes).to_string()).unwrap_or_default();
            let Some(start) = body.find("\"requestId\":\"") else {
                return;
            };
            let rest = &body[start + 13..];
            let Some(end) = rest.find('"') else {
                return;
            };
            let Some(host) = browser.and_then(|b| b.host()) else {
                return;
            };
            if let Some(mut dict) = dictionary_value_create() {
                dict.set_string(Some(&"requestId".into()), Some(&rest[..end].into()));
                host.execute_dev_tools_method(1000 + self.counters.paused.get() as i32, Some(&"Fetch.continueRequest".into()), Some(&mut dict));
            }
        }
    }
}

impl Page {
    pub fn attach_devtools(&mut self, counters: DevtoolsCounters) {
        let mut observer = SpikeDevtoolsObserver::new(counters);
        self.devtools = self
            .browser
            .host()
            .and_then(|host| host.add_dev_tools_message_observer(Some(&mut observer)));
        eprintln!("SPIKE devtools observer={}", self.devtools.is_some());
    }

    pub fn run_devtools(&self) {
        let Some(host) = self.browser.host() else {
            return;
        };
        if let Some(mut dict) = dictionary_value_create() {
            dict.set_int(Some(&"width".into()), 500);
            dict.set_int(Some(&"height".into()), 400);
            dict.set_int(Some(&"deviceScaleFactor".into()), 1);
            dict.set_bool(Some(&"mobile".into()), 0);
            host.execute_dev_tools_method(
                1,
                Some(&"Emulation.setDeviceMetricsOverride".into()),
                Some(&mut dict),
            );
        }
        host.execute_dev_tools_method(2, Some(&"Fetch.enable".into()), None);
        self.browser.reload();
    }

    pub fn drop_files(&self, paths: &[String], x: i32, y: i32) {
        let Some(host) = self.browser.host() else {
            return;
        };
        let Some(mut data) = drag_data_create() else {
            eprintln!("SPIKE drag-data-create-failed");
            return;
        };
        for path in paths {
            let name = path.rsplit('/').next().unwrap_or(path);
            data.add_file(Some(&path.as_str().into()), Some(&name.into()));
        }
        let event = MouseEvent { x, y, modifiers: 0 };
        let mask = DragOperationsMask::from(sys::cef_drag_operations_mask_t::DRAG_OPERATION_EVERY);
        host.drag_target_drag_enter(Some(&mut data), Some(&event), mask.clone());
        host.drag_target_drag_over(Some(&event), mask);
        host.drag_target_drop(Some(&event));
        eprintln!("SPIKE cef-drop-sent paths={}", paths.len());
    }
}
