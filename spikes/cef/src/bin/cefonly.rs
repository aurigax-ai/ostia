use cef::*;
use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

wrap_request_context_handler! {
    struct Handler {
        ready: Rc<Cell<bool>>,
    }

    impl RequestContextHandler {
        fn on_request_context_initialized(&self, _request_context: Option<&mut RequestContext>) {
            self.ready.set(true);
            eprintln!("CEFONLY on_request_context_initialized");
        }
    }
}

wrap_life_span_handler! {
    struct Lifespan {
        created: Rc<Cell<bool>>,
    }

    impl LifeSpanHandler {
        fn on_after_created(&self, _browser: Option<&mut Browser>) {
            self.created.set(true);
            eprintln!("CEFONLY on_after_created");
        }
    }
}

wrap_render_handler! {
    struct Render {
        unit: (),
    }

    impl RenderHandler {
        fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut Rect>) {
            if let Some(rect) = rect {
                rect.width = 800;
                rect.height = 600;
            }
        }

        fn on_paint(
            &self,
            _browser: Option<&mut Browser>,
            _type_: PaintElementType,
            _dirty_rects: Option<&[Rect]>,
            _buffer: *const u8,
            _width: ::std::os::raw::c_int,
            _height: ::std::os::raw::c_int,
        ) {
        }
    }
}

wrap_client! {
    struct ClientImpl {
        render: RenderHandler,
        lifespan: LifeSpanHandler,
    }

    impl Client {
        fn render_handler(&self) -> Option<RenderHandler> {
            Some(self.render.clone())
        }

        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(self.lifespan.clone())
        }
    }
}

fn pump(loops: u32) {
    for _ in 0..loops {
        do_message_loop_work();
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn main() {
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    let args = cef::args::Args::new();
    let is_browser = args
        .as_cmd_line()
        .is_some_and(|line| line.has_switch(Some(&"type".into())) != 1);
    let code = execute_process(Some(args.as_main_args()), None, std::ptr::null_mut());
    if !is_browser {
        std::process::exit(code.max(0));
    }
    let argv: Vec<String> = std::env::args().collect();
    let mode = argv.get(1).map_or("sync", String::as_str).to_string();
    let kind = argv.get(2).map_or("disk", String::as_str).to_string();
    let root = argv
        .get(3)
        .cloned()
        .unwrap_or_else(|| "/tmp/cefonly-root".into());
    std::fs::create_dir_all(&root).ok();
    let settings = Settings {
        windowless_rendering_enabled: true as _,
        external_message_pump: true as _,
        root_cache_path: root.as_str().into(),
        cache_path: root.as_str().into(),
        log_file: format!("{root}/chromium.log").as_str().into(),
        log_severity: LogSeverity::VERBOSE,
        ..Default::default()
    };
    let ok = initialize(
        Some(args.as_main_args()),
        Some(&settings),
        None,
        std::ptr::null_mut(),
    );
    eprintln!("CEFONLY initialize={ok} mode={mode} kind={kind}");
    pump(50);

    let ready = Rc::new(Cell::new(false));
    let mut handler = Handler::new(ready.clone());
    let ctx_dir = format!("{root}/ctx-0");
    std::fs::create_dir_all(&ctx_dir).ok();
    let context_settings = RequestContextSettings {
        cache_path: if kind == "disk" {
            ctx_dir.as_str().into()
        } else {
            "".into()
        },
        ..Default::default()
    };
    let mut context = if kind == "global" {
        request_context_get_global_context()
    } else {
        request_context_create_context(Some(&context_settings), Some(&mut handler))
    };
    eprintln!("CEFONLY context created={}", context.is_some());
    pump(100);
    eprintln!("CEFONLY context initialized callback={}", ready.get());

    let created = Rc::new(Cell::new(false));
    let mut client = ClientImpl::new(Render::new(()), Lifespan::new(created.clone()));
    let window_info = WindowInfo {
        windowless_rendering_enabled: true as _,
        runtime_style: RuntimeStyle::ALLOY,
        ..Default::default()
    };
    let browser_settings = BrowserSettings {
        windowless_frame_rate: 30,
        ..Default::default()
    };
    let url = CefString::from("about:blank");
    let browser;
    if mode == "async" {
        let result = browser_host_create_browser(
            Some(&window_info),
            Some(&mut client),
            Some(&url),
            Some(&browser_settings),
            None,
            context.as_mut(),
        );
        eprintln!("CEFONLY async create returned={result}");
        browser = None;
    } else {
        browser = browser_host_create_browser_sync(
            Some(&window_info),
            Some(&mut client),
            Some(&url),
            Some(&browser_settings),
            None,
            context.as_mut(),
        );
        eprintln!("CEFONLY sync create ok={}", browser.is_some());
    }
    pump(200);
    eprintln!("CEFONLY on_after_created seen={}", created.get());
    drop(browser);
    shutdown();
}
