use std::collections::HashMap;
use std::sync::Arc;

use ostia_base::PaneId;
use parking_lot::Mutex;

type WaitingSince = Arc<dyn Fn(&PaneId) -> Option<i64> + Send + Sync>;
type InputSent = Arc<dyn Fn(&PaneId) + Send + Sync>;

pub struct PhoneInputNoter {
    waiting_since: WaitingSince,
    input_sent: InputSent,
    noted: Mutex<HashMap<PaneId, i64>>,
}

pub fn phone_input_noter(
    waiting_since: impl Fn(&PaneId) -> Option<i64> + Send + Sync + 'static,
    input_sent: impl Fn(&PaneId) + Send + Sync + 'static,
) -> PhoneInputNoter {
    PhoneInputNoter {
        waiting_since: Arc::new(waiting_since),
        input_sent: Arc::new(input_sent),
        noted: Mutex::new(HashMap::new()),
    }
}

impl PhoneInputNoter {
    pub fn note(&self, pane: &PaneId) {
        let since = (self.waiting_since)(pane);
        {
            let mut noted = self.noted.lock();
            let Some(since) = since else {
                noted.remove(pane);
                return;
            };
            if noted.get(pane) == Some(&since) {
                return;
            }
            noted.insert(pane.clone(), since);
        }
        (self.input_sent)(pane);
    }
}
