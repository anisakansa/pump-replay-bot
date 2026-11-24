// Early-momentum sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Every curve is watched from its CreateEvent. A first buy is decided only on a MATURE,
// LARGE curve (real SOL 30-70, no age cap): the dev window shows small young curves bleed
// on average (-3% per 100 slots) while large survivors keep grinding up toward completion,
// the only bucket with a positive mean forward return. The tape must still be clean:
// several distinct non-creator buyers, the creator still holding (no creator sell, modest
// creator buy), buys outweighing sells, the price sitting near its early high, and fresh
// net inflow still positive. The first buy is sized up to the 1%-of-real-reserve cap; one
// add follows only while the price steps up from the last buy and the position is in
// profit, so false starts cost little and runners get size.
//
// Exits are the whole discipline: take profit at +35%, stop loss at -5%, a trailing exit
// once the peak cleared +10%, an immediate exit when the creator sells or a single large
// sell lands, a fade exit when recent net flow turns negative, and a hard time limit.
// Positions are allowed to ride into completion (the replay closes them at final
// reserves) instead of being sold early at an arbitrary reserve level.
//
// Guardrail probes keep the run above the minimum bar (round trips of >= 0.01 SOL on >= 20
// coins): when the bot's own fills or coins lag a pace set in block time, it buys a tiny
// probe of a liquid curve and sells it as soon as the buy lands.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration only over
// insertion-ordered maps fed by the batch stream, so the two graded executions produce
// byte-identical action logs. The hello message starts the run, each batch carries the
// slot's events, and the bot answers with its orders for that slot.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Youngest age (slots since CreateEvent) at which a first buy may be decided. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Real SOL reserve window at decision time. */
  minRqSol: number;
  maxRqSol: number;
  /** Distinct non-creator buyers and total buys seen before entry. */
  minBuyers: number;
  minBuys: number;
  /** Largest creator buy tolerated (SOL); a creator-heavy launch is a dump in waiting. */
  maxDevBuySol: number;
  /** Sell SOL / buy SOL at most before entry. */
  maxSellRatio: number;
  /** Price now over the create price: window. */
  minRunup: number;
  maxRunup: number;
  /** Price now at least this share of the early window's high. */
  nearHigh: number;
  /** Largest single non-creator buyer share of buy SOL. */
  maxBuyerShare: number;
  /** Recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowSol: number;
  minFlowBuys: number;
  /** First buy (SOL) and each add (SOL); most SOL per position in total. */
  firstSol: number;
  addSol: number;
  maxStakeSol: number;
  /** Adds need the price this far above the last buy's decision price, and the position up this much. */
  addStep: number;
  addIfUp: number;
  /** Most adds per position. */
  maxAdds: number;
  /** Smallest buy worth paying the tx fee for. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits. */
  takeProfit: number;
  stopLoss: number;
  trailArm: number;
  trail: number;
  /** Exit when net SOL over fadeWindow slots falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held (unless the position is up at least holdIfUp). */
  maxHold: number;
  holdIfUp: number;
  /** Exit when real SOL reaches this: completion/migration is near. */
  nearCompleteRqSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most momentum positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Guardrail pacing: targets for the run, paced over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 3,
  maxAge: 100000,
  minRqSol: 30,
  maxRqSol: 70,
  minBuyers: 3,
  minBuys: 4,
  maxDevBuySol: 3,
  maxSellRatio: 0.35,
  minRunup: 0.98,
  maxRunup: 10,
  nearHigh: 0.9,
  maxBuyerShare: 0.5,
  flowWindow: 120,
  minFlowSol: 0.5,
  minFlowBuys: 2,
  firstSol: 0.4,
  addSol: 0.2,
  maxStakeSol: 0.6,
  addStep: 0.03,
  addIfUp: 0.02,
  maxAdds: 1,
  minBuySol: 0.01,
  buySlipBps: 1500,
  takeProfit: 0.35,
  stopLoss: 0.05,
  trailArm: 0.1,
  trail: 0.1,
  fadeWindow: 30,
  fadeNetSol: 0.4,
  bigSellSol: 1.5,
  maxHold: 5000,
  holdIfUp: 0.05,
  nearCompleteRqSol: 1000,
  cooldown: 200,
  maxEntries: 2,
  maxMain: 4,
  targetCoins: 25,
  targetFills: 150,
  paceSecs: 86400,
  probeSol: 0.01,
  maxProbes: 2,
  maxExposureSol: 3,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  createPrice: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
  devBuySol: number;
  devSold: boolean;
  buySol: number;
  sellSol: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  filled: boolean;
  adds: number;
  lastAddPrice: number;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.maxAge, p.flowWindow, p.fadeWindow) + 10;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null, creator: null, createPrice: 0, trades: [], entries: 0,
        lastExit: -1e12, devBuySol: 0, devSold: false, buySol: 0, sellSol: 0,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots, plus buy count. */
  const flow = (t: Tape, now: number, w: number): { net: number; buys: number } => {
    let net = 0;
    let buys = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
      if (tr.buy) buys++;
    }
    return { net, buys };
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number, price: number): boolean => {
    if (t.created === null) return false;
    const age = now - t.created;
    if (age < p.minAge || age > p.maxAge) return false;
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.devSold || t.devBuySol > p.maxDevBuySol) return false;
    if (t.buySol < 0.01 || t.sellSol > p.maxSellRatio * t.buySol) return false;
    if (t.createPrice <= 0) return false;
    const runup = price / t.createPrice;
    if (runup < p.minRunup || runup > p.maxRunup) return false;
    let high = 0;
    let buys = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.price > high) high = tr.price;
      if (tr.buy) {
        buys++;
        if (tr.user !== t.creator) byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      }
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (high > 0 && price < high * p.nearHigh) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * t.buySol) return false;
    const f = flow(t, now, p.flowWindow);
    if (f.net < p.minFlowSol || f.buys < p.minFlowBuys) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          if (e.is_buy) {
            t.buySol += sol;
            if (e.user === t.creator) t.devBuySol += sol;
          } else {
            t.sellSol += sol;
            if (e.user === t.creator) t.devSold = true;
            if (sol >= p.bigSellSol) bigSell.add(e.mint);
          }
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const rqSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS;
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && t.devSold) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow).net < -p.fadeNetSol) exit = true;
        if (!exit && rqSol >= p.nearCompleteRqSol) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol, price)) continue;
          want = p.firstSol;
        } else {
          if (h.exiting || !h.filled || h.adds >= p.maxAdds || h.invested >= p.maxStakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS * (1 + p.addIfUp)) continue;
          if (flow(t, now, p.flowWindow).net < p.minFlowSol) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.maxStakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, adds: 0, lastAddPrice: price, lastValue: 0 });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.adds++;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
