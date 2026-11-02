mod frame;
mod host;
mod input;
mod view;

use cef::ImplCommandLine;
use gpui_kit::*;
use std::rc::Rc;

fn main() {
    let _ = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
    let args = cef::args::Args::new();
    let is_browser_process = args
        .as_cmd_line()
        .is_some_and(|line| line.has_switch(Some(&"type".into())) != 1);
    let mut app = host::build_app();
    let code = cef::execute_process(
        Some(args.as_main_args()),
        Some(&mut app),
        std::ptr::null_mut(),
    );
    if !is_browser_process {
        std::process::exit(code.max(0));
    }
    eprintln!("SPIKE gpui-start");
    let args = Rc::new(args);
    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        let settings = view::Settings::from_env();
        gpui_kit::open_window(WindowOptions::default(), cx, |_, cx| {
            cx.new(|cx| view::BrowserView::new(settings, args, cx))
        })
        .expect("failed to open window");
    });
}
