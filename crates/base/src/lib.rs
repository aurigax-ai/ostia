pub mod atomic_write;
pub mod clock;
pub mod error;
pub mod events;
pub mod host;
pub mod ids;
pub mod js;
pub mod json_store;
pub mod node_path;
pub mod owner_thread;
pub mod path_guard;
pub mod private_tmp;
pub mod process;
pub mod random;
pub mod regular_file;

pub use error::{Error, Result};
pub use events::EventHub;
pub use host::{Host, Platform};
pub use ids::{ExternalId, PaneId, WindowId, WorkspaceId};
pub use owner_thread::{JobLost, OwnerThread};

pub const PRODUCT_NAME: &str = "ostia";
pub const APP_DIR_NAME: &str = "ostia-rs";
