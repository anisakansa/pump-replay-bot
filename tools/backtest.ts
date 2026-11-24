// Offline backtest of strategy.ts on the kit's dev window with the local engine port.
//   node tools/backtest.ts <kit dir> ['{"takeProfit":0.2}'] [--trips]
// Prints net PnL, fills, coins, drawdown, reject reasons, a guardrail verdict,
// and the strategy's decision journal summary (which rule fired how often).
// Exits non-zero when the guardrail verdict fails, so a bad rewrite cannot
// pass silently. --trips lists every round trip.

import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/backtest.ts <kit dir> [params json] [--trips]');
  process.exit(2);
}
const overrides = process.argv[3] !== undefined && process.argv[3].startsWith('{') ? (JSON.parse(process.argv[3]) as Partial<Params>) : {};
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('pump-replay-bot', 'dev', ds.sha256));
const params = { ...DEFAULT_PARAMS, ...overrides };
const bot = createStrategy(params);
const r = simulate(ds, hello, bot);
const sol = (x: bigint) => (Number(x) / 1e9).toFixed(6);
const wins = r.trips.filter((t) => t.pnl > 0n).length;
console.log(`net ${sol(r.netPnl)} SOL  fills ${r.fills}  coins ${r.mints}  trips ${r.trips.length}  wins ${wins}  dd ${r.maxDrawdown.toFixed(4)}  rejected ${r.rejected} ${JSON.stringify(r.rejectReasons)}  failed ${r.failed}`);
const noFail = simulate(ds, hello, createStrategy(params), { failKey: null });
const twoX = simulate(ds, hello, createStrategy(params), { feeMultiplier: 2n });
console.log(`without failed txs ${sol(noFail.netPnl)}  at 2x fees ${sol(twoX.netPnl)}`);

// The prize needs net PnL above zero; the harness needs round trips of
// >= 0.01 SOL on >= 20 coins and max drawdown <= 50%.
const verdict: string[] = [];
if (!(r.netPnl > 0n)) verdict.push('net PnL is not positive');
if (r.mints < 20) verdict.push(`only ${r.mints} coins, need >= 20`);
if (r.maxDrawdown > 0.5) verdict.push(`drawdown ${r.maxDrawdown.toFixed(4)} exceeds 0.50`);
console.log(`verdict: ${verdict.length === 0 ? 'PASS' : `FAIL (${verdict.join('; ')})`}`);

// Which rules actually fired? The journal is the strategy's own record of
// every order it placed, with the reason each exit was chosen.
const summary = bot.summarizeDecisions();
const kinds = Object.keys(summary).sort();
console.log(`decisions: ${kinds.map((k) => `${k} ${summary[k]}`).join(', ')}`);

if (process.argv.includes('--trips')) {
  for (const t of r.trips) console.log(t.mint, t.open, t.close - t.open, sol(t.pnl));
}
if (verdict.length > 0) process.exit(1);
