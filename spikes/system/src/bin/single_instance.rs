use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

fn socket_path() -> PathBuf {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    runtime.join("ostia-spike-single-instance.sock")
}

fn main() -> anyhow::Result<()> {
    let path = socket_path();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Ok(mut stream) = UnixStream::connect(&path) {
        writeln!(stream, "{}", args.join(" "))?;
        println!("second instance: forwarded {args:?} and exiting");
        return Ok(());
    }
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    println!("first instance: listening on {}", path.display());
    for stream in listener.incoming().take(3) {
        let mut line = String::new();
        BufReader::new(stream?).read_line(&mut line)?;
        println!("first instance received: {}", line.trim_end());
    }
    std::fs::remove_file(&path)?;
    Ok(())
}
