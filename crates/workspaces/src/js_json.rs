use serde::{Serialize, Serializer};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct JsNumber(pub f64);

impl Serialize for JsNumber {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if self.0.fract() == 0.0 {
            serializer.serialize_i64(self.0 as i64)
        } else {
            serializer.serialize_f64(self.0)
        }
    }
}
