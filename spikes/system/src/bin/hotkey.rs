use std::time::{Duration, Instant};

use global_hotkey::hotkey::{Code, HotKey, Modifiers};
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};

fn main() -> anyhow::Result<()> {
    let manager = GlobalHotKeyManager::new()?;
    let hotkey = HotKey::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyJ);
    manager.register(hotkey)?;
    println!("registered id {}", hotkey.id());
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Ok(event) = GlobalHotKeyEvent::receiver().try_recv() {
            println!("event: id {} state {:?}", event.id, event.state);
            if event.id == hotkey.id() && event.state == HotKeyState::Pressed {
                println!("pressed");
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}
