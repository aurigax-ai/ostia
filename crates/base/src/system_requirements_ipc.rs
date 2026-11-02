use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::js::non_empty;
use crate::system_requirements::{InstallHint, MissingRequirement, RequirementsReport};

const PRODUCT_DISPLAY_NAME: &str = "Ostia";

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct InstallArgs {
    pub argv: Vec<String>,
}

type InstallHintFn = dyn Fn(&[MissingRequirement]) -> InstallHint + Send + Sync;
type InvokeInstallFn = dyn Fn(InstallArgs, Value) -> BoxFuture<Value> + Send + Sync;
type Lookup<T> = Arc<dyn Fn(&str) -> T + Send + Sync>;
type Supplier<T> = Arc<dyn Fn() -> T + Send + Sync>;

pub struct SystemRequirementsDeps {
    pub owner_window: Lookup<Option<String>>,
    pub work_dir: Lookup<Option<String>>,
    pub locale: Supplier<Option<String>>,
    pub system_extension_enabled: Supplier<bool>,
    pub missing: Lookup<Vec<MissingRequirement>>,
    pub settled: Option<Supplier<BoxFuture<()>>>,
    pub label: Option<Lookup<String>>,
    pub install_hint: Arc<InstallHintFn>,
    pub invoke_install: Arc<InvokeInstallFn>,
}

pub fn requirements_install_args(feature: &str, missing: &[MissingRequirement]) -> InstallArgs {
    let mut argv: Vec<String> = Vec::new();
    for item in missing {
        if !argv.contains(&item.package) {
            argv.push(item.package.clone());
        }
    }
    argv.push("--reason".to_owned());
    argv.push(format!(
        "{PRODUCT_DISPLAY_NAME}'s {feature} feature needs them"
    ));
    argv.push("--wait".to_owned());
    InstallArgs { argv }
}

#[derive(Clone)]
pub struct SystemRequirementsService {
    deps: Arc<SystemRequirementsDeps>,
}

impl SystemRequirementsService {
    pub fn new(deps: SystemRequirementsDeps) -> Self {
        Self {
            deps: Arc::new(deps),
        }
    }

    pub async fn requirements(&self, feature: &Value) -> Option<RequirementsReport> {
        let feature = feature.as_str()?;
        if let Some(settled) = &self.deps.settled {
            settled().await;
        }
        let missing = (self.deps.missing)(feature);
        let hint = (self.deps.install_hint)(&missing);
        let can_install = !missing.is_empty() && (self.deps.system_extension_enabled)();
        Some(RequirementsReport {
            missing,
            hint,
            can_install,
        })
    }

    pub async fn install_requirements(
        &self,
        sender: &str,
        feature: &Value,
        workspace_id: &Value,
    ) -> Value {
        let (Some(feature), Some(workspace_id)) = (feature.as_str(), workspace_id.as_str()) else {
            return not_allowed();
        };
        if (self.deps.owner_window)(workspace_id).as_deref() != Some(sender) {
            return not_allowed();
        }
        let missing = (self.deps.missing)(feature);
        if missing.is_empty() {
            return json!({"ok": true});
        }
        let work_dir = (self.deps.work_dir)(workspace_id);
        let mut caller = Map::new();
        caller.insert("kind".to_owned(), json!("user"));
        caller.insert("workspaceId".to_owned(), json!(workspace_id));
        if let Some(work_dir) = non_empty(work_dir.as_deref()) {
            caller.insert("workDir".to_owned(), json!(work_dir));
            caller.insert("cwd".to_owned(), json!(work_dir));
        }
        if let Some(locale) = (self.deps.locale)() {
            caller.insert("locale".to_owned(), json!(locale));
        }
        caller.insert("capabilities".to_owned(), json!(["shell"]));
        let label = self
            .deps
            .label
            .as_ref()
            .map_or_else(|| feature.to_owned(), |label| label(feature));
        (self.deps.invoke_install)(
            requirements_install_args(&label, &missing),
            Value::Object(caller),
        )
        .await
    }
}

fn not_allowed() -> Value {
    json!({"ok": false, "error": "not-allowed"})
}
