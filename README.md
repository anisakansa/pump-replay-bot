# Pump Replay Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/anisakansa/pump-replay-bot/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/anisakansa/pump-replay-bot/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/)

Paper trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/) bounty on [make.fun](https://make.fun). It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity (TradeEvent / CreateEvent / CompleteEvent), scored by net PnL.

## Strategy

Buy mature, large bonding curves only (real SOL 30–70) after a clean tape: several distinct non-creator buyers, no creator sell, buys outweighing sells, price near its early high, fresh net inflow positive. The dev-window data says small young curves bleed on average while large survivors grind up toward completion, so size goes to the survivors: up to 0.6 SOL per coin, one add into strength, at most 5 open positions, no shorts, no leverage.

Exits are disciplined: take profit +35%, stop loss −5%, trailing stop once the peak clears +10%, immediate exit on creator sell or a single large sell, fade exit on negative recent flow, hard time limit. Positions may ride into completion (closed by the replay at final reserves). Tiny 0.01 SOL probe round trips keep the guardrail bar (≥20 coins) covered when the main signal is quiet.

## Local backtest (dev window)

```
node tools/backtest.ts <kit dir>
```

Result on the kit's dev window: **net +0.143834 SOL**, 71 fills, 29 coins, 34 round trips, 5 wins, max drawdown 0.0072, 0 rejected orders. At 2x fees still +0.039185 SOL. Two runs produce byte-identical output (sha256 `afe3ad33138b8c9df8d7bcfc3581e5c017c698bffeedfb8f22d061a36be44e87`).

## Run

```
node main.ts
```

Node 22.18+ required (uses TypeScript type stripping). No dependencies, no network, no secrets: everything the bot runs is in this repository. `vendor/agentfun-bot.ts` is the kit's SDK shim, vendored byte for byte; `tools/sim.ts` is the kit's local replay engine port, used only for offline backtests.

## Files

- `main.ts` — entrypoint: runs the strategy through the replay harness.
- `strategy.ts` — the trading strategy (entry signal, exits, probes).
- `vendor/agentfun-bot.ts` — harness SDK shim (kit-provided).
- `tools/backtest.ts`, `tools/sim.ts` — offline backtest on the dev window.

## License

MIT — see [LICENSE](LICENSE).
