use std::sync::Arc;

use futures_util::future::BoxFuture;
use ostia_contract::agent_stream::StreamEvent;
use serde_json::Value;

use crate::manager::ManagerService;
use crate::stream_pi::PiStreamPort;

type Stop = Box<dyn FnOnce() + Send + Sync>;

pub trait SessionHost: Send + Sync {
    fn session_of_pane(&self, pane_id: &str) -> Option<String>;
    fn stream(&self, session_id: &str) -> Option<Arc<dyn PiStreamPort>>;
    fn watch_waiting(&self, session_id: &str, listener: Arc<dyn Fn(bool) + Send + Sync>) -> Stop;
    fn prompt_from_portal(&self, session_id: &str, text: &str) -> BoxFuture<'static, Value>;
}

pub trait ManagerEnds: Send + Sync {
    fn on_end(&self, listener: Arc<dyn Fn(&str) + Send + Sync>) -> Stop;
}

impl ManagerEnds for ManagerService {
    fn on_end(&self, listener: Arc<dyn Fn(&str) + Send + Sync>) -> Stop {
        ManagerService::on_end(self, listener)
    }
}

#[derive(Clone)]
pub struct SessionSink {
    pub events: Arc<dyn Fn(Vec<StreamEvent>) + Send + Sync>,
    pub waiting: Arc<dyn Fn(bool) + Send + Sync>,
    pub ended: Arc<dyn Fn() + Send + Sync>,
}

pub struct SessionHandle {
    host: Arc<dyn SessionHost>,
    session_id: String,
    stops: Vec<Stop>,
}

impl SessionHandle {
    pub fn prompt(&self, text: &str) -> BoxFuture<'static, Value> {
        self.host.prompt_from_portal(&self.session_id, text)
    }

    pub fn detach(self) {
        for stop in self.stops {
            stop();
        }
    }
}

pub struct ManagerSessionDeps {
    pub sessions: Box<dyn Fn() -> Option<Arc<dyn SessionHost>> + Send + Sync>,
    pub manager: Box<dyn Fn() -> Option<Arc<dyn ManagerEnds>> + Send + Sync>,
}

pub fn create_session_attacher(
    deps: ManagerSessionDeps,
) -> impl Fn(&str, SessionSink) -> Option<SessionHandle> {
    move |pane_id, sink| {
        let host = (deps.sessions)();
        let session_id = host
            .as_ref()
            .and_then(|host| host.session_of_pane(pane_id))
            .filter(|id| !id.is_empty());
        let stream = session_id
            .as_ref()
            .and_then(|id| host.as_ref().and_then(|host| host.stream(id)));
        let service = (deps.manager)();
        let (host, session_id, stream, service) = (host?, session_id?, stream?, service?);
        let ended_pane = pane_id.to_owned();
        let ended = Arc::clone(&sink.ended);
        let stops = vec![
            stream.subscribe(sink.events),
            host.watch_waiting(&session_id, sink.waiting),
            service.on_end(Arc::new(move |ended_id: &str| {
                if ended_id == ended_pane {
                    ended();
                }
            })),
        ];
        Some(SessionHandle {
            host,
            session_id,
            stops,
        })
    }
}
