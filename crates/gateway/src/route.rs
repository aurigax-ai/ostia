use std::path::PathBuf;
use std::sync::Arc;

use ostia_base::Host;
use ostia_base::error::{Error, Result as StoreResult};
use ostia_base::json_store::{SaveOptions, StoreScope, load_json, save_json, store_path};
use parking_lot::Mutex;
use serde_json::{Map, Value};

use crate::friendly_name::{is_friendly_name, random_friendly_name};
use crate::gateway_route::{
    default_gateway_route, is_bind_address, is_bind_interface, phone_address_of,
};
use crate::{GatewayRoute, LOOPBACK_ADDRESS};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteProblem {
    UnknownAddress,
    InvalidPhoneAddress,
    TwoMethods,
}

fn flag(value: Option<&Value>) -> Option<bool> {
    value.and_then(Value::as_bool)
}

pub fn check_route(value: &Value) -> Result<GatewayRoute, RouteProblem> {
    let Some(object) = value.as_object() else {
        return Err(RouteProblem::UnknownAddress);
    };
    let bind_address = object.get("bindAddress");
    let bind_interface = object.get("bindInterface");
    let (Some(tailnet), Some(relay)) = (flag(object.get("tailnet")), flag(object.get("relay")))
    else {
        return Err(RouteProblem::UnknownAddress);
    };
    if !is_bind_address(bind_address) || !is_bind_interface(bind_interface) {
        return Err(RouteProblem::UnknownAddress);
    }
    let on_loopback = bind_address.and_then(Value::as_str) == Some(LOOPBACK_ADDRESS);
    let no_card = bind_interface == Some(&Value::Null);
    if on_loopback != no_card {
        return Err(RouteProblem::UnknownAddress);
    }
    let phone_address = match object.get("phoneAddress") {
        Some(Value::Null) => None,
        other => Some(phone_address_of(other).ok_or(RouteProblem::InvalidPhoneAddress)?),
    };
    let direct = !no_card || phone_address.is_some();
    if [relay, tailnet, direct]
        .into_iter()
        .filter(|on| *on)
        .count()
        > 1
    {
        return Err(RouteProblem::TwoMethods);
    }
    Ok(GatewayRoute {
        bind_address: bind_address
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_default(),
        bind_interface: bind_interface.and_then(Value::as_str).map(str::to_owned),
        tailnet,
        phone_address,
        relay,
    })
}

#[derive(Clone)]
pub struct RouteConfig {
    path: PathBuf,
    writing: Arc<Mutex<()>>,
}

impl RouteConfig {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            writing: Arc::new(Mutex::new(())),
        }
    }

    pub fn for_host(host: &Host) -> Self {
        Self::new(store_path(host, "gateway-config", StoreScope::Global, None))
    }

    fn load_config(&self) -> Map<String, Value> {
        match load_json(&self.path) {
            Some(Value::Object(config)) => config,
            _ => Map::new(),
        }
    }

    fn save_field(&self, key: &str, value: Value) -> StoreResult<()> {
        let _writing = self.writing.lock();
        let mut config = self.load_config();
        config.insert(key.to_owned(), value);
        self.save(config)
    }

    fn save(&self, config: Map<String, Value>) -> StoreResult<()> {
        save_json(&self.path, &Value::Object(config), SaveOptions::default())
    }

    pub fn load_phone_workspace_record(&self) -> Option<Value> {
        self.load_config().get("phoneWorkspace").cloned()
    }

    pub fn save_phone_workspace_record(&self, phone_workspace: &Value) -> StoreResult<()> {
        self.save_field("phoneWorkspace", phone_workspace.clone())
    }

    pub fn load_route(&self) -> GatewayRoute {
        let config = self.load_config();
        check_route(config.get("route").unwrap_or(&Value::Null))
            .unwrap_or_else(|_| default_gateway_route())
    }

    pub fn save_route(&self, route: &GatewayRoute) -> StoreResult<()> {
        let value = serde_json::to_value(route).map_err(|source| Error::Json {
            path: self.path.clone(),
            source,
        })?;
        self.save_field("route", value)
    }

    pub fn load_discoverable(&self) -> bool {
        self.load_config().get("discoverable") == Some(&Value::Bool(true))
    }

    pub fn save_discoverable(&self, discoverable: bool) -> StoreResult<()> {
        self.save_field("discoverable", Value::Bool(discoverable))
    }

    pub fn friendly_name(&self) -> StoreResult<String> {
        let _writing = self.writing.lock();
        let mut config = self.load_config();
        if let Some(Value::String(name)) = config.get("friendlyName")
            && is_friendly_name(name)
        {
            return Ok(name.clone());
        }
        let fresh = random_friendly_name();
        config.insert("friendlyName".to_owned(), Value::String(fresh.clone()));
        self.save(config)?;
        Ok(fresh)
    }
}
