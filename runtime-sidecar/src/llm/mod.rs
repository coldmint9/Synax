pub mod contract;
pub mod media;
mod policy;
pub(crate) use policy::prepare;
mod cache;
mod client;
mod common;
pub mod completion;
pub(crate) mod deadline;
pub(crate) mod errors;
mod messages;
pub mod metadata;
mod request;
pub mod retry;
pub mod tool_names;

pub(crate) type Error = Box<dyn std::error::Error + Send + Sync>;
pub(crate) mod tokenizer;
mod scheduling;
