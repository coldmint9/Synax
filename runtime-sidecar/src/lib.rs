//! Library target shared by the sidecar binary and its tests/benches.

pub mod actor;
pub mod agent_loop;
pub mod completion;
pub mod control;
pub mod execution;
pub mod flow;
pub mod input_queue;
pub mod jsonl;
pub mod loop_context;
pub mod loop_policy;
pub mod projection;
pub mod provider;
pub mod provider_adapter;
pub mod provider_metadata;
pub mod provider_tool_names;
pub mod protocol;
pub mod session_types;
pub mod tickets;
pub mod transport;
pub mod workspace_index;
