//! A constructor for small JSON literals that does not depend on macro text.

use serde_json::Value;

use super::wire::HistoryError;

/// Build an object from `(key, value)` fields.
pub fn object(fields: &[(&str, Value)]) -> Value {
    let mut map = serde_json::Map::new();
    for (key, value) in fields {
        map.insert((*key).to_owned(), value.clone());
    }
    Value::Object(map)
}

/// An empty object.
pub fn empty() -> Value {
    Value::Object(serde_json::Map::new())
}

/// A string value.
pub fn text(value: &str) -> Value {
    Value::String(value.to_owned())
}

/// A number value.
pub fn number(value: u64) -> Value {
    Value::Number(value.into())
}

/// A boolean value.
pub fn boolean(value: bool) -> Value {
    Value::Bool(value)
}

/// An array value.
pub fn array(values: Vec<Value>) -> Value {
    Value::Array(values)
}

/// Serialization into a JSON value, reported as a command error.
pub fn convert_value<T: serde::Serialize>(value: T) -> Result<Value, HistoryError> {
    serde_json::to_value(value)
        .map_err(|error| HistoryError::InvalidCommand(format!("serialization: {error}")))
}
