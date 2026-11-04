use std::path::{Path, PathBuf};

use ostia_base::Result;
use ostia_base::node_path;
use ostia_contract::capabilities::Capability;
use ostia_contract::extensions::ExtensionSettingValues;
use serde::Serialize;
use serde_json::Value;

use crate::extension_store::{ExtensionRecord, ExtensionStore};

#[derive(Clone, Debug, Default)]
pub struct Contributes {
    pub snippets: Option<Vec<Value>>,
    pub completions: Option<String>,
    pub languages: Vec<Value>,
    pub keymaps: Vec<Value>,
    pub editor_languages: Vec<Value>,
    pub language_servers: Vec<Value>,
    pub agent_skills: Vec<Value>,
    pub agent_hooks: Vec<Value>,
    pub icon_themes: Vec<Value>,
}

#[derive(Clone, Debug)]
pub struct ContributionRuntime {
    pub ext_id: String,
    pub ext_name: String,
    pub dir: PathBuf,
    pub builtin: bool,
    pub contributes: Contributes,
}

pub trait ExtensionContributionsHost {
    fn runtimes(&self) -> Vec<ContributionRuntime>;
    fn active(&self, ext_id: &str) -> bool;
    fn pending(&self, ext_id: &str) -> bool;
    fn record(&self, ext_id: &str) -> ExtensionRecord;
    fn granted(&self, ext_id: &str) -> Vec<Capability>;
    fn setting_values(&self, ext_id: &str) -> ExtensionSettingValues;
    fn eager(&self, ext_id: &str) -> bool;
    fn start(&self, ext_id: &str);
    fn changed(&self, ext_id: Option<&str>);
    fn store(&self) -> &ExtensionStore;
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetSource {
    pub ext_id: String,
    pub snippets: Vec<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageSource {
    pub ext_id: String,
    pub dir: String,
    pub language: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeymapSource {
    pub ext_id: String,
    pub dir: String,
    pub keymap: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LanguageServerState {
    On,
    Off,
    Pending,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerSource {
    pub ext_id: String,
    pub ext_name: String,
    pub dir: String,
    pub builtin: bool,
    pub state: LanguageServerState,
    pub server: Value,
    pub setting_values: ExtensionSettingValues,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPluginSource {
    pub ext_id: String,
    pub builtin: bool,
    pub dir: String,
    pub skills: Vec<Value>,
    pub hooks: Vec<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct IconThemeSource {
    pub dir: String,
    pub theme: Value,
}

fn dir_text(dir: &Path) -> String {
    dir.to_string_lossy().into_owned()
}

fn server_id(server: &Value) -> Option<&str> {
    server.get("id").and_then(Value::as_str)
}

pub struct ExtensionContributions<H> {
    host: H,
}

impl<H: ExtensionContributionsHost> ExtensionContributions<H> {
    pub fn new(host: H) -> Self {
        Self { host }
    }

    fn active_runtimes(&self) -> Vec<ContributionRuntime> {
        self.host
            .runtimes()
            .into_iter()
            .filter(|runtime| self.host.active(&runtime.ext_id))
            .collect()
    }

    pub fn snippets(&self) -> Vec<SnippetSource> {
        self.active_runtimes()
            .into_iter()
            .filter_map(|runtime| {
                Some(SnippetSource {
                    ext_id: runtime.ext_id,
                    snippets: runtime.contributes.snippets?,
                })
            })
            .collect()
    }

    pub fn completion_dirs(&self) -> Vec<String> {
        self.active_runtimes()
            .into_iter()
            .filter_map(|runtime| {
                let relative = runtime
                    .contributes
                    .completions
                    .filter(|text| !text.is_empty())?;
                let mut joined = dir_text(&node_path::join(&runtime.dir, &relative));
                if relative.ends_with('/') && !joined.ends_with('/') {
                    joined.push('/');
                }
                Some(joined)
            })
            .collect()
    }

    pub fn languages(&self) -> Vec<LanguageSource> {
        self.active_runtimes()
            .into_iter()
            .flat_map(|runtime| {
                let dir = dir_text(&runtime.dir);
                runtime
                    .contributes
                    .languages
                    .into_iter()
                    .map(move |language| LanguageSource {
                        ext_id: runtime.ext_id.clone(),
                        dir: dir.clone(),
                        language,
                    })
            })
            .collect()
    }

    pub fn keymaps(&self) -> Vec<KeymapSource> {
        self.active_runtimes()
            .into_iter()
            .flat_map(|runtime| {
                let dir = dir_text(&runtime.dir);
                runtime
                    .contributes
                    .keymaps
                    .into_iter()
                    .map(move |keymap| KeymapSource {
                        ext_id: runtime.ext_id.clone(),
                        dir: dir.clone(),
                        keymap,
                    })
            })
            .collect()
    }

    pub fn editor_languages(&self) -> Vec<LanguageSource> {
        self.active_runtimes()
            .into_iter()
            .flat_map(|runtime| {
                let dir = dir_text(&runtime.dir);
                runtime
                    .contributes
                    .editor_languages
                    .into_iter()
                    .map(move |language| LanguageSource {
                        ext_id: runtime.ext_id.clone(),
                        dir: dir.clone(),
                        language,
                    })
            })
            .collect()
    }

    fn language_server_state(&self, ext_id: &str, server_id: &str) -> LanguageServerState {
        if self.host.pending(ext_id) {
            return LanguageServerState::Pending;
        }
        let record = self.host.record(ext_id);
        if !record.enabled {
            return LanguageServerState::Off;
        }
        if !self
            .host
            .granted(ext_id)
            .contains(&Capability::LanguageServer)
        {
            return LanguageServerState::Pending;
        }
        if record.servers_off.iter().any(|off| off == server_id) {
            LanguageServerState::Off
        } else {
            LanguageServerState::On
        }
    }

    pub fn language_servers(&self) -> Vec<LanguageServerSource> {
        self.host
            .runtimes()
            .into_iter()
            .flat_map(|runtime| {
                let setting_values = self.host.setting_values(&runtime.ext_id);
                let dir = dir_text(&runtime.dir);
                runtime
                    .contributes
                    .language_servers
                    .into_iter()
                    .map(|server| LanguageServerSource {
                        ext_id: runtime.ext_id.clone(),
                        ext_name: runtime.ext_name.clone(),
                        dir: dir.clone(),
                        builtin: runtime.builtin,
                        state: self.language_server_state(
                            &runtime.ext_id,
                            server_id(&server).unwrap_or(""),
                        ),
                        server,
                        setting_values: setting_values.clone(),
                    })
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    pub fn set_language_server_enabled(
        &self,
        ext_id: &str,
        server: &str,
        enabled: bool,
    ) -> Result<()> {
        let Some(runtime) = self
            .host
            .runtimes()
            .into_iter()
            .find(|runtime| runtime.ext_id == ext_id)
        else {
            return Ok(());
        };
        if self.host.pending(ext_id) {
            return Ok(());
        }
        let declared = runtime
            .contributes
            .language_servers
            .iter()
            .any(|candidate| server_id(candidate) == Some(server));
        if !declared {
            return Ok(());
        }
        let record = self.host.record(ext_id);
        let mut servers_off = record.servers_off.clone();
        if enabled {
            servers_off.retain(|off| off != server);
        } else if !servers_off.iter().any(|off| off == server) {
            servers_off.push(server.to_owned());
        }
        self.host.store().set(
            ext_id,
            ExtensionRecord {
                enabled: enabled || record.enabled,
                approved: Some(record.approved.clone().unwrap_or_default()),
                approved_kinds: record.approved_kinds.clone(),
                servers_off,
            },
        )?;
        if enabled && !record.enabled && self.host.eager(ext_id) {
            self.host.start(ext_id);
        }
        self.host.changed(Some(ext_id));
        Ok(())
    }

    pub fn agent_plugins(&self) -> Vec<AgentPluginSource> {
        self.active_runtimes()
            .into_iter()
            .filter(|runtime| {
                self.host
                    .granted(&runtime.ext_id)
                    .contains(&Capability::AgentPlugin)
            })
            .map(|runtime| AgentPluginSource {
                ext_id: runtime.ext_id,
                builtin: runtime.builtin,
                dir: dir_text(&runtime.dir),
                skills: runtime.contributes.agent_skills,
                hooks: runtime.contributes.agent_hooks,
            })
            .filter(|source| !source.skills.is_empty() || !source.hooks.is_empty())
            .collect()
    }

    pub fn icon_themes(&self) -> Vec<IconThemeSource> {
        self.active_runtimes()
            .into_iter()
            .flat_map(|runtime| {
                let dir = dir_text(&runtime.dir);
                runtime
                    .contributes
                    .icon_themes
                    .into_iter()
                    .map(move |theme| IconThemeSource {
                        dir: dir.clone(),
                        theme,
                    })
            })
            .collect()
    }
}
