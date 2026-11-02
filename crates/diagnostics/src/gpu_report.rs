use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::future::BoxFuture;
use serde_json::Value;

use crate::app_log::{AppLog, LogFields};

#[derive(Debug, Clone, Default)]
pub struct GpuDevice {
    pub active: bool,
    pub vendor_id: Option<u32>,
    pub device_id: Option<u32>,
    pub driver_vendor: Option<String>,
    pub driver_version: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct GpuInfo {
    pub gpu_device: Vec<GpuDevice>,
    pub gl_renderer: Option<String>,
    pub gl_version: Option<String>,
    pub gl_vendor: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct GpuFeatureStatus {
    pub webgl: Option<String>,
    pub webgl2: Option<String>,
    pub gpu_compositing: Option<String>,
    pub rasterization: Option<String>,
}

pub trait GpuSource: Send + Sync {
    fn info(&self) -> BoxFuture<'_, Result<GpuInfo, String>>;
    fn feature_status(&self) -> GpuFeatureStatus;
}

fn hex(id: Option<u32>) -> String {
    id.map_or_else(|| "?".to_owned(), |id| format!("{id:x}"))
}

pub fn gpu_facts(status: &GpuFeatureStatus, info: &GpuInfo) -> LogFields {
    let text = |value: &Option<String>| Value::from(value.as_deref().unwrap_or(""));
    let devices = info
        .gpu_device
        .iter()
        .map(|device| {
            format!(
                "{}{}:{}",
                if device.active { "*" } else { "" },
                hex(device.vendor_id),
                hex(device.device_id)
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    let mut facts = LogFields::new();
    facts.insert("glRenderer".to_owned(), text(&info.gl_renderer));
    facts.insert("glVersion".to_owned(), text(&info.gl_version));
    facts.insert("devices".to_owned(), Value::from(devices));
    facts.insert("webgl".to_owned(), text(&status.webgl));
    facts.insert("webgl2".to_owned(), text(&status.webgl2));
    facts.insert("gpuCompositing".to_owned(), text(&status.gpu_compositing));
    facts.insert("rasterization".to_owned(), text(&status.rasterization));
    facts
}

pub struct GpuReport {
    log: Arc<dyn AppLog>,
    source: Arc<dyn GpuSource>,
    reported_once: AtomicBool,
}

impl GpuReport {
    pub fn new(log: Arc<dyn AppLog>, source: Arc<dyn GpuSource>) -> Self {
        Self {
            log,
            source,
            reported_once: AtomicBool::new(false),
        }
    }

    pub async fn gpu_info_updated(&self) {
        if !self.reported_once.swap(true, Ordering::SeqCst) {
            self.report("gpu-info").await;
        }
    }

    pub async fn child_process_gone(&self, kind: &str) {
        if kind == "GPU" {
            self.report("gpu-info-after-gone").await;
        }
    }

    async fn report(&self, event: &str) {
        match self.source.info().await {
            Ok(info) => {
                let facts = gpu_facts(&self.source.feature_status(), &info);
                self.log.info(event, &facts);
            }
            Err(message) => {
                let mut fields = LogFields::new();
                fields.insert("error".to_owned(), Value::from(message));
                self.log.warn(event, &fields);
            }
        }
    }
}
