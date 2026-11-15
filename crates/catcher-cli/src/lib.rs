//! catcher CLI: protocol (identities, canonical JSON, statements, envelopes, policy), the agent client and the
//! command line, byte-compatible with the TypeScript packages in this repo.

pub mod agent;
pub mod api;
pub mod args;
pub mod auth;
pub mod bytes;
pub mod cli;
pub mod crypto;
pub mod envelope;
pub mod error;
pub mod identity;
pub mod json;
pub mod paths;
pub mod policy;
pub mod setup;
pub mod statements;
pub mod store;
pub mod watch;
