use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};

use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};

struct Pipes {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

pub struct LspClient {
    pipes: Mutex<Pipes>,
    child: Mutex<Child>,
    next_id: AtomicI64,
}

pub struct ServerLaunch {
    pub program: String,
    pub args: Vec<String>,
    pub root: String,
    pub initialization_options: Value,
}

impl LspClient {
    pub fn start(launch: &ServerLaunch) -> Result<Self> {
        let mut child = Command::new(&launch.program)
            .args(&launch.args)
            .current_dir(&launch.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("spawn {}", launch.program))?;
        let stdin = child.stdin.take().context("stdin")?;
        let stdout = BufReader::new(child.stdout.take().context("stdout")?);
        let client = Self {
            pipes: Mutex::new(Pipes { stdin, stdout }),
            child: Mutex::new(child),
            next_id: AtomicI64::new(1),
        };
        let root_uri = format!("file://{}", launch.root);
        client.request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "rootUri": root_uri,
                "workspaceFolders": [{ "uri": root_uri, "name": "spike" }],
                "initializationOptions": launch.initialization_options,
                "capabilities": {
                    "workspace": { "configuration": true },
                    "textDocument": {
                        "hover": { "contentFormat": ["markdown", "plaintext"] },
                        "completion": { "completionItem": { "snippetSupport": false } }
                    }
                }
            }),
        )?;
        client.notify("initialized", json!({}))?;
        Ok(client)
    }

    pub fn open_document(&self, uri: &str, language_id: &str, text: &str) -> Result<()> {
        self.notify(
            "textDocument/didOpen",
            json!({ "textDocument": { "uri": uri, "languageId": language_id, "version": 1, "text": text } }),
        )
    }

    pub fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut pipes = self.pipes.lock().map_err(|_| anyhow!("poisoned"))?;
        write_message(
            &mut pipes.stdin,
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        )?;
        loop {
            let message = read_message(&mut pipes.stdout)?;
            let is_method = message.get("method").is_some();
            if let (true, Some(server_id)) = (is_method, message.get("id")) {
                let result = if message["method"] == "workspace/configuration" {
                    let count = message["params"]["items"].as_array().map_or(0, Vec::len);
                    Value::Array(vec![Value::Null; count])
                } else {
                    Value::Null
                };
                write_message(
                    &mut pipes.stdin,
                    &json!({ "jsonrpc": "2.0", "id": server_id, "result": result }),
                )?;
            } else if !is_method && message.get("id") == Some(&json!(id)) {
                if let Some(error) = message.get("error") {
                    return Err(anyhow!("{method}: {error}"));
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<()> {
        let mut pipes = self.pipes.lock().map_err(|_| anyhow!("poisoned"))?;
        write_message(
            &mut pipes.stdin,
            &json!({ "jsonrpc": "2.0", "method": method, "params": params }),
        )
    }
}

impl Drop for LspClient {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

fn write_message(stdin: &mut ChildStdin, message: &Value) -> Result<()> {
    let body = serde_json::to_vec(message)?;
    write!(stdin, "Content-Length: {}\r\n\r\n", body.len())?;
    stdin.write_all(&body)?;
    stdin.flush()?;
    Ok(())
}

fn read_message(stdout: &mut BufReader<ChildStdout>) -> Result<Value> {
    let mut length = None;
    loop {
        let mut line = String::new();
        if stdout.read_line(&mut line)? == 0 {
            return Err(anyhow!("server closed"));
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some(value) = line.strip_prefix("Content-Length:") {
            length = Some(value.trim().parse::<usize>()?);
        }
    }
    let mut body = vec![0; length.context("no content length")?];
    stdout.read_exact(&mut body)?;
    Ok(serde_json::from_slice(&body)?)
}
