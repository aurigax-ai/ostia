use std::path::PathBuf;
use std::sync::Arc;

use futures_util::FutureExt;
use ostia_approvals::GrantTable;
use ostia_base::clock::system_clock;
use ostia_base::host::Host;
use ostia_base::json_store::{StoreScope, store_path};
use ostia_base::{Error, Result};
use ostia_control::discovery::{clear_control_info, control_info_path, write_control_info};
use ostia_control::pane_id_salt::load_pane_id_salt;
use ostia_control::socket_path::control_socket_path_for;
use ostia_control::{
    ControlAuth, ControlAuthParts, ControlListener, ControlServer, IdRegistry, MethodContext,
    MethodTable, ServerDeps,
};
use ostia_park::{FromActivity, PARKED_PANEL_EXTENSION_ID, ParkedStore, register_park_methods};
use ostia_sandbox::WorkspaceSandboxes;
use ostia_terminal::TerminalStates;

pub struct App {
    pub registry: IdRegistry,
    pub grants: Arc<GrantTable>,
    pub parked: ParkedStore,
    pub terminal_states: TerminalStates,
    pub sandboxes: WorkspaceSandboxes,
    pub socket: PathBuf,
    listener: ControlListener,
    info_path: PathBuf,
}

fn from_activity() -> FromActivity {
    Arc::new(|ctx: &MethodContext| {
        ctx.identity.ext_id.as_deref() == Some(PARKED_PANEL_EXTENSION_ID)
    })
}

impl App {
    pub fn start(host: &Host) -> Result<Self> {
        let salt = load_pane_id_salt(&store_path(host, "pane-id-salt", StoreScope::Global, None));
        let registry = IdRegistry::new(&salt);
        let grants = Arc::new(GrantTable::default());
        let parked = ParkedStore::new(store_path(
            host,
            "parked-sessions",
            StoreScope::Global,
            None,
        ));
        let terminal_states = TerminalStates::default();
        let sandboxes = WorkspaceSandboxes::default();

        let mut methods = MethodTable::default();
        register_park_methods(&mut methods, &parked, &from_activity())
            .map_err(|error| Error::Task(error.to_string()))?;

        let auth = Arc::new(ControlAuth::new(ControlAuthParts {
            registry: registry.clone(),
            caps: grants.clone(),
            script_tokens: Arc::new(|_: &str| None),
            cap_filter: Arc::new(|_, _| true),
            approver: None,
            clock: system_clock(),
        }));
        let states = terminal_states.clone();
        let sandboxed = sandboxes.clone();
        let deps = ServerDeps {
            auth,
            version: None,
            is_sandboxed: Arc::new(move |workspace| sandboxed.is_enabled(workspace)),
            pty_pid: Arc::new(|_| None),
            terminal_state: Arc::new(move |pane| states.get(pane)),
            script_covers: Arc::new(|_, _, _| async { false }.boxed()),
        };

        let socket = control_socket_path_for(std::process::id(), host)?;
        let listener = ControlServer::new(deps, methods).listen(&socket)?;
        let info_path = control_info_path(host);
        write_control_info(&info_path, &socket, std::process::id());
        Ok(Self {
            registry,
            grants,
            parked,
            terminal_states,
            sandboxes,
            socket,
            listener,
            info_path,
        })
    }

    pub fn stop(self) {
        clear_control_info(&self.info_path, &self.socket);
        self.listener.stop();
    }
}
