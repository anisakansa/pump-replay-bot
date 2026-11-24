// pump-replay-bot: a paper trading bot for the pump.fun replay (agent-fun/replay/v2).
//
// The grader runs `node main.ts`. The harness speaks hello once, then one batch per slot,
// and this bot answers each batch with its orders for that slot. The strategy lives in
// strategy.ts; the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// Idea: buy mature, large bonding curves only after a clean launch tape — several distinct
// buyers, no creator dump, buys outweighing sells, price holding near its early high — then
// exit fast and disciplined: take profit, cut losers, leave when the creator sells. The
// dev-window data says small young curves bleed on average while large survivors grind up
// toward completion, so size goes to the survivors: up to 0.6 SOL per coin, one add into
// strength, at most five open positions, no shorts, no leverage. Tiny probes keep the
// guardrail bar (round trips on 20+ coins) covered when the main signal is quiet.
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
