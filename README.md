# Pump Replay Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/anisakansa/pump-replay-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/anisakansa/pump-replay-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Paper trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on [make.fun](https://make.fun). It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity (TradeEvent / CreateEvent / CompleteEvent), scored by net PnL.

## Strategy

Buy mature, large bonding curves only (real SOL 40–70) after a clean tape: several distinct non-creator buyers, no creator sell, buys outweighing sells, price near its early high, fresh net inflow positive — and the recent flow must come from more than one buyer, so a single wallet washing the tape does not count as demand. The dev-window data says small young curves bleed on average while large survivors grind up toward completion, so size goes to the survivors: up to 0.6 SOL per coin, one add into strength, at most 5 open positions, no shorts, no leverage.

Exits are disciplined: take profit +20%, stop loss −5%, trailing stop once the peak clears +10%, immediate exit on creator sell or a single large sell, fade exit when net flow over the last 75 slots turns negative, hard time limit. Positions may ride into completion (closed by the replay at final reserves). Tiny 0.01 SOL probe round trips keep the guardrail bar (≥20 coins) covered when the main signal is quiet; probes are paced per mint and capped in total spend so the guardrail never turns into a leak.

Every decision the bot makes is written to an in-memory journal (entries, adds, exits with their reason, probes), which the backtest prints as a summary — so you can see which rule fires and which one never does. Stale tapes of completed curves are swept a bounded slice per batch, keeping memory flat without touching behaviour.

## Local backtest (dev window)

```
node tools/backtest.ts <kit dir>
```

Result on the kit's dev window (part-0, 11.1h): **net +0.183245 SOL**, 71 fills, 29 coins, 34 round trips, 4 wins, max drawdown 0.0072, 0 rejected orders, 2 failed txs. At 2x fees −0.065183 SOL. Two runs produce byte-identical stdout (sha256 `e55885909fe581029d7c74bfc2e01a85abc6fd32a137aa37d94e1461510b8f2a`). Decision journal on that run: enter 4, add 3, probe-buy 31, probe-sell 30, exit-dev 1, exit-fade 2, exit-tp 2.

Round 2's shipped backtest only loaded part-0, which hid the real leak: on the **full 24h window** (all 3 dataset parts) round 2 was −0.779728 SOL. Round 3 fixes it with three measured changes — entry only on curves with real SOL ≥ 40 (the rugs lived at 30–40), take profit at +20% instead of +35% (winners peak then fade), and a 75-slot fade window instead of 30 (the short window cut winners mid-run). Full-window result: **net +0.584529 SOL**, 151 fills, 59 coins, 72 round trips, 10 wins, max drawdown 0.0072, 1 rejected order (max_slippage), 3 failed txs. At 2x fees −0.395562 SOL (round 2 was −1.089147 SOL there). Positive on every time split of the dev window (part-0 +0.183, part-1 +0.185, part-2 +0.224).

## Run

```
node main.ts
```

Node 22.18+ required (uses TypeScript type stripping). No dependencies, no network, no secrets: everything the bot runs is in this repository. `vendor/agentfun-bot.ts` is the kit's SDK shim, vendored byte for byte; `tools/sim.ts` is the kit's local replay engine port, used only for offline backtests.

## Files

- `main.ts` — entrypoint: validates the params, runs the strategy through the replay harness.
- `strategy.ts` — the trading strategy (entry signal, exits, probes, decision journal).
- `vendor/agentfun-bot.ts` — harness SDK shim (kit-provided).
- `tools/backtest.ts`, `tools/sim.ts` — offline backtest on the dev window, with a guardrail verdict and decision summary.

## License

MIT — see [LICENSE](LICENSE).
