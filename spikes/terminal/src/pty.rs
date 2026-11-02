use std::io::{Read, Write};

use anyhow::Result;
use portable_pty::{
    Child, ChildKiller as _, CommandBuilder, MasterPty, PtySize, native_pty_system,
};

pub struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Pty {
    pub fn spawn(cols: u16, rows: u16, argv: &[&str]) -> Result<(Self, Box<dyn Read + Send>)> {
        let pair = native_pty_system().openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut command = match argv.split_first() {
            Some((program, args)) => {
                let mut command = CommandBuilder::new(program);
                command.args(args);
                command
            }
            None => CommandBuilder::new_default_prog(),
        };
        command.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(command)?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        Ok((
            Self {
                master: pair.master,
                writer,
                child,
            },
            reader,
        ))
    }

    pub fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.writer.write_all(bytes)?;
        self.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn process_id(&self) -> Option<u32> {
        self.child.process_id()
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
    }
}
