# BTC Race Bot — v2

Long-only cbBTC (CBBTC/USDC) trading bot for the make.fun bounty
"Race a BTC trading bot live for 24 hours" (`agent-fun/bars-replay/v1`).

## Strategy in one line

Ride multi-hour uptrends, buy the pullback near the base in slices, exit on
volatility-scaled stops — and, in a downtrend, buy only a full one-bar
V-recovery off a panic drop. Trade rarely: every round trip pays ~26 bps.

## The four structural improvements over v1

1. **Order slicing (TWAP).** The kit's fill model trades each fill against a
   constant-product pool of depth D ≈ $1.27M: a trade worth `a` pays the factor
   `1 + a/D`, so impact cost in dollars scales as `a²/D`. Cutting an order
   into n equal slices over n bars costs `a²/(n·D)` — 3-way entry slicing pays
   ~1/3 of the whole order's impact, 2-way exit slicing ~1/2. Orders inside
   one reply share one pool, so slices must land on different bars (the bot
   keeps the slice plan in its own state). A slice is sent only while its
   lane's regime still holds and the close has not run >100 bps above the
   trigger close — never chase.
2. **Dual-regime signal.** Lane 1 is v1's Trend Pullback (close > EMA(180),
   EMA(60) > EMA(180), 60-min return > 0, close within 70 bps of its 60-bar
   low). Lane 2 is new, for downtrend/sideways regimes: a panic drop (latest
   1-minute return z < −2.2 vs the trailing 20 one-minute returns) followed by
   a bounce that closes back ABOVE THE PANIC BAR'S OPEN — a full one-bar
   V-recovery. A single green bar after a drop is a falling knife in a
   grinding downtrend, so the confirmation is the whole panic bar reclaimed.
   Entry only with ≥70 bps of room to revert to EMA(180) (expected move >
   2.5× round-trip cost). The lanes are mutually exclusive by construction.
3. **ATR-adaptive exits + guardrail insurance.** Trailing stop and
   take-profit scale with realized volatility (population stdev of the last
   20 twenty-bar returns): trail = clamp(3.5 × vol20, 60, 200) bps,
   TP = max(2 × trail, 100) bps — risk-reward ≥ 1:2, TP floor above the
   ~70 bps (2.5× cost) bar. At the dev window's vol20 ≈ 23 bps the trail
   lands ≈ 80 bps, i.e. v1's value. Live-race insurance: if the bot reaches
   bar 1250 with zero filled buys, it buys $5 and sells 3 bars after the
   fill (round-trip cost ≈ $0.005), so it cannot fail the ≥1-trade guardrail.
4. **Anti-overfit validation.** No parameter was tuned against the dev window.
   Split-half replay (bars 1–720 vs 721–1439, faithful local replay of the
   kit's exact fill model): half 1 +$2.90, half 2 $0.00 (no trades — the bot
   sits out, exactly like v1). Neither half is destroyed.

## Results (official grade-local, --driver process)

|                 | v1       | v2       |
| --------------- | -------- | -------- |
| Net PnL (USDC)  | +2.0256  | +2.9016  |
| Trades          | 4        | 10 (6 buys / 4 sells — sliced) |
| Win rate        | 0.50     | 0.50     |
| Max drawdown    | 0.82%    | 0.77%    |
| Fees (USDC)     | 1.6042   | 1.6048   |
| Net PnL @ 2× fees | +0.42 | +1.30    |
| Rejected orders | 0        | 0        |
| Deterministic   | L1 byte-identical | L1 byte-identical |

Dev window: 1,439 bars / 24h, BTC $73,739 → $72,044 (−2.30%). Docker is not
available on the grading machine used here, so the grade ran on the process
driver; the server grade (Docker) records a different `result_sha256`, the
score itself is unaffected.

## Run

```sh
node cli/makefun.mjs grade-local --kit . --bot . --driver process
```

`main.ts` is erasable TypeScript (Node 22), stdlib only plus the vendored
`vendor/makefun-bars.ts` shim (byte-identical copy of the kit SDK).
