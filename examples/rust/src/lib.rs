pub mod bindings;
pub mod utils;
pub mod grpc_adapters;

pub mod grpc_codegen {
    #![allow(clippy::derive_partial_eq_without_eq)]
    tonic::include_proto!("valorem.trade.v1");
}