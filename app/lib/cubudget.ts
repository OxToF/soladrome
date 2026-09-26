// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
//
// The keeper's compute budget, sized from the simulation instead of guessed.
//
// ☢️ WHY IT MATTERS: the priority fee is charged on the compute units REQUESTED, not consumed.
// The keeper used to request 600 000 CU for rounds that consume 45 000–90 000, so six sevenths of
// every priority fee paid for nothing — about 30 000 of the 35 000 lamports a round cost. The
// cranker is paid nothing by the protocol, so that bill is the protocol's, once per strategy per
// round, forever.
import { ComputeBudgetProgram, TransactionInstruction } from "@solana/web3.js";

/// What a simulation may use: the old fixed request, so the measurement itself never runs out.
export const CU_SIM_LIMIT = 600_000;
/// The priority price, unchanged: this module sizes the request, it does not bid differently.
export const CU_PRICE_MICROLAMPORTS = 50_000;
/// Headroom over the simulated figure, as a ratio and as a floor. The state can move between the
/// simulation and the landing slot (a fee accrual to pay out, a larger harvest), and a round that
/// runs out of compute still pays its fee.
const MARGIN_RATIO = 1.2;
const MARGIN_MIN = 20_000;

/// The limit to request for a transaction that simulated at `consumed` CU.
export function cuLimitFor(consumed: number | null | undefined): number {
  if (!consumed || consumed <= 0) return CU_SIM_LIMIT;
  const sized = Math.max(Math.ceil(consumed * MARGIN_RATIO), consumed + MARGIN_MIN);
  return Math.min(CU_SIM_LIMIT, sized);
}

/// The two compute-budget instructions, first in any transaction the keeper sends.
export function computeBudget(units: number): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICROLAMPORTS }),
  ];
}

/// Lamports a transaction pays at `units` requested: the 5 000 base signature fee plus the
/// priority fee on the request. For the log, so the saving is visible round by round.
export function feeLamports(units: number): number {
  return 5_000 + Math.ceil((units * CU_PRICE_MICROLAMPORTS) / 1_000_000);
}
