use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: &str = "synax.runtime.v2";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Hello { token: String },
    Health,
    Shutdown,
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Ready {
        protocol: String,
        transport: String,
        capabilities: Vec<String>,
    },
    Health {
        ok: bool,
        protocol: String,
    },
    Pong,
    Ack {
        request: String,
    },
    Error {
        code: String,
        message: String,
    },
}

pub fn decode_client_message(bytes: &[u8]) -> Result<ClientMessage, serde_json::Error> {
    serde_json::from_slice(bytes)
}

pub fn encode_server_message(message: &ServerMessage) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_round_trips_hello() {
        let input = br#"{"type":"hello","token":"secret"}"#;
        assert_eq!(
            decode_client_message(input).unwrap(),
            ClientMessage::Hello {
                token: "secret".to_owned()
            }
        );
    }

    #[test]
    fn ready_message_contains_protocol_version() {
        let encoded = encode_server_message(&ServerMessage::Ready {
            protocol: PROTOCOL_VERSION.to_owned(),
            transport: "websocket".to_owned(),
            capabilities: vec!["health".to_owned()],
        })
        .unwrap();
        let text = String::from_utf8(encoded).unwrap();
        assert!(text.contains(PROTOCOL_VERSION));
    }
}
