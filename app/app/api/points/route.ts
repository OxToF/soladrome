// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
//
// Phase-2 points — read API for the Points page.
//   GET /api/points?wallet=<pubkey>  → this wallet's genesis + LP points + breakdown
//   GET /api/points                  → boosted-pools board only (no wallet)
// Read-only. Uses the anon-readable views (points_total, lp_points,
// pool_multiplier_board); no service key needed, nothing here can mutate points.
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// Anon key is enough — writes are gated by RLS to the service key elsewhere.
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY!,
);

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet");

  // Boosted-pools board is public and wallet-independent.
  const { data: boosted } = await supabase
    .from("pool_multiplier_board")
    .select("pool_address, multiplier_bps, label")
    .gt("multiplier_bps", 10000);

  if (!wallet || wallet.length < 32 || wallet.length > 44) {
    return NextResponse.json({ wallet: null, boostedPools: boosted ?? [] });
  }

  const [{ data: totalRows }, { data: poolRows }] = await Promise.all([
    supabase.from("points_total").select("*").eq("wallet_address", wallet).limit(1),
    supabase.from("lp_points")
      .select("pool_address, points_accrued, last_value_usd, last_snapshot_at")
      .eq("wallet_address", wallet)
      .order("points_accrued", { ascending: false }),
  ]);

  const t: any = totalRows?.[0];
  return NextResponse.json({
    wallet,
    genesisPoints: t?.genesis_points ?? 0,
    lpPoints:      t?.lp_points ?? 0,
    totalPoints:   t?.total_points ?? 0,
    byPool:        poolRows ?? [],
    boostedPools:  boosted ?? [],
  });
}
