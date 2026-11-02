pub mod park;

use ostia_base::host::Host;
use ostia_base::json_store::{StoreScope, store_path};
use ostia_park::ParkedStore;

use park::ParkBridge;

#[derive(Clone)]
pub struct Bridge {
    pub park: ParkBridge,
}

impl Bridge {
    pub fn for_host(host: &Host) -> Self {
        let parked = ParkedStore::new(store_path(
            host,
            "parked-sessions",
            StoreScope::Global,
            None,
        ));
        Self {
            park: ParkBridge::new(parked),
        }
    }
}
