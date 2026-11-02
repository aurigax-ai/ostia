use std::collections::BTreeMap;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use ostia_base::js::non_empty;
use ostia_contract::app_link_settings::{
    AppLinkSettings, app_link_asks, parse_allowed_app_schemes, parse_ask_before_opening_apps,
};
use ostia_contract::external_links::{
    ExternalLinkPolicy, app_link_scheme, browser_page_of, external_href,
};
use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};
use serde_json::Value;

use crate::app_handler::{HandlerLookup, handler_name};
use crate::browser_pages::{BrowserHost, BrowserLaunch, browser_launch};

pub type StartBrowser =
    Arc<dyn Fn(BrowserLaunch, BTreeMap<String, String>) -> BoxFuture<'static, bool> + Send + Sync>;

#[derive(Clone)]
pub struct AppLinkDeps {
    pub read_settings: Arc<dyn Fn() -> Value + Send + Sync>,
    pub open_external: Arc<dyn Fn(String) -> BoxFuture<'static, bool> + Send + Sync>,
    pub lookup: HandlerLookup,
    pub browser: BrowserHost,
    pub start_browser: StartBrowser,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkRefusal {
    Blocked,
    NoHandler,
}

impl LinkRefusal {
    fn text(self) -> &'static str {
        match self {
            Self::Blocked => "blocked",
            Self::NoHandler => "no-handler",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppLinkInfo {
    App(String),
    Refused(LinkRefusal),
}

impl Serialize for AppLinkInfo {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        match self {
            Self::App(app) => {
                map.serialize_entry("ok", &true)?;
                map.serialize_entry("app", app)?;
            }
            Self::Refused(refusal) => {
                map.serialize_entry("ok", &false)?;
                map.serialize_entry("error", refusal.text())?;
            }
        }
        map.end()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenLinkResult {
    Opened,
    Blocked,
    NoHandler,
    NotAllowed,
    Failed,
}

impl Serialize for OpenLinkResult {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let error = match self {
            Self::Opened => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("ok", &true)?;
                return map.end();
            }
            Self::Blocked => "blocked",
            Self::NoHandler => "no-handler",
            Self::NotAllowed => "not-allowed",
            Self::Failed => "failed",
        };
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("ok", &false)?;
        map.serialize_entry("error", error)?;
        map.end()
    }
}

enum Start {
    Href,
    Browser(BrowserLaunch),
}

enum Target {
    Direct {
        href: String,
    },
    App {
        href: String,
        scheme: String,
        app: String,
        start: Start,
    },
}

async fn resolve(deps: &AppLinkDeps, raw: &str) -> Result<Target, LinkRefusal> {
    let href = external_href(raw, ExternalLinkPolicy { apps: true }).ok_or(LinkRefusal::Blocked)?;
    let Some(scheme) = app_link_scheme(&href) else {
        return Ok(Target::Direct { href });
    };
    if let Some(page) = browser_page_of(&href) {
        let launch = browser_launch(page, &href, &deps.browser).ok_or(LinkRefusal::NoHandler)?;
        return Ok(Target::App {
            href,
            scheme,
            app: launch.app.clone(),
            start: Start::Browser(launch),
        });
    }
    let name = handler_name(&href, &deps.lookup).await;
    let app = non_empty(name.as_deref()).ok_or(LinkRefusal::NoHandler)?;
    Ok(Target::App {
        app: app.to_owned(),
        href,
        scheme,
        start: Start::Href,
    })
}

fn asks(deps: &AppLinkDeps, scheme: &str) -> bool {
    let settings = (deps.read_settings)();
    let terminal = settings.get("terminal");
    let setting = |key: &str| terminal.and_then(|terminal| terminal.get(key));
    app_link_asks(
        &AppLinkSettings {
            ask_before_opening_apps: parse_ask_before_opening_apps(setting("askBeforeOpeningApps")),
            allowed_app_schemes: parse_allowed_app_schemes(setting("allowedAppSchemes")),
        },
        scheme,
    )
}

pub async fn app_link_info(deps: &AppLinkDeps, raw: &Value) -> AppLinkInfo {
    let Some(raw) = raw.as_str() else {
        return AppLinkInfo::Refused(LinkRefusal::Blocked);
    };
    match resolve(deps, raw).await {
        Ok(Target::App { app, .. }) => AppLinkInfo::App(app),
        Ok(Target::Direct { .. }) => AppLinkInfo::Refused(LinkRefusal::Blocked),
        Err(refusal) => AppLinkInfo::Refused(refusal),
    }
}

pub async fn open_link(deps: &AppLinkDeps, raw: &Value, confirmed: &Value) -> OpenLinkResult {
    let Some(raw) = raw.as_str() else {
        return OpenLinkResult::Blocked;
    };
    let target = match resolve(deps, raw).await {
        Ok(target) => target,
        Err(LinkRefusal::Blocked) => return OpenLinkResult::Blocked,
        Err(LinkRefusal::NoHandler) => return OpenLinkResult::NoHandler,
    };
    let opened = match target {
        Target::Direct { href } => (deps.open_external)(href).await,
        Target::App {
            href,
            scheme,
            start,
            ..
        } => {
            if confirmed != &Value::Bool(true) && asks(deps, &scheme) {
                return OpenLinkResult::NotAllowed;
            }
            match start {
                Start::Href => (deps.open_external)(href).await,
                Start::Browser(launch) => {
                    (deps.start_browser)(launch, deps.browser.env.clone()).await
                }
            }
        }
    };
    if opened {
        OpenLinkResult::Opened
    } else {
        OpenLinkResult::Failed
    }
}
