// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! Instruction handlers, one file per domain.
//!
//! Each file owns both the handler bodies and the `#[derive(Accounts)]` contexts they take, so
//! a reviewer reading one domain never has to hold a second file open to see what the accounts
//! are. `lib.rs` is a dispatcher and holds neither.
//!
//! `amm`, `pol` and `ve` were already shaped this way and moved here unchanged.

pub mod admin;
pub mod amm;
pub mod borrow;
pub mod bribes;
pub mod curve;
pub mod emissions;
pub mod gauges;
pub mod migrate;
pub mod partners;
pub mod pol;
pub mod stake;
pub mod ve;
pub mod vesting;

pub use admin::*;
#[allow(ambiguous_glob_reexports)]
pub use amm::*;
pub use borrow::*;
pub use bribes::*;
pub use curve::*;
pub use emissions::*;
pub use gauges::*;
pub use migrate::*;
pub use partners::*;
#[allow(ambiguous_glob_reexports)]
pub use pol::*;
pub use stake::*;
#[allow(ambiguous_glob_reexports)]
pub use ve::*;
pub use vesting::*;
