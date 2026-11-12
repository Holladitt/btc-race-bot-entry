// Baseline v1: slow-trend long-only bot for cbBTC (CBBTC/USDC, 1-minute bars).
//
// Idea, in one line: ride multi-hour uptrends, sit out everything else.
// The dev window (24h, BTC -2.3%) punishes fast 1-minute signals: an EMA(8)/EMA(21)
// cross flips ~70 times a day and every round trip pays ~28 bps in fee + slippage +
// price impact, so plain crossover trading loses ~$63 on $1,000. This bot therefore
// trades rarely and only inside a slow uptrend, and only near the trend's base.
//
// Rules (all constants below, all in basis points unless noted):
//   - Trend: close above EMA(180) and EMA(60) above EMA(180). EMAs are seeded at the
//     first close (standard exponential init) so the bot can trade from the first bars;
//     the kit baseline seeds with the mean of the first span instead.
//   - Momentum: the 60-minute return is positive.
//   - Fee-aware entry filter (the 2.5x rule): the close must sit within 70 bps of its
//     60-bar low. A full-size round trip costs ~26-28 bps (4 bps fee + 2 bps slippage
//     per side, ~8 bps of price impact per side at the pool depth the universe froze
//     at), so 70 bps is ~2.5x the round-trip cost: we only pay it when we buy near
//     the base of the move, not after the move is already consumed. On the dev window
//     this waits out a 5-bar chase and enters $118 lower on the one winning trade.
//   - Cooldown: 30 bars after any exit before the next entry (anti-whipsaw).
//   - Exits (whole position): trend break (close back under EMA(180) or EMA(60) under
//     EMA(180)), or a trailing stop 80 bps under the highest close since entry, or
//     take-profit 200 bps over the entry price. Stops are sized from the 60-minute
//     return volatility (~37 bps stdev on the dev window), not from the 1-minute ATR
//     (~3.6 bps), which is far too tight to survive hourly noise.
//   - Sizing: 100% of equity (max weight 10,000 bps), one order per reply at most.
//   - max_slippage_bps 100 (1% past the close decided on), as the kit baseline uses.
//   - No orders while warming up; no wall clock, no network, no files, no randomness:
//     two runs on the same bars produce the same orders.
//
// Dev-window result (official grade-local, --driver process, 2 executions):
//   Net PnL +2.03 USDC, 4 trades / 2 round trips, win rate 0.50,
//   max drawdown 0.82%, fees $1.60, net PnL at 2x fees +$0.42, 0 rejected,
//   guardrails met, L1 regrade reproduced byte for byte (deterministic).
//   The gate needs > $0; this clears it with a small margin. It is a baseline,
//   not a tuned optimum: the two trades are the only ones the rules fire in 24h.
//   (A local replay with the same fill model gave +$1.47; the +$0.56 gap is the
//   harness's exact fill sequencing vs the replay's approximation.)

import { runBars, type BarsState, type BuyInput, type SellInput } from "./vendor/makefun-bars.ts";

/** Basis points per unit as a plain number (the SDK's BPS is a bigint). */
const BPS_NUM = 10000;

const SYMBOL = "CBBTC";
const FAST_SPAN = 60; // 1 hour
const SLOW_SPAN = 180; // 3 hours
const LOOKBACK_BARS = 60; // momentum + base window, in bars
const EXTENSION_CAP_BPS = 70; // ~2.5x the ~28 bps full-size round-trip cost
const COOLDOWN_BARS = 30;
const TRAIL_BPS = 80;
const TAKE_PROFIT_BPS = 200;
const MAX_SLIPPAGE_BPS = 100;

/** One EMA, seeded at the first close it sees. */
interface Ema {
  span: number;
  value: number | null;
}

function stepEma(e: Ema, close: number): void {
  if (e.value === null) {
    e.value = close;
    return;
  }
  e.value += (2 / (e.span + 1)) * (close - e.value);
}

// --- Per-run state (rebuilt from the bars each run: no cross-run state) ---
const closes: number[] = []; // closes in bar order, oldest first
const fast: Ema = { span: FAST_SPAN, value: null };
const slow: Ema = { span: SLOW_SPAN, value: null };
let entryPrice: number | null = null; // effective fill price of the open position
let peakClose: number | null = null; // highest close since entry
let lastExitSeq = -1000000; // seq of the batch on which we last sent a sell
let prevHeld = false; // whether we held a position on the previous batch

/** Lowest close of the last LOOKBACK_BARS bars including the current one. */
function lowOfLookback(): number {
  let lo = Infinity;
  const start = Math.max(0, closes.length - LOOKBACK_BARS);
  for (let i = start; i < closes.length; i++) if (closes[i] < lo) lo = closes[i];
  return lo;
}

await runBars({
  onBatch(state: BarsState) {
    const bar = state.latest.get(SYMBOL);
    if (bar !== undefined) {
      const c = Number(bar.c);
      closes.push(c);
      stepEma(fast, c);
      stepEma(slow, c);
    }
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const closeBig = state.close(SYMBOL);
    if (closeBig === null) return [];
    const close = Number(closeBig);

    // A position that just filled: record its effective entry price from cost/qty.
    if (held !== undefined && !prevHeld && entryPrice === null) {
      entryPrice = Number(held.cost) * 10 ** 7 / Number(held.qty);
      peakClose = close;
    }
    prevHeld = held !== undefined;

    const orders: (SellInput | BuyInput)[] = [];
    const uptrend =
      fast.value !== null && slow.value !== null &&
      close > slow.value && fast.value > slow.value;

    if (held !== undefined) {
      if (peakClose === null || close > peakClose) peakClose = close;
      const trailBps = peakClose !== null ? ((peakClose - close) * BPS_NUM) / peakClose : 0;
      const gainBps = entryPrice !== null ? ((close - entryPrice) * BPS_NUM) / entryPrice : 0;
      if (!uptrend || trailBps >= TRAIL_BPS || gainBps >= TAKE_PROFIT_BPS) {
        orders.push({ side: "sell", symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        lastExitSeq = state.seq;
        entryPrice = null;
        peakClose = null;
      }
      return orders;
    }

    // Flat: consider an entry.
    entryPrice = null;
    peakClose = null;
    if (closes.length <= LOOKBACK_BARS) return [];
    if (state.seq - lastExitSeq < COOLDOWN_BARS + 1) return [];
    if (!uptrend) return [];
    const ret60Bps = ((close - closes[closes.length - 1 - LOOKBACK_BARS]) * BPS_NUM) / closes[closes.length - 1 - LOOKBACK_BARS];
    if (ret60Bps <= 0) return [];
    const extensionBps = ((close - lowOfLookback()) * BPS_NUM) / lowOfLookback();
    if (extensionBps > EXTENSION_CAP_BPS) return [];

    const stake = state.equity; // 100% of equity; cap is max_weight_bps = 10000
    const byWeight = (BigInt(state.hello.caps.max_weight_bps) * state.equity) / BigInt(BPS_NUM);
    let notional = stake < byWeight ? stake : byWeight;
    if (notional > state.cash) notional = state.cash;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    orders.push({ side: "buy", symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
    return orders;
  },
});
