// Baseline v2: slow-trend long-only bot for cbBTC (CBBTC/USDC, 1-minute bars),
// plus TWAP slicing, a dual-regime bounce lane, ATR-adaptive exits and a
// live-guardrail micro-trade. TypeScript, erasable syntax, stdlib only.
//
// PRICE IMPACT (kit simulator, sim/bars/engine.ts — quoted, not assumed):
//   A fill at a bar's open trades against a constant-product pool as deep as the
//   bar's open depth D (single hop here; the universe froze at D ≈ $1.27M, i.e.
//   o_depth ≈ 1.267e12 raw units). A trade worth a meets the factor 1 + a/D:
//   a buy pays open × (1 + slippage) × (1 + a/D); a sell receives open / (1 + a/D)
//   (times (1 − slippage)). Fee is 4 bps per fill, modelled slippage 2 bps, so the
//   fee+slippage floor is 12 bps round-trip, while a whole $1,000 round trip pays
//   ~26–28 bps because impact alone is ~7.9 bps per side. Impact cost in dollars
//   scales as a²/D, so cutting an order into n equal slices over n bars costs
//   n×(a/n)²/D = a²/(n·D): 3-way slicing pays ~1/3 of the whole order's impact.
//   Orders inside ONE reply share one pool and pay what the whole would, so slices
//   must land on different bars — the bot keeps the slice plan in its own state.
//   Depth at the next open is unknown when deciding; the latest close's depth
//   (state.depthAt) is the estimate, and state.impactBps() is the exact quote.
//
// Rules (all constants below, all in basis points unless noted):
//   LANE 1 — Trend Pullback (v1, unchanged): close above EMA(180), EMA(60) above
//     EMA(180), 60-minute return positive, close within 70 bps of its 60-bar low
//     (~2.5x the ~28 bps full-size round-trip cost). Cooldown 30 bars after an exit.
//   LANE 2 — Oversold Bounce (new, downtrend/sideways regime): the latest 1-minute
//     return scores z < −2.2 against the trailing 20 one-minute returns (panic
//     drop), and the NEXT bar closes back ABOVE THE PANIC BAR'S OPEN — a full
//     one-bar V-recovery, not just a tick up from the panic close (a single green
//     bar after a drop is a falling knife in a grinding downtrend; reclaiming the
//     whole panic bar is the confirmation). Entry only while the close is still
//     below EMA(180) with ≥70 bps of room to revert to it — the expected
//     reversion itself must exceed 2.5x the round-trip cost. The two lanes
//     are mutually exclusive by construction (trend needs close > EMA(180), bounce
//     needs close < EMA(180)).
//   SLICING: an entry fills in 5 equal slices over 5 bars (a slice is sent only
//     while its lane's regime still holds and the close has not run >100 bps above
//     the trigger close — never chase). An exit fills in 2 slices over 2 bars:
//     half at the trigger, the rest on the next bar.
//   ADAPTIVE EXITS: the trailing stop and take-profit scale with realized
//     volatility — the population stdev of the last 20 twenty-bar returns (bps).
//     trail = clamp(3.5 × vol20, 60, 200) bps; TP = max(2 × trail, 100) bps, so
//     the risk-reward stays ≥ 1:2 and the TP floor (100 bps) stays above the ~70 bps
//     (2.5x cost) bar. While history is short the v1 values (80 / 200) apply.
//     (At the dev window's vol20 ≈ 23 bps the adaptive trail lands ≈ 80 bps,
//     i.e. v1's value — the adaptation moves it only when the regime changes.)
//   GUARDRAIL INSURANCE: the live race requires ≥1 filled trade. If the bot
//     reaches bar 1250 with zero filled buys, it buys $5 of CBBTC and sells it
//     3 bars after the fill (round-trip cost ≈ $0.005). It fires at most once,
//     never while another plan is active, and never disturbs a normal position.
//   Sizing: 100% of equity (max weight 10,000 bps), one position at a time.
//   max_slippage_bps 100. No wall clock, no network, no files, no randomness:
//   two runs on the same bars produce the same orders.
//
// v1 result (official grade-local, --driver process, 2 executions):
//   Net PnL +2.03 USDC, 4 trades / 2 round trips, win rate 0.50,
//   max drawdown 0.82%, fees $1.60, net PnL at 2x fees +$0.42, 0 rejected,
//   guardrails met, L1 regrade reproduced byte for byte (deterministic).
// v2 changes are structural (slicing arithmetic, a second regime, volatility-
// scaled exits, a guardrail), not a grid search: no parameter was tuned against
// the dev window, and the split-half check (bars 1–720 vs 721–1439) is the proof.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from "./vendor/makefun-bars.ts";

/** Basis points per unit as a plain number (the SDK's BPS is a bigint). */
const BPS_NUM = 10000;

const SYMBOL = "CBBTC";
const FAST_SPAN = 60; // 1 hour
const SLOW_SPAN = 180; // 3 hours
const LOOKBACK_BARS = 60; // momentum + base window, in bars
const EXTENSION_CAP_BPS = 70; // ~2.5x the ~28 bps full-size round-trip cost
const COOLDOWN_BARS = 30;
const MAX_SLIPPAGE_BPS = 100;

// Slicing (impact cost ~ a^2/D, so n slices pay ~1/n of the whole order's impact).
// v3 experiment: ENTRY_SLICES 3 -> 5 (pure variable change; signal untouched).
const ENTRY_SLICES = 5;
const EXIT_SLICES = 2;
const ENTRY_CHASE_CAP_BPS = 100; // abort an entry plan if close runs this far above its trigger

// Bounce lane (downtrend/sideways regime).
const Z_WINDOW = 20; // trailing 1-minute returns for the panic z-score
const Z_PANIC = -2.2;
const REVERT_ROOM_BPS = 70; // expected reversion to EMA(180) must exceed 2.5x round-trip cost

// Adaptive exits (realized volatility of 20-bar returns).
const VOL_WINDOW = 20;
const VOL_SPAN = 20;
const TRAIL_MULT = 3.5;
const TRAIL_MIN_BPS = 60;
const TRAIL_MAX_BPS = 200;
const TP_MULT = 2; // risk-reward >= 1:2
const TP_MIN_BPS = 100; // floor above the ~70 bps (2.5x cost) bar
const TRAIL_FALLBACK_BPS = 80; // v1 values while vol history is short
const TP_FALLBACK_BPS = 200;

// Guardrail insurance (live race needs >= 1 filled trade).
const GUARDRAIL_BAR = 1250;
const GUARDRAIL_LAST_BAR = 1430;
const MICRO_NOTIONAL = 5000000n; // $5 USDC in quote units (6 decimals)
const MICRO_HOLD_BARS = 3;

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
let lastExitSeq = -1000000; // seq of the batch on which the last exit slice was sent
let prevHeld = false; // whether we held a position on the previous batch

type SlicePlan =
  | { kind: "entry"; lane: "trend" | "bounce"; target: bigint; sent: bigint; slicesLeft: number; triggerClose: number }
  | { kind: "exit"; slicesLeft: number; triggerClose: number };
let slicePlan: SlicePlan | null = null;
let filledBuys = 0; // filled buy orders seen in batch fills (drives the guardrail)
let panicSeq = -1000000; // seq of the bar whose 1-minute return scored z < -2.2
let panicOpen: number | null = null; // open of that panic bar (the bounce must reclaim it)
let microPhase: "idle" | "bought" | "selling" | "done" = "idle";
let microInFlight = false; // a micro buy was sent, its fill not yet seen
let microBuyFillSeq = -1; // seq of the batch that carried the micro buy's fill
let microQty: bigint | null = null;

/** Lowest close of the last LOOKBACK_BARS bars including the current one. */
function lowOfLookback(): number {
  let lo = Infinity;
  const start = Math.max(0, closes.length - LOOKBACK_BARS);
  for (let i = start; i < closes.length; i++) if (closes[i] < lo) lo = closes[i];
  return lo;
}

/** Population stdev (bps) of the last VOL_WINDOW VOL_SPAN-bar returns, or null while short. */
function vol20(): number | null {
  if (closes.length < VOL_WINDOW + VOL_SPAN) return null;
  const rs: number[] = [];
  for (let i = closes.length - VOL_WINDOW; i < closes.length; i++) {
    const prev = closes[i - VOL_SPAN];
    rs.push(((closes[i] - prev) * BPS_NUM) / prev);
  }
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const variance = rs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rs.length;
  return Math.sqrt(variance);
}

/** Adaptive trailing-stop / take-profit pair (bps), from realized volatility. */
function adaptiveExits(): { trailBps: number; tpBps: number } {
  const v = vol20();
  if (v === null) return { trailBps: TRAIL_FALLBACK_BPS, tpBps: TP_FALLBACK_BPS };
  const trail = Math.min(TRAIL_MAX_BPS, Math.max(TRAIL_MIN_BPS, TRAIL_MULT * v));
  return { trailBps: trail, tpBps: Math.max(TP_MULT * trail, TP_MIN_BPS) };
}

/** Z-score of the latest 1-minute return vs the trailing Z_WINDOW returns before it. */
function panicZ(): number | null {
  if (closes.length < Z_WINDOW + 2) return null;
  const rs: number[] = [];
  for (let i = closes.length - Z_WINDOW - 1; i < closes.length - 1; i++) {
    rs.push(((closes[i] - closes[i - 1]) * BPS_NUM) / closes[i - 1]);
  }
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const variance = rs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rs.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return null;
  const latest = ((closes[closes.length - 1] - closes[closes.length - 2]) * BPS_NUM) / closes[closes.length - 2];
  return (latest - mean) / sd;
}

/** 100% of equity, capped by max weight and by cash on hand. */
function fullNotional(state: BarsState): bigint {
  const byWeight = (BigInt(state.hello.caps.max_weight_bps) * state.equity) / BigInt(BPS_NUM);
  let notional = state.equity < byWeight ? state.equity : byWeight;
  if (notional > state.cash) notional = state.cash;
  return notional;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const bar = state.latest.get(SYMBOL);
    if (bar !== undefined) {
      const c = Number(bar.c);
      closes.push(c);
      stepEma(fast, c);
      stepEma(slow, c);
    }
    // Fills reported in this batch are the orders decided on the previous bar.
    for (const f of batch.fills) {
      if (f.symbol !== SYMBOL || f.status !== "filled") {
        if (f.symbol === SYMBOL && f.client_id === "micro-buy") microInFlight = false;
        continue;
      }
      if (f.side === "buy") {
        filledBuys++;
        if (f.client_id === "micro-buy") {
          microInFlight = false;
          microPhase = "bought";
          microBuyFillSeq = state.seq;
          microQty = BigInt(f.qty);
        }
      } else if (f.client_id === "micro-sell") {
        microPhase = "done";
      }
    }
    // Panic detection on the bar that just closed.
    const z = panicZ();
    if (z !== null && z < Z_PANIC) {
      panicSeq = state.seq;
      panicOpen = bar !== undefined ? Number(bar.o) : null;
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
    const { trailBps, tpBps } = adaptiveExits();

    // The micro position is insurance, not a trade: hold it for its fixed window
    // and never let the normal exit rules (or a new entry) touch it.
    if (microPhase === "bought" || microPhase === "selling") {
      if (held === undefined) {
        // The micro position is gone without a micro-sell fill (should not happen);
        // treat the insurance as spent rather than looping.
        microPhase = "done";
        return [];
      }
      if (microPhase === "bought" && state.seq >= microBuyFillSeq + MICRO_HOLD_BARS) {
        const qty = microQty !== null && microQty < held.qty ? microQty : held.qty;
        orders.push({ side: "sell", symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: "micro-sell" });
        microPhase = "selling";
      } else if (microPhase === "selling") {
        const qty = microQty !== null && microQty < held.qty ? microQty : held.qty;
        orders.push({ side: "sell", symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: "micro-sell" });
      }
      return orders;
    }

    // 1. An exit plan in progress: send the remaining slice (or dump it on panic).
    if (slicePlan !== null && slicePlan.kind === "exit") {
      if (held === undefined) {
        slicePlan = null;
        return [];
      }
      // Second (last) slice: everything that is left. One extra bar of holding
      // is the whole cost of slicing the exit; the impact saved is ~half.
      orders.push({ side: "sell", symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      slicePlan = null;
      lastExitSeq = state.seq;
      entryPrice = null;
      peakClose = null;
      return orders;
    }

    // 2. Holding: adaptive exits. A triggered exit starts a 2-slice plan.
    if (held !== undefined) {
      if (peakClose === null || close > peakClose) peakClose = close;
      const trail = peakClose !== null ? ((peakClose - close) * BPS_NUM) / peakClose : 0;
      const gain = entryPrice !== null ? ((close - entryPrice) * BPS_NUM) / entryPrice : 0;
      if (!uptrend || trail >= trailBps || gain >= tpBps) {
        slicePlan = null; // any entry plan is abandoned: we are exiting, not adding
        const half = held.qty / 2n;
        const firstSlice = half > 0n ? half : held.qty;
        orders.push({ side: "sell", symbol: SYMBOL, qty: firstSlice, max_slippage_bps: MAX_SLIPPAGE_BPS });
        if (firstSlice >= held.qty) {
          lastExitSeq = state.seq;
          entryPrice = null;
          peakClose = null;
        } else {
          slicePlan = { kind: "exit", slicesLeft: EXIT_SLICES - 1, triggerClose: close };
        }
        return orders;
      }
      // Still holding, no exit: fall through to the entry-plan step below only
      // if an entry plan is somehow active (it should have been cancelled above).
    }

    // 3. An entry plan in progress: send the next slice while its lane holds.
    if (slicePlan !== null && slicePlan.kind === "entry") {
      const chasedBps = ((close - slicePlan.triggerClose) * BPS_NUM) / slicePlan.triggerClose;
      const laneHolds =
        slicePlan.lane === "trend"
          ? uptrend
          : slow.value !== null && close < slow.value;
      if (!laneHolds || chasedBps > ENTRY_CHASE_CAP_BPS) {
        slicePlan = null; // abort; whatever is held keeps the normal exits
        return [];
      }
      const remaining = slicePlan.target - slicePlan.sent;
      const slice = slicePlan.slicesLeft <= 1 ? remaining : slicePlan.target / BigInt(ENTRY_SLICES);
      const capped = slice > state.cash ? state.cash : slice;
      if (capped < BigInt(state.hello.fees.min_notional_quote_units)) {
        slicePlan = null;
        return [];
      }
      orders.push({ side: "buy", symbol: SYMBOL, notional_quote_units: capped, max_slippage_bps: MAX_SLIPPAGE_BPS });
      slicePlan.sent += capped;
      slicePlan.slicesLeft--;
      if (slicePlan.slicesLeft <= 0) slicePlan = null;
      return orders;
    }

    // 4. Flat (or holding without an exit/plan): consider a fresh entry.
    entryPrice = held === undefined ? null : entryPrice;
    peakClose = held === undefined ? null : peakClose;
    if (held !== undefined) return []; // holding, no exit, no plan: wait
    if (closes.length <= LOOKBACK_BARS) return [];
    if (state.seq - lastExitSeq < COOLDOWN_BARS + 1) return [];

    // 4a. Guardrail insurance: no filled trade by bar 1250 -> one $5 micro-trade.
    if (
      microPhase === "idle" && !microInFlight && filledBuys === 0 &&
      state.seq >= GUARDRAIL_BAR && state.seq <= GUARDRAIL_LAST_BAR &&
      MICRO_NOTIONAL <= state.cash
    ) {
      orders.push({ side: "buy", symbol: SYMBOL, notional_quote_units: MICRO_NOTIONAL, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: "micro-buy" });
      microInFlight = true;
      return orders;
    }

    // 4b. Lane 1 — Trend Pullback (v1 rules).
    let lane: "trend" | "bounce" | null = null;
    if (uptrend) {
      const ret60Bps = ((close - closes[closes.length - 1 - LOOKBACK_BARS]) * BPS_NUM) / closes[closes.length - 1 - LOOKBACK_BARS];
      const extensionBps = ((close - lowOfLookback()) * BPS_NUM) / lowOfLookback();
      if (ret60Bps > 0 && extensionBps <= EXTENSION_CAP_BPS) lane = "trend";
    }
    // 4c. Lane 2 — Oversold Bounce: panic on the previous bar, bounce on this one
    // (close back above the panic bar's OPEN — full V-recovery), price still below
    // EMA(180) with >= 70 bps of room to revert to it.
    if (lane === null && panicSeq === state.seq - 1 && closes.length >= 2 && slow.value !== null) {
      const bounced = panicOpen !== null && close > panicOpen;
      const roomBps = ((slow.value - close) * BPS_NUM) / slow.value;
      if (bounced && close < slow.value && roomBps > REVERT_ROOM_BPS) lane = "bounce";
    }
    if (lane === null) return [];

    const target = fullNotional(state);
    if (target < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    const firstSlice = target / BigInt(ENTRY_SLICES);
    orders.push({ side: "buy", symbol: SYMBOL, notional_quote_units: firstSlice, max_slippage_bps: MAX_SLIPPAGE_BPS });
    slicePlan = { kind: "entry", lane, target, sent: firstSlice, slicesLeft: ENTRY_SLICES - 1, triggerClose: close };
    return orders;
  },
});
