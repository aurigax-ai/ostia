use zbus::blocking::{Connection, Proxy};

fn main() -> anyhow::Result<()> {
    let connection = Connection::system()?;
    let manager = Proxy::new(
        &connection,
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
    )?;
    let sleep = manager.receive_signal("PrepareForSleep")?;
    println!("listening for PrepareForSleep on logind");
    for message in sleep.take(2) {
        let starting: bool = message.body().deserialize()?;
        println!("PrepareForSleep starting={starting}");
    }
    Ok(())
}
