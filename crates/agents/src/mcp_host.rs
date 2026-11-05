use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ostia_base::Host;
use ostia_base::js::{is_js_space, js_trim, static_regex, utf16_len};
use ostia_contract::assist::{
    CHAT_TOOL_DESCRIPTION_MAX, CHAT_TOOL_OUTPUT_MAX, CHAT_TOOL_SCHEMA_MAX,
};
use ostia_contract::chat_tools::{
    ChatToolSettings, MCP_TOOLS_PER_SERVER_MAX, McpCallResult, McpSecretResult, McpServerSettings,
    McpServerState, McpServerStatus, McpTestResult, McpToolInfo, McpTransportKind,
    is_mcp_secret_key, mcp_transport_of,
};
use ostia_contract::utf16_prefix::utf16_prefix;
use parking_lot::Mutex;
use regex::Regex;
use reqwest::Url;
use serde_json::{Map, Value, json};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::mcp_client::{HttpSpec, McpClient, StdioSpec};

const MCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MCP_CALL_TIMEOUT: Duration = Duration::from_secs(120);
const ERROR_MAX: usize = 240;
const TOOL_NAME_MAX: usize = 128;
const ERROR_RESULT_MAX: usize = 1000;
const NOT_CONNECTED: &str = "This MCP server is not connected.";
const TOOL_OFF: &str = "This MCP tool is turned off.";
const INVALID_CALL: &str = "invalid call";

static CALL_ID_PATTERN: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| static_regex(r"^[A-Za-z0-9_-]{1,128}$"));

type ServersFn = Arc<dyn Fn() -> Vec<McpServerSettings> + Send + Sync>;
type SecretFn = Arc<dyn Fn(&str, &str) -> Option<String> + Send + Sync>;
type StatusFn = Arc<dyn Fn(Vec<McpServerStatus>) + Send + Sync>;
type ErrorSink = Arc<dyn Fn(String) + Send + Sync>;
type ClientSink = Box<dyn Fn(&Arc<McpClient>) + Send + Sync>;
type LiveCheck = Box<dyn Fn() -> bool + Send + Sync>;

#[derive(Clone)]
pub struct McpHostDeps {
    servers: ServersFn,
    secret: SecretFn,
    on_status: StatusFn,
    pub connect_timeout: Duration,
    pub call_timeout: Duration,
}

impl McpHostDeps {
    pub fn new(
        servers: impl Fn() -> Vec<McpServerSettings> + Send + Sync + 'static,
        secret: impl Fn(&str, &str) -> Option<String> + Send + Sync + 'static,
        on_status: impl Fn(Vec<McpServerStatus>) + Send + Sync + 'static,
    ) -> Self {
        Self {
            servers: Arc::new(servers),
            secret: Arc::new(secret),
            on_status: Arc::new(on_status),
            connect_timeout: MCP_CONNECT_TIMEOUT,
            call_timeout: MCP_CALL_TIMEOUT,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct McpExtensionOutput {
    pub text: String,
    pub structured: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpExtensionServer {
    pub name: String,
    pub state: McpServerState,
    pub tools: Vec<String>,
}

struct Entry {
    id: u64,
    fingerprint: String,
    client: Option<Arc<McpClient>>,
    state: McpServerState,
    error: Option<String>,
    tools: Vec<McpToolInfo>,
}

#[derive(Default)]
struct State {
    entries: HashMap<String, Entry>,
    calls: HashMap<String, CancellationToken>,
    next_entry: u64,
}

struct Shared {
    deps: McpHostDeps,
    state: Mutex<State>,
    changes: watch::Sender<u64>,
}

#[derive(Clone)]
pub struct McpHost {
    shared: Arc<Shared>,
}

struct Connection {
    client: Arc<McpClient>,
    tools: Vec<McpToolInfo>,
}

struct OpenHooks {
    on_error: ErrorSink,
    on_client: ClientSink,
    live: LiveCheck,
}

struct Waiting {
    name: String,
    changes: watch::Receiver<u64>,
    deadline: Pin<Box<tokio::time::Sleep>>,
}

struct CallGuard<'a> {
    host: &'a McpHost,
    id: String,
}

impl Drop for CallGuard<'_> {
    fn drop(&mut self) {
        self.host.shared.state.lock().calls.remove(&self.id);
    }
}

fn error_text(message: &str) -> String {
    let mut collapsed = String::new();
    let mut in_space = false;
    for ch in message.chars() {
        if is_js_space(ch) {
            in_space = true;
            continue;
        }
        if in_space {
            collapsed.push(' ');
            in_space = false;
        }
        collapsed.push(ch);
    }
    if in_space {
        collapsed.push(' ');
    }
    let text = utf16_prefix(js_trim(&collapsed), ERROR_MAX);
    if text.is_empty() {
        "failed".to_owned()
    } else {
        text.to_owned()
    }
}

fn tool_info(raw: &Value) -> Option<McpToolInfo> {
    let raw = raw.as_object()?;
    let name = raw.get("name")?.as_str()?;
    if name.is_empty() || utf16_len(name) > TOOL_NAME_MAX {
        return None;
    }
    let schema = match raw.get("inputSchema") {
        Some(Value::Object(schema)) => schema.clone(),
        _ => {
            let mut schema = Map::new();
            schema.insert("type".to_owned(), json!("object"));
            schema
        }
    };
    if schema.get("type").and_then(Value::as_str) != Some("object") {
        return None;
    }
    if utf16_len(&serde_json::to_string(&schema).ok()?) > CHAT_TOOL_SCHEMA_MAX {
        return None;
    }
    let description = raw
        .get("description")
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|text| !text.is_empty())
        .map_or_else(
            || name.to_owned(),
            |text| utf16_prefix(text, CHAT_TOOL_DESCRIPTION_MAX).to_owned(),
        );
    Some(McpToolInfo {
        name: name.to_owned(),
        description,
        input_schema: schema,
    })
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => ostia_base::js::js_number_text(number.as_f64().unwrap_or(0.0)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn uri_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(other) => js_string(other),
    }
}

pub fn format_call_result(raw: &Value) -> McpCallResult {
    let empty = Map::new();
    let result = raw.as_object().unwrap_or(&empty);
    let mut pieces: Vec<String> = Vec::new();
    let items = result
        .get("content")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    for item in items {
        let Some(item) = item.as_object() else {
            continue;
        };
        let kind = item.get("type").and_then(Value::as_str);
        if kind == Some("text")
            && let Some(text) = item.get("text").and_then(Value::as_str)
        {
            pieces.push(text.to_owned());
        } else if kind == Some("resource")
            && let Some(resource) = item.get("resource").and_then(Value::as_object)
        {
            pieces.push(match resource.get("text").and_then(Value::as_str) {
                Some(text) => text.to_owned(),
                None => format!("[resource {}]", uri_text(resource.get("uri"))),
            });
        } else if kind == Some("resource_link") {
            pieces.push(format!("[resource {}]", uri_text(item.get("uri"))));
        } else if let Some(kind) = kind {
            pieces.push(format!("[{kind} omitted]"));
        }
    }
    for key in ["structuredContent", "toolResult"] {
        if pieces.is_empty()
            && let Some(value) = result.get(key)
        {
            pieces.push(value.to_string());
        }
    }
    let text = utf16_prefix(&pieces.join("\n"), CHAT_TOOL_OUTPUT_MAX).to_owned();
    if result.get("isError") == Some(&Value::Bool(true)) {
        let clipped = utf16_prefix(&text, ERROR_RESULT_MAX);
        return Err(if clipped.is_empty() {
            "failed".to_owned()
        } else {
            clipped.to_owned()
        });
    }
    Ok(text)
}

pub fn server_secrets(
    settings: &McpServerSettings,
    secret: &dyn Fn(&str, &str) -> Option<String>,
) -> BTreeMap<String, String> {
    settings
        .secrets
        .iter()
        .filter_map(|key| Some((key.clone(), secret(&settings.name, key)?)))
        .collect()
}

pub fn set_mcp_secret(
    settings: &ChatToolSettings,
    host: &McpHost,
    store: impl Fn(&str, &str, Option<&str>) -> Result<(), String>,
    server: &Value,
    key: &Value,
    value: &Value,
) -> McpSecretResult {
    let found = server
        .as_str()
        .and_then(|name| settings.mcp_servers.iter().find(|s| s.name == name))
        .ok_or_else(|| "unknown-server".to_owned())?;
    let key = key
        .as_str()
        .filter(|key| {
            is_mcp_secret_key(mcp_transport_of(found), key)
                && found.secrets.iter().any(|declared| declared == key)
        })
        .ok_or_else(|| "unknown-secret".to_owned())?;
    let value = match value {
        Value::Null => None,
        Value::String(text) => Some(text.as_str()),
        _ => return Err("invalid-value".to_owned()),
    };
    store(&found.name, key, value)?;
    host.reconnect(&found.name);
    Ok(())
}

impl McpHost {
    pub fn new(deps: McpHostDeps) -> Self {
        let (changes, _) = watch::channel(0);
        Self {
            shared: Arc::new(Shared {
                deps,
                state: Mutex::new(State::default()),
                changes,
            }),
        }
    }

    fn deps(&self) -> &McpHostDeps {
        &self.shared.deps
    }

    pub fn status(&self) -> Vec<McpServerStatus> {
        let deps = self.deps();
        let rows: Vec<(McpServerSettings, Vec<String>)> = (deps.servers)()
            .into_iter()
            .map(|server| {
                let set = server
                    .secrets
                    .iter()
                    .filter(|key| (deps.secret)(&server.name, key).is_some())
                    .cloned()
                    .collect();
                (server, set)
            })
            .collect();
        let state = self.shared.state.lock();
        rows.into_iter()
            .map(|(server, secrets_set)| {
                let entry = state.entries.get(&server.name);
                let ready = entry.filter(|entry| entry.state == McpServerState::Ready);
                McpServerStatus {
                    name: server.name.clone(),
                    transport: mcp_transport_of(&server),
                    state: if server.enabled {
                        entry.map_or(McpServerState::Idle, |entry| entry.state)
                    } else {
                        McpServerState::Off
                    },
                    error: entry
                        .filter(|_| server.enabled)
                        .and_then(|entry| entry.error.clone())
                        .filter(|error| !error.is_empty()),
                    tools: if server.enabled {
                        ready.map_or_else(Vec::new, |entry| entry.tools.clone())
                    } else {
                        Vec::new()
                    },
                    secrets_set,
                    auth: None,
                }
            })
            .collect()
    }

    fn emit(&self) {
        (self.deps().on_status)(self.status());
        self.shared.changes.send_modify(|version| *version += 1);
    }

    pub fn notify(&self) {
        self.emit();
    }

    fn fingerprint_of(&self, settings: &McpServerSettings) -> String {
        let secrets: Vec<Value> = settings
            .secrets
            .iter()
            .map(|key| json!([key, (self.deps().secret)(&settings.name, key).is_some()]))
            .collect();
        let env: Vec<(&String, &String)> = settings.env.iter().collect();
        json!({
            "command": settings.command,
            "url": settings.url,
            "env": env,
            "secrets": secrets,
        })
        .to_string()
    }

    fn insert_entry(state: &mut State, name: &str, fingerprint: String) -> u64 {
        state.next_entry += 1;
        let id = state.next_entry;
        state.entries.insert(
            name.to_owned(),
            Entry {
                id,
                fingerprint,
                client: None,
                state: McpServerState::Connecting,
                error: None,
                tools: Vec::new(),
            },
        );
        id
    }

    fn start_connect(&self, id: u64, settings: McpServerSettings) {
        let host = self.clone();
        tokio::spawn(async move {
            let name = settings.name.clone();
            let hooks = OpenHooks {
                on_error: {
                    let host = host.clone();
                    let name = name.clone();
                    Arc::new(move |message: String| host.fail_with(&name, id, &message))
                },
                on_client: {
                    let host = host.clone();
                    let name = name.clone();
                    Box::new(move |client: &Arc<McpClient>| host.attach_client(&name, id, client))
                },
                live: {
                    let host = host.clone();
                    let name = name.clone();
                    Box::new(move || host.is_live(&name, id))
                },
            };
            match host.open(&settings, &hooks).await {
                Ok(Some(connection)) => host.finish_connect(&name, id, connection),
                Ok(None) => {}
                Err(message) => host.fail_with(&name, id, &message),
            }
        });
    }

    fn is_live(&self, name: &str, id: u64) -> bool {
        self.shared
            .state
            .lock()
            .entries
            .get(name)
            .is_some_and(|entry| entry.id == id)
    }

    fn attach_client(&self, name: &str, id: u64, client: &Arc<McpClient>) {
        let mut state = self.shared.state.lock();
        if let Some(entry) = state.entries.get_mut(name)
            && entry.id == id
        {
            entry.client = Some(Arc::clone(client));
        }
    }

    fn finish_connect(&self, name: &str, id: u64, connection: Connection) {
        let attached = {
            let mut state = self.shared.state.lock();
            match state.entries.get_mut(name) {
                Some(entry)
                    if entry.id == id
                        && entry
                            .client
                            .as_ref()
                            .is_some_and(|client| Arc::ptr_eq(client, &connection.client)) =>
                {
                    entry.tools = connection.tools;
                    entry.state = McpServerState::Ready;
                    entry.error = None;
                    true
                }
                _ => false,
            }
        };
        if attached {
            self.emit();
        } else {
            connection.client.close();
        }
    }

    fn fail_with(&self, name: &str, id: u64, message: &str) {
        let client = {
            let mut state = self.shared.state.lock();
            let Some(entry) = state.entries.get_mut(name).filter(|entry| entry.id == id) else {
                return;
            };
            entry.state = McpServerState::Error;
            entry.error = Some(error_text(message));
            entry.tools = Vec::new();
            entry.client.take()
        };
        if let Some(client) = client {
            client.close();
        }
        self.emit();
    }

    fn transport_for(&self, settings: &McpServerSettings) -> Result<McpClient, String> {
        let secrets = server_secrets(settings, &*self.deps().secret);
        if mcp_transport_of(settings) == McpTransportKind::Http {
            let url = settings.url.as_deref().unwrap_or_default();
            let url = Url::parse(url).map_err(|err| format!("Invalid URL: {err}"))?;
            return McpClient::start_http(HttpSpec {
                url,
                headers: secrets,
            });
        }
        let [command, args @ ..] = settings.command.as_deref().unwrap_or_default() else {
            return Err("The server has no command".to_owned());
        };
        let mut env: BTreeMap<String, String> = settings
            .env
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        env.extend(secrets);
        McpClient::start_stdio(&StdioSpec {
            command: command.clone(),
            args: args.to_vec(),
            env,
            cwd: Host::current().home,
        })
    }

    async fn open(
        &self,
        settings: &McpServerSettings,
        hooks: &OpenHooks,
    ) -> Result<Option<Connection>, String> {
        let timeout = self.deps().connect_timeout;
        let client = Arc::new(self.transport_for(settings)?);
        if let Err(message) = client.initialize(timeout).await {
            client.close();
            return Err(message);
        }
        if !(hooks.live)() {
            client.close();
            return Ok(None);
        }
        (hooks.on_client)(&client);
        if client.is_stdio() {
            let on_error = Arc::clone(&hooks.on_error);
            client.on_exit(Arc::new(move || on_error("The server exited.".to_owned())));
        }
        let listed = match client.list_tools(timeout).await {
            Ok(listed) => listed,
            Err(message) => {
                client.close();
                return Err(message);
            }
        };
        let tools = listed
            .iter()
            .filter_map(tool_info)
            .take(MCP_TOOLS_PER_SERVER_MAX)
            .collect();
        Ok(Some(Connection { client, tools }))
    }

    pub fn refresh(&self) -> Vec<McpServerStatus> {
        let mut wanted: Vec<(McpServerSettings, String)> = Vec::new();
        for server in (self.deps().servers)() {
            let fingerprint = if server.enabled {
                self.fingerprint_of(&server)
            } else {
                String::new()
            };
            match wanted
                .iter_mut()
                .find(|(known, _)| known.name == server.name)
            {
                Some(slot) => *slot = (server, fingerprint),
                None => wanted.push((server, fingerprint)),
            }
        }
        let mut dropped = Vec::new();
        let mut started = Vec::new();
        {
            let mut state = self.shared.state.lock();
            let names: Vec<String> = state.entries.keys().cloned().collect();
            for name in names {
                let keep = wanted.iter().any(|(server, fingerprint)| {
                    server.name == name
                        && server.enabled
                        && state
                            .entries
                            .get(&name)
                            .is_some_and(|entry| entry.fingerprint == *fingerprint)
                });
                if !keep && let Some(entry) = state.entries.remove(&name) {
                    dropped.extend(entry.client);
                }
            }
            for (server, fingerprint) in &wanted {
                if server.enabled && !state.entries.contains_key(&server.name) {
                    let id = Self::insert_entry(&mut state, &server.name, fingerprint.clone());
                    started.push((id, server.clone()));
                }
            }
        }
        for client in dropped {
            client.close();
        }
        for (id, settings) in started {
            self.start_connect(id, settings);
            self.emit();
        }
        self.status()
    }

    pub fn reconnect(&self, name: &str) -> Vec<McpServerStatus> {
        self.drop_entry(name);
        self.refresh()
    }

    fn drop_entry(&self, name: &str) {
        let entry = self.shared.state.lock().entries.remove(name);
        if let Some(client) = entry.and_then(|entry| entry.client) {
            client.close();
        }
    }

    pub fn servers_for_extensions(&self) -> Vec<McpExtensionServer> {
        let servers = (self.deps().servers)();
        let state = self.shared.state.lock();
        servers
            .into_iter()
            .filter_map(|server| {
                let entry = state.entries.get(&server.name)?;
                if !server.enabled || entry.state != McpServerState::Ready {
                    return None;
                }
                Some(McpExtensionServer {
                    name: server.name.clone(),
                    state: entry.state,
                    tools: entry
                        .tools
                        .iter()
                        .map(|tool| tool.name.clone())
                        .filter(|tool| !server.disabled_tools.contains(tool))
                        .collect(),
                })
            })
            .collect()
    }

    fn begin_wait(&self, name: &str) -> Option<Waiting> {
        let settings = (self.deps().servers)()
            .into_iter()
            .find(|server| server.name == name)?;
        if !settings.enabled {
            return None;
        }
        let changes = self.shared.changes.subscribe();
        let fingerprint = self.fingerprint_of(&settings);
        let started = {
            let mut state = self.shared.state.lock();
            if state.entries.contains_key(name) {
                None
            } else {
                Some(Self::insert_entry(&mut state, name, fingerprint))
            }
        };
        if let Some(id) = started {
            self.start_connect(id, settings);
            self.emit();
        }
        if !self.is_connecting(name) {
            return None;
        }
        Some(Waiting {
            name: name.to_owned(),
            changes,
            deadline: Box::pin(tokio::time::sleep(self.deps().connect_timeout)),
        })
    }

    fn is_connecting(&self, name: &str) -> bool {
        self.shared
            .state
            .lock()
            .entries
            .get(name)
            .is_some_and(|entry| entry.state == McpServerState::Connecting)
    }

    async fn wait_connected(&self, mut waiting: Waiting) {
        while self.is_connecting(&waiting.name) {
            tokio::select! {
                changed = waiting.changes.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
                () = &mut waiting.deadline => return,
            }
        }
    }

    pub fn call_for_extension(
        &self,
        server: &Value,
        tool: &Value,
        input: &Value,
        signal: Option<CancellationToken>,
    ) -> impl Future<Output = Result<McpExtensionOutput, String>> + Send + 'static {
        let host = self.clone();
        let names = server
            .as_str()
            .zip(tool.as_str())
            .map(|(server, tool)| (server.to_owned(), tool.to_owned()));
        let waiting = names
            .as_ref()
            .and_then(|(server, _)| host.begin_wait(server));
        let input = input.clone();
        async move {
            let (server, tool) = names.ok_or_else(|| INVALID_CALL.to_owned())?;
            if let Some(waiting) = waiting {
                host.wait_connected(waiting).await;
            }
            let call_id = uuid::Uuid::new_v4().to_string();
            let raw = host
                .call_tool_cancellable(&call_id, &server, &tool, &input, signal.as_ref())
                .await?;
            let text = format_call_result(&raw)?;
            let structured = raw
                .get("structuredContent")
                .and_then(Value::as_object)
                .filter(|fields| {
                    serde_json::to_string(fields)
                        .is_ok_and(|text| utf16_len(&text) <= CHAT_TOOL_OUTPUT_MAX)
                })
                .cloned();
            Ok(McpExtensionOutput { text, structured })
        }
    }

    async fn call_tool_cancellable(
        &self,
        call_id: &str,
        server: &str,
        tool: &str,
        input: &Value,
        signal: Option<&CancellationToken>,
    ) -> Result<Value, String> {
        let call = self.call_tool(call_id, server, tool, input);
        tokio::pin!(call);
        let mut fired = signal.is_none();
        loop {
            tokio::select! {
                biased;
                result = &mut call => return result,
                () = async {
                    match signal {
                        Some(token) => token.cancelled().await,
                        None => std::future::pending().await,
                    }
                }, if !fired => {
                    fired = true;
                    self.cancel_id(call_id);
                }
            }
        }
    }

    pub async fn test(&self, name: &Value) -> McpTestResult {
        let settings = name
            .as_str()
            .and_then(|name| {
                (self.deps().servers)()
                    .into_iter()
                    .find(|server| server.name == name)
            })
            .ok_or_else(|| "unknown-server".to_owned())?;
        let failure: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let listed = Arc::new(AtomicBool::new(false));
        let hooks = OpenHooks {
            on_error: {
                let failure = Arc::clone(&failure);
                let listed = Arc::clone(&listed);
                Arc::new(move |message: String| {
                    if !listed.load(Ordering::SeqCst) {
                        failure.lock().get_or_insert(message);
                    }
                })
            },
            on_client: Box::new(|_| {}),
            live: Box::new(|| true),
        };
        let opened = self.open(&settings, &hooks).await;
        listed.store(true, Ordering::SeqCst);
        match opened {
            Ok(None) => Err("failed".to_owned()),
            Ok(Some(connection)) => {
                connection.client.close();
                match failure.lock().take() {
                    Some(message) => Err(error_text(&message)),
                    None => Ok(connection.tools.len()),
                }
            }
            Err(message) => Err(error_text(&failure.lock().take().unwrap_or(message))),
        }
    }

    pub async fn call(
        &self,
        call_id: &Value,
        server: &Value,
        tool: &Value,
        input: &Value,
    ) -> McpCallResult {
        let valid_id = call_id.as_str().filter(|id| CALL_ID_PATTERN.is_match(id));
        let (Some(call_id), Some(server), Some(tool)) = (valid_id, server.as_str(), tool.as_str())
        else {
            return Err(INVALID_CALL.to_owned());
        };
        let raw = self.call_tool(call_id, server, tool, input).await?;
        format_call_result(&raw)
    }

    async fn call_tool(
        &self,
        call_id: &str,
        server: &str,
        tool: &str,
        input: &Value,
    ) -> Result<Value, String> {
        let settings = (self.deps().servers)()
            .into_iter()
            .find(|candidate| candidate.name == server);
        let (client, token) = {
            let mut state = self.shared.state.lock();
            let client = state
                .entries
                .get(server)
                .filter(|entry| entry.state == McpServerState::Ready)
                .and_then(|entry| entry.client.clone());
            let Some((settings, client)) = settings.filter(|s| s.enabled).zip(client) else {
                return Err(NOT_CONNECTED.to_owned());
            };
            let known = state
                .entries
                .get(server)
                .is_some_and(|entry| entry.tools.iter().any(|known| known.name == tool));
            if settings.disabled_tools.iter().any(|off| off == tool) || !known {
                return Err(TOOL_OFF.to_owned());
            }
            let token = CancellationToken::new();
            state.calls.insert(call_id.to_owned(), token.clone());
            (client, token)
        };
        let _guard = CallGuard {
            host: self,
            id: call_id.to_owned(),
        };
        let arguments = input.as_object().cloned().unwrap_or_default();
        match client
            .call_tool(tool, arguments, self.deps().call_timeout, &token)
            .await
        {
            Ok(raw) => Ok(raw),
            Err(_) if token.is_cancelled() => Err("cancelled".to_owned()),
            Err(message) => Err(error_text(&message)),
        }
    }

    fn cancel_id(&self, call_id: &str) {
        let token = self.shared.state.lock().calls.get(call_id).cloned();
        if let Some(token) = token {
            token.cancel();
        }
    }

    pub fn cancel(&self, call_id: &Value) {
        if let Some(call_id) = call_id.as_str() {
            self.cancel_id(call_id);
        }
    }

    pub fn close_all(&self) {
        let (tokens, entries) = {
            let mut state = self.shared.state.lock();
            let tokens: Vec<CancellationToken> = state.calls.values().cloned().collect();
            let entries: Vec<Entry> = state.entries.drain().map(|(_, entry)| entry).collect();
            (tokens, entries)
        };
        for token in tokens {
            token.cancel();
        }
        for client in entries.into_iter().filter_map(|entry| entry.client) {
            client.close();
        }
    }
}
