use prost::Message;
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

#[derive(Clone, PartialEq, Message)]
pub struct WireEnvelope {
    #[prost(string, tag = "1")]
    pub request_id: String,
    #[prost(string, tag = "2")]
    pub session_id: String,
    #[prost(uint64, tag = "3")]
    pub epoch: u64,
    #[prost(uint64, tag = "4")]
    pub revision: u64,
    #[prost(
        oneof = "wire_envelope::Body",
        tags = "10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43"
    )]
    pub body: Option<wire_envelope::Body>,
}

pub mod wire_envelope {
    use super::{
        WireAck, WireActivateRun, WireAdmitRun, WireAppendStream, WireCredit, WireError,
        WireEventBatch, WireFinishRun, WireHealth, WireHealthResponse, WireHello, WireIssueTicket,
        WireControlCommand, WireControlState, WireHistoryCommand, WireHistoryState, WirePing, WirePong, WireQueueMutation, WireQueueRead, WireQueueState, WireReady, WireSessionList, WireSessionListResponse,
        WireReplay, WireRunAdmission, WireSeedUi, WireShutdown, WireSnapshot, WireSnapshotResponse,
        WireSubscribe, WireTicket, WireUiSnapshot, WireUiSnapshotResponse,
    };
    use prost::Oneof;

    #[derive(Clone, PartialEq, Oneof)]
    pub enum Body {
        #[prost(message, tag = "36")]
        QueueRead(WireQueueRead),
        #[prost(message, tag = "37")]
        QueueState(WireQueueState),
        #[prost(message, tag = "38")]
        ControlCommand(WireControlCommand),
        #[prost(message, tag = "39")]
        ControlState(WireControlState),
        #[prost(message, tag = "40")]
        HistoryCommand(WireHistoryCommand),
        #[prost(message, tag = "41")]
        HistoryState(WireHistoryState),
        #[prost(message, tag = "42")]
        SessionList(WireSessionList),
        #[prost(message, tag = "43")]
        SessionListResponse(WireSessionListResponse),
        #[prost(message, tag = "34")]
        ActivateRun(WireActivateRun),
        #[prost(message, tag = "35")]
        QueueMutation(WireQueueMutation),
        #[prost(message, tag = "31")]
        SeedUi(WireSeedUi),
        #[prost(message, tag = "32")]
        UiSnapshot(WireUiSnapshot),
        #[prost(message, tag = "33")]
        UiSnapshotResponse(WireUiSnapshotResponse),
        #[prost(message, tag = "28")]
        IssueTicket(WireIssueTicket),
        #[prost(message, tag = "29")]
        Ticket(WireTicket),
        #[prost(message, tag = "30")]
        Credit(WireCredit),
        #[prost(message, tag = "27")]
        FinishRun(WireFinishRun),
        #[prost(message, tag = "10")]
        Hello(WireHello),
        #[prost(message, tag = "11")]
        Health(WireHealth),
        #[prost(message, tag = "12")]
        Shutdown(WireShutdown),
        #[prost(message, tag = "13")]
        Ping(WirePing),
        #[prost(message, tag = "14")]
        AdmitRun(WireAdmitRun),
        #[prost(message, tag = "15")]
        AppendStream(WireAppendStream),
        #[prost(message, tag = "16")]
        Snapshot(WireSnapshot),
        #[prost(message, tag = "17")]
        Replay(WireReplay),
        #[prost(message, tag = "18")]
        Subscribe(WireSubscribe),
        #[prost(message, tag = "19")]
        Ready(WireReady),
        #[prost(message, tag = "20")]
        HealthResponse(WireHealthResponse),
        #[prost(message, tag = "21")]
        Pong(WirePong),
        #[prost(message, tag = "22")]
        Ack(WireAck),
        #[prost(message, tag = "23")]
        Error(WireError),
        #[prost(message, tag = "24")]
        RunAdmission(WireRunAdmission),
        #[prost(message, tag = "25")]
        SnapshotResponse(WireSnapshotResponse),
        #[prost(message, tag = "26")]
        EventBatch(WireEventBatch),
    }
}

#[derive(Clone, PartialEq, Message)]
pub struct WireHello {
    #[prost(string, tag = "2")]
    pub client_id: String,
    #[prost(string, tag = "1")]
    pub token: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireActivateRun {
    #[prost(bytes = "vec", tag = "1")]
    pub run_json: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireQueueRead {}
#[derive(Clone, PartialEq, Message)]
pub struct WireQueueState {
    #[prost(bytes = "vec", tag = "1")]
    pub queue_json: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireControlCommand {
    #[prost(string, tag = "1")]
    pub operation: String,
    #[prost(bytes = "vec", tag = "2")]
    pub payload: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireControlState {
    #[prost(bytes = "vec", tag = "1")]
    pub state_json: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireHistoryCommand {
    #[prost(string, tag = "1")]
    pub operation: String,
    #[prost(bytes = "vec", tag = "2")]
    pub payload: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireHistoryState {
    #[prost(bytes = "vec", tag = "1")]
    pub state_json: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireSessionList {}

#[derive(Clone, PartialEq, Message)]
pub struct WireSessionListResponse {
    #[prost(bytes = "vec", tag = "1")]
    pub sessions_json: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireQueueMutation {
    #[prost(string, tag = "1")]
    pub operation: String,
    #[prost(bytes = "vec", tag = "2")]
    pub payload: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireSeedUi {
    #[prost(bytes = "vec", tag = "1")]
    pub session_json: Vec<u8>,
}
#[derive(Clone, PartialEq, Message)]
pub struct WireUiSnapshot {}
#[derive(Clone, PartialEq, Message)]
pub struct WireUiSnapshotResponse {
    #[prost(bytes = "vec", tag = "1")]
    pub snapshot_json: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireIssueTicket {
    #[prost(string, tag = "1")]
    pub client_id: String,
}
#[derive(Clone, PartialEq, Message)]
pub struct WireTicket {
    #[prost(string, tag = "1")]
    pub token: String,
    #[prost(uint64, tag = "2")]
    pub expires_at_ms: u64,
}
#[derive(Clone, PartialEq, Message)]
pub struct WireCredit {
    #[prost(uint64, tag = "1")]
    pub through_sequence: u64,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireHealth {}

#[derive(Clone, PartialEq, Message)]
pub struct WireShutdown {}

#[derive(Clone, PartialEq, Message)]
pub struct WirePing {}

#[derive(Clone, PartialEq, Message)]
pub struct WireAdmitRun {
    #[prost(string, tag = "1")]
    pub body_hash: String,
    #[prost(string, tag = "2")]
    pub run_id: String,
    #[prost(bytes = "vec", tag = "3")]
    pub queue_item_json: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireFinishRun {
    #[prost(string, tag = "1")]
    pub run_id: String,
    #[prost(string, tag = "2")]
    pub status: String,
    #[prost(bytes = "vec", tag = "3")]
    pub run_json: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireAppendStream {
    #[prost(string, tag = "1")]
    pub run_id: String,
    #[prost(string, tag = "2")]
    pub producer_id: String,
    #[prost(uint64, tag = "3")]
    pub producer_sequence: u64,
    #[prost(message, repeated, tag = "4")]
    pub events: Vec<WirePendingEvent>,
    #[prost(uint32, tag = "5")]
    pub durability: u32,
}

#[derive(Clone, PartialEq, Message)]
pub struct WirePendingEvent {
    #[prost(string, tag = "1")]
    pub kind: String,
    #[prost(bytes = "vec", tag = "2")]
    pub payload: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireSnapshot {}

#[derive(Clone, PartialEq, Message)]
pub struct WireReplay {
    #[prost(uint64, tag = "1")]
    pub after: u64,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireSubscribe {
    #[prost(uint64, tag = "1")]
    pub after: u64,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireReady {
    #[prost(string, tag = "1")]
    pub protocol: String,
    #[prost(string, tag = "2")]
    pub transport: String,
    #[prost(string, repeated, tag = "3")]
    pub capabilities: Vec<String>,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireHealthResponse {
    #[prost(bool, tag = "1")]
    pub ok: bool,
    #[prost(string, tag = "2")]
    pub protocol: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct WirePong {}

#[derive(Clone, PartialEq, Message)]
pub struct WireAck {
    #[prost(string, tag = "1")]
    pub request: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireError {
    #[prost(string, tag = "1")]
    pub code: String,
    #[prost(string, tag = "2")]
    pub message: String,
    #[prost(uint64, optional, tag = "3")]
    pub expected: Option<u64>,
    #[prost(uint64, optional, tag = "4")]
    pub actual: Option<u64>,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireRunAdmission {
    #[prost(string, tag = "1")]
    pub run_id: String,
    #[prost(uint64, tag = "2")]
    pub epoch: u64,
    #[prost(uint64, tag = "3")]
    pub revision: u64,
    #[prost(bool, tag = "4")]
    pub reused: bool,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireSnapshotResponse {
    #[prost(uint64, tag = "1")]
    pub epoch: u64,
    #[prost(uint64, tag = "2")]
    pub revision: u64,
    #[prost(string, optional, tag = "3")]
    pub active_run_id: Option<String>,
    #[prost(uint64, tag = "4")]
    pub cursor: u64,
    #[prost(uint64, tag = "5")]
    pub retained_from: u64,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireEventBatch {
    #[prost(message, repeated, tag = "1")]
    pub events: Vec<WireStreamEvent>,
}

#[derive(Clone, PartialEq, Message)]
pub struct WireStreamEvent {
    #[prost(uint64, tag = "1")]
    pub sequence: u64,
    #[prost(string, tag = "2")]
    pub run_id: String,
    #[prost(string, tag = "3")]
    pub kind: String,
    #[prost(bytes = "vec", tag = "4")]
    pub payload: Vec<u8>,
}

pub fn decode_wire(bytes: &[u8]) -> Result<WireEnvelope, prost::DecodeError> {
    WireEnvelope::decode(bytes)
}

pub fn encode_wire(envelope: &WireEnvelope) -> Vec<u8> {
    envelope.encode_to_vec()
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

    #[test]
    fn binary_envelope_round_trips_admission() {
        let envelope = WireEnvelope {
            request_id: "req-1".to_owned(),
            session_id: "session-1".to_owned(),
            epoch: 1,
            revision: 0,
            body: Some(wire_envelope::Body::AdmitRun(WireAdmitRun {
                body_hash: "hash".to_owned(),
                run_id: "run-1".to_owned(),
                queue_item_json: Vec::new(),
            })),
        };
        let decoded = decode_wire(&encode_wire(&envelope)).unwrap();
        assert_eq!(decoded, envelope);
    }
}
