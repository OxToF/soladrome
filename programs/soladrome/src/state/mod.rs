// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! On-chain account layouts.
//!
//! One file per domain. These modules hold `#[account]` data and the accessors that read or
//! mutate a single account in isolation (`LEN`, size guards, `settle_fees`, `ve_power`) —
//! never instruction logic, never an `#[derive(Accounts)]` context. Anything that touches two
//! accounts at once belongs in `instructions/`.

pub mod amm;
pub mod bribes;
pub mod emissions;
pub mod gauges;
pub mod pol;
pub mod position;
pub mod protocol;
pub mod ve;
pub mod vesting;

pub use amm::*;
pub use bribes::*;
pub use emissions::*;
pub use gauges::*;
pub use pol::*;
pub use position::*;
pub use protocol::*;
pub use ve::*;
pub use vesting::*;
