export const EPOCH_S = 7 * 24 * 60 * 60; // 604 800 s — mirrors EPOCH_DURATION in state.rs

export function currentEpoch(): number {
  return Math.floor(Date.now() / 1000 / EPOCH_S);
}

export function epochEnd(e: number): Date {
  return new Date((e + 1) * EPOCH_S * 1000);
}

export function epochLabel(e: number): string {
  const start = new Date(e * EPOCH_S * 1000);
  const end   = new Date((e + 1) * EPOCH_S * 1000);
  const fmt   = (d: Date) => d.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" });
  return `Epoch ${e} · ${fmt(start)} – ${fmt(end)}`;
}

export function timeLeft(d: Date): string {
  const s = Math.max(0, Math.floor((d.getTime() - Date.now()) / 1000));
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return days > 0 ? `${days}d ${h}h ${m}m` : `${h}h ${m}m`;
}
