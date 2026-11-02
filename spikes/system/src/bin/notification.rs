use notify_rust::{Notification, Timeout};

fn main() -> anyhow::Result<()> {
    let handle = Notification::new()
        .appname("ostia-spike")
        .summary("Agent finished")
        .body("Notification from the system spike")
        .action("open", "Open")
        .timeout(Timeout::Milliseconds(8000))
        .show()?;
    println!("shown");
    handle.wait_for_action(|action| println!("action: {action}"));
    Ok(())
}
