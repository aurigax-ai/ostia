use std::time::Duration;

use tray_icon::menu::{Menu, MenuEvent, MenuItem};
use tray_icon::{Icon, TrayIconBuilder, TrayIconEvent};

fn main() -> anyhow::Result<()> {
    gtk::init()?;
    let quit = MenuItem::new("Quit", true, None);
    let menu = Menu::new();
    menu.append(&quit)?;
    let side = 32u32;
    let rgba = (0..side * side)
        .flat_map(|_| [0x2b, 0x8c, 0xff, 0xff])
        .collect();
    let _tray = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip("ostia spike")
        .with_icon(Icon::from_rgba(rgba, side, side)?)
        .build()?;
    println!("tray built");
    let quit_id = quit.id().clone();
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while std::time::Instant::now() < deadline {
        while gtk::events_pending() {
            gtk::main_iteration();
        }
        if let Ok(event) = TrayIconEvent::receiver().try_recv() {
            println!("tray event: {event:?}");
        }
        if let Ok(event) = MenuEvent::receiver().try_recv() {
            println!("menu event: {event:?}");
            if event.id == quit_id {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}
