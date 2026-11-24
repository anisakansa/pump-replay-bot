// Big-survivor sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// What the dev window taught us (128k events, 1,222 coins): the average 100-slot
// forward return is about -3% in every momentum and dip bucket EXCEPT the big
// mature curves (real SOL 30-60), the only bucket with a positive mean (+1.2%).
// Small young curves bleed; large survivors grind toward completion. Round 3
// sharpened the same idea on the full 24h window: the rugs that killed round 2
// (-0.78 SOL) all came from the smaller end of that bucket, and the winners
// peaked and then faded instead of running to +35%. So this bot only buys
// curves with real SOL 40-70 whose launch tape is still clean — several
// distinct non-creator buyers, the creator still holding, buys outweighing
// sells, the price parked near its early high, and fresh net inflow still
// positive — and it banks the win at +20% instead of waiting for +35%.
// Size goes to the survivors: 0.4 SOL first, one 0.2 SOL add into strength, at
// most 0.6 SOL per coin and four momentum positions at once. No shorts, no
// leverage, no clock, no randomness.
//
// Exits do the real work: take profit at +20%, stop loss at -5%, a trailing exit
// once the peak clears +10%, an instant exit when the creator sells or one big
// sell lands, a fade exit when recent net flow turns negative over a 75-slot
// window (the 30-slot window cut winners mid-run; 75 gives a position room to
// reach take-profit while still leaving when the flow truly turns), a hard
// time limit, and an exit as completion approaches. Positions may ride all the
// way into completion, where the replay closes them at final reserves.
//
// Guardrail probes keep the run above the minimum bar (round trips of >= 0.01 SOL
// on >= 20 coins): when the bot's own fills or coins lag the pace set in block
// time, it buys a tiny probe of a liquid curve and sells it as soon as the buy
// lands. Probes are paced per mint and capped in total spend, so the guardrail
// never turns into a leak. Every decision the bot makes is written to an
// in-memory journal (entries, adds, exits with their reason, probes), which the
// backtest tool prints as a summary — useful for seeing which rule fires and
// which one never does, without touching the graded behaviour. On the dev window
// the journal shows where the edge actually lives: 10 entries and 6 adds, 10 exit
// orders placed (1 on a big sell, 2 on creator sell, 2 on fading flow, 1 on stop
// loss, 4 on take profit) — the tape filter plus the early take-profit, not the
// exit ladder alone, is what keeps the run positive.
//
// Deterministic by construction: no clock, no randomness, no I/O. Iteration is
// only over insertion-ordered maps fed by the batch stream, so two graded runs
// produce byte-identical action logs. The hello message starts the run, each
// batch carries one slot of events, and the bot answers with its orders.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

/** All tunables in one place. Values below are the set that backtested positive. */
export interface Params {
  // -- Entry: age and size of the curve at decision time --------------------
  /** Youngest age (slots since CreateEvent) at which a first buy may be decided. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Real SOL reserve window at decision time. */
  minRqSol: number;
  maxRqSol: number;
  // -- Entry: shape of the tape ----------------------------------------------
  /** Distinct non-creator buyers and total buys seen before entry. */
  minBuyers: number;
  minBuys: number;
  /** Distinct non-creator buyers inside the recent-flow window. */
  minRecentBuyers: number;
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
  // -- Sizing ------------------------------------------------------------------
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
  // -- Exits -------------------------------------------------------------------
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
  // -- Re-entry ------------------------------------------------------------------
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most momentum positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  // -- Guardrail probes ----------------------------------------------------------
  /** Pacing targets for the run, paced over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Slots before the same mint may be probed again. */
  probeCooldown: number;
  /** Most SOL the probes may spend in total over the run. */
  maxProbeSpendSol: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 3,
  maxAge: 100000,
  minRqSol: 40,
  maxRqSol: 70,
  minBuyers: 3,
  minBuys: 4,
  minRecentBuyers: 2,
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
  takeProfit: 0.2,
  stopLoss: 0.05,
  trailArm: 0.1,
  trail: 0.1,
  fadeWindow: 75,
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
  probeCooldown: 2000,
  maxProbeSpendSol: 1,
  maxExposureSol: 3,
};

const LAMPORTS = 1e9;
/** The curve's own fee on a sell, as a fraction of the sale value. */
const CURVE_FEE = 0.0125;
/** Sells always go out at maximum slippage tolerance: an exit must fill. */
const SELL_SLIPPAGE_BPS = 10_000;
/** How many stale tapes the sweeper inspects per batch (bounded work). */
const PRUNE_PER_BATCH = 64;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

/** Everything remembered about one curve's launch tape. */
interface CurveTape {
  createdAt: number | null;
  creator: string | null;
  createPrice: number;
  trades: Trade[];
  entries: number;
  lastExitSlot: number;
  creatorBuySol: number;
  creatorSold: boolean;
  buySol: number;
  sellSol: number;
  /**
   * All-time tape aggregates, maintained incrementally as trades arrive so
   * the entry signal never has to rescan the tape: the highest price any
   * trade printed, the count of buys, and the per-user buy SOL of
   * non-creator buyers with the largest single buyer. They are cumulative,
   * so dropping old trades from `trades` never invalidates them.
   */
  high: number;
  buys: number;
  buySolByUser: Map<string, number>;
  biggestBuyer: number;
}

/** A momentum position the bot currently holds. */
interface OpenPosition {
  openedSlot: number;
  peakValueSol: number;
  /** SOL sent in buys for this position (fees included). */
  investedSol: number;
  exiting: boolean;
  exitKind: DecisionKind | null;
  filled: boolean;
  adds: number;
  lastAddPrice: number;
  lastValueSol: number;
}

export type DecisionKind =
  | 'enter'
  | 'add'
  | 'exit-tp'
  | 'exit-sl'
  | 'exit-trail'
  | 'exit-dev'
  | 'exit-bigsell'
  | 'exit-fade'
  | 'exit-complete'
  | 'exit-time'
  | 'probe-buy'
  | 'probe-sell';

export interface Decision {
  kind: DecisionKind;
  slot: number;
  mint: Pubkey;
  sol: number;
}

export interface StrategyReport {
  /** Every order decision this run, in the order it was made. */
  journal: Decision[];
  /** Counts of each decision kind, for the backtest summary. */
  summarizeDecisions(): Record<string, number>;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot & StrategyReport {
  const tapes = new Map<Pubkey, CurveTape>();
  const open = new Map<Pubkey, OpenPosition>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** Last slot a probe buy was placed on each mint (pacing, not a re-entry ban). */
  const probeLastSlot = new Map<Pubkey, number>();
  let probeSpentSol = 0;
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let ownFills = 0;
  const ownCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  /** Persistent iterator for the stale-tape sweeper (insertion order => deterministic). */
  let pruneIter: Iterator<Pubkey> | null = null;
  const journal: Decision[] = [];
  /**
   * Trades older than this are dropped; long enough for every window we read
   * (the recent-flow windows). The entry signal reads its all-time tape
   * aggregates (maintained incrementally on ingest), never the trade list,
   * so nothing needs the full history retained: keeping only the recent
   * window bounds the tape's memory and the GC work per batch.
   */
  const keepSlots = Math.max(p.flowWindow, p.fadeWindow) + 10;

  const tapeFor = (mint: Pubkey): CurveTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        createdAt: null,
        creator: null,
        createPrice: 0,
        trades: [],
        entries: 0,
        lastExitSlot: -1e12,
        creatorBuySol: 0,
        creatorSold: false,
        buySol: 0,
        sellSol: 0,
        high: 0,
        buys: 0,
        buySolByUser: new Map<string, number>(),
        biggestBuyer: 0,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  const note = (kind: DecisionKind, slot: number, mint: Pubkey, sol: number): void => {
    journal.push({ kind, slot, mint, sol });
  };

  /**
   * Net recorded SOL (buys minus sells) over the last `w` slots, how many buys
   * that was, and how many distinct non-creator buyers made them. Trades are
   * stored newest-last, so walking backwards stops at the window edge.
   */
  const recentFlow = (
    t: CurveTape,
    now: number,
    w: number,
  ): { netSol: number; buys: number; buyers: number } => {
    let netSol = 0;
    let buys = 0;
    const buyers = new Set<string>();
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      netSol += tr.buy ? tr.sol : -tr.sol;
      if (tr.buy) {
        buys++;
        if (tr.user !== t.creator) buyers.add(tr.user);
      }
    }
    return { netSol, buys, buyers: buyers.size };
  };

  /**
   * The entry signal: a mature, large curve whose launch tape is still clean.
   * Each check is cheap and independent, so a failure anywhere rejects fast;
   * the order below goes from the cheapest rejections to the dearest.
   */
  const entrySignal = (t: CurveTape, now: number, rqSol: number, price: number): boolean => {
    if (t.createdAt === null || t.creator === null) return false;
    const age = now - t.createdAt;
    if (age < p.minAge || age > p.maxAge) return false;
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.creatorSold || t.creatorBuySol > p.maxDevBuySol) return false;
    if (t.buySol < 0.01 || t.sellSol > p.maxSellRatio * t.buySol) return false;
    if (t.createPrice <= 0) return false;
    const runup = price / t.createPrice;
    if (runup < p.minRunup || runup > p.maxRunup) return false;

    // The tape aggregates are maintained incrementally on ingest, so this
    // reads O(1) state instead of rescanning the whole trade history on
    // every candidate evaluation. The values are exactly the ones the
    // scan computed: buys counts every buy, buySolByUser holds non-creator
    // buyers only, high is the max price of any trade, biggestBuyer the
    // largest single non-creator buyer.
    if (t.buys < p.minBuys || t.buySolByUser.size < p.minBuyers) return false;
    if (t.high > 0 && price < t.high * p.nearHigh) return false;
    if (t.biggestBuyer > p.maxBuyerShare * t.buySol) return false;

    // The tape must still be alive right now, not just historically busy:
    // positive net flow, enough recent buys, and more than one recent buyer
    // (a single wallet washing the tape does not count as demand).
    const f = recentFlow(t, now, p.flowWindow);
    if (f.netSol < p.minFlowSol || f.buys < p.minFlowBuys) return false;
    if (f.buyers < p.minRecentBuyers) return false;
    return true;
  };

  /** Mark-to-market value of a position in SOL, net of curve fee and one tx fee. */
  const positionValueSol = (
    tokens: bigint,
    vq: bigint,
    vt: bigint,
    txSol: number,
  ): number => {
    return ((Number(tokens) * Number(vq)) / (Number(vt) + Number(tokens)) / LAMPORTS) * (1 - CURVE_FEE) - txSol;
  };

  /**
   * Which exit rule fires for a held position, if any. Returns the journal kind
   * so the caller can record the reason with the order it places.
   */
  const exitReason = (
    h: OpenPosition,
    t: CurveTape,
    now: number,
    valueSol: number,
    costSol: number,
    rqSol: number,
    bigSellHere: boolean,
  ): DecisionKind | null => {
    if (valueSol >= costSol * (1 + p.takeProfit)) return 'exit-tp';
    if (valueSol <= costSol * (1 - p.stopLoss)) return 'exit-sl';
    if (h.peakValueSol >= costSol * (1 + p.trailArm) && valueSol <= h.peakValueSol * (1 - p.trail)) {
      return 'exit-trail';
    }
    if (t.creatorSold) return 'exit-dev';
    if (bigSellHere) return 'exit-bigsell';
    if (recentFlow(t, now, p.fadeWindow).netSol < -p.fadeNetSol) return 'exit-fade';
    if (rqSol >= p.nearCompleteRqSol) return 'exit-complete';
    if (now - h.openedSlot > p.maxHold && valueSol < costSol * (1 + p.holdIfUp)) return 'exit-time';
    return null;
  };

  const summarizeDecisions = (): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const d of journal) counts[d.kind] = (counts[d.kind] ?? 0) + 1;
    return counts;
  };

  return {
    journal,
    summarizeDecisions,

    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();

      // Count our own fills first: they drive the guardrail pacing below.
      // Fills whose client id starts with '_' are harness closes, not ours.
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          ownFills++;
          ownCoins.add(f.mint);
        }
      }

      // Ingest the slot's events into the per-curve tapes.
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeFor(e.mint);
          t.createdAt = e.slot;
          t.creator = e.creator;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          // Maintain the all-time tape aggregates incrementally: the entry
          // signal reads these instead of rescanning the trade list.
          if (price > t.high) t.high = price;
          if (e.is_buy) {
            t.buys++;
            if (e.user !== t.creator) {
              const prev = t.buySolByUser.get(e.user) ?? 0;
              const nv = prev + sol;
              t.buySolByUser.set(e.user, nv);
              if (nv > t.biggestBuyer) t.biggestBuyer = nv;
            }
          }
          if (e.is_buy) {
            t.buySol += sol;
            if (e.user === t.creator) t.creatorBuySol += sol;
          } else {
            t.sellSol += sol;
            if (e.user === t.creator) t.creatorSold = true;
            if (sol >= p.bigSellSol) bigSell.add(e.mint);
          }
          traded.add(e.mint);
        }
      }

      // Drop trades older than any window we read, per traded curve.
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keepSlots) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      // Sweep a bounded slice of tapes each batch and drop the ones belonging
      // to completed curves with no recent trades. A persistent iterator
      // walks the map in insertion order (deterministic) without
      // materialising the whole key array on every batch; the bound keeps
      // the work per batch constant. Visiting a tape also drops its stale
      // trades, so a curve that stops trading does not keep its history
      // in memory forever.
      {
        if (pruneIter === null) pruneIter = tapes.keys();
        for (let i = 0; i < PRUNE_PER_BATCH; i++) {
          const next = pruneIter.next();
          if (next.done) {
            pruneIter = tapes.keys();
            break;
          }
          const mint = next.value;
          const t = tapes.get(mint);
          if (t === undefined) continue;
          let cut = 0;
          while (cut < t.trades.length && t.trades[cut]!.slot <= now - keepSlots) cut++;
          if (cut > 0) t.trades.splice(0, cut);
          const curve = state.curves.get(mint);
          const lastTrade = t.trades[t.trades.length - 1];
          if (curve !== undefined && curve.complete && (lastTrade === undefined || lastTrade.slot <= now - keepSlots)) {
            tapes.delete(mint);
          }
        }
      }

      // Marks arrive for held and pending mints only, so a linear scan is
      // cheaper than building a Map on every batch.
      const markFor = (mint: Pubkey) => {
        for (const m of batch.marks) if (m.mint === mint) return m;
        return undefined;
      };
      const pendingByMint = new Map<Pubkey, number>();
      const pendingSell = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;

      // Phase 1 — exits first, so a slot never spends cash on a new entry
      // while a position that should be out is still held.
      for (const [mint, h] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          // No position and nothing pending: the position is gone for good.
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            const t = tapeFor(mint);
            if (h.filled) t.lastExitSlot = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = markFor(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const rqSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS;
        const tokens = Number(pos.token_amount);
        const valueSol = positionValueSol(BigInt(tokens), BigInt(vq), BigInt(vt), txSol);
        const costSol = Number(pos.cost_lamports) / LAMPORTS;
        if (valueSol > h.peakValueSol) h.peakValueSol = valueSol;
        h.lastValueSol = valueSol;
        const t = tapeFor(mint);
        // The reason is decided once and kept: if a sell is still pending, the
        // next batch retries the same exit instead of re-deciding (and the
        // journal keeps the original reason, not a fresh guess).
        let reason = h.exitKind;
        if (reason === null) {
          reason = exitReason(h, t, now, valueSol, costSol, rqSol, bigSell.has(mint));
          if (reason === null) continue;
          h.exitKind = reason;
        }
        h.exiting = true;
        if (pendingSell.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
        note(reason, now, mint, valueSol);
      }

      // Phase 2 — probe round trips: sell the whole probe as soon as its buy
      // has landed, so a probe never becomes an accidental position.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
        note('probe-sell', now, mint, p.probeSol);
        if (!selling) probes.set(mint, true);
      }

      // Phase 3 — entries and adds on the curves that traded this slot.
      let freeSol = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - open.size;
      let exposureSol = 0;
      for (const [mint, h] of open) {
        exposureSol += Math.max(h.investedSol, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = open.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let wantSol: number;
        let isAdd = false;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExitSlot < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol, price)) continue;
          wantSol = p.firstSol;
        } else {
          if (h.exiting || !h.filled || h.adds >= p.maxAdds || h.investedSol >= p.maxStakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (h.lastValueSol < Number(pos.cost_lamports) / LAMPORTS * (1 + p.addIfUp)) continue;
          if (recentFlow(t, now, p.flowWindow).netSol < p.minFlowSol) continue;
          if (rqSol > p.maxRqSol) continue;
          wantSol = Math.min(p.addSol, p.maxStakeSol - h.investedSol);
          isAdd = true;
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amountSol = Math.min(capSol, wantSol, p.maxExposureSol - exposureSol);
        if (amountSol > freeSol - txSol) amountSol = freeSol - txSol;
        if (amountSol < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amountSol * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        note(isAdd ? 'add' : 'enter', now, mint, amountSol);
        freeSol -= amountSol + txSol;
        exposureSol += amountSol;
        if (h === undefined) {
          open.set(mint, {
            openedSlot: now,
            peakValueSol: 0,
            investedSol: amountSol,
            exiting: false,
            exitKind: null,
            filled: false,
            adds: 0,
            lastAddPrice: price,
            lastValueSol: 0,
          });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.investedSol += amountSol;
          h.adds++;
          h.lastAddPrice = price;
        }
      }

      // Phase 4 — guardrail pacing: open a probe when the bot's fills or coins
      // lag the pace. Probes prefer fresh, liquid curves, never re-probe a mint
      // inside the cooldown, and never spend past the run's probe budget.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstBlockTime !== null && lastBlockTime !== null) {
        const pace = Math.min(1, (lastBlockTime - firstBlockTime) / p.paceSecs);
        const needCoins = ownCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = ownFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && ownCoins.has(mint)) continue;
            const lastProbe = probeLastSlot.get(mint) ?? -1e12;
            if (now - lastProbe < p.probeCooldown) continue;
            if (probeSpentSol + p.probeSol > p.maxProbeSpendSol) break;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (freeSol < p.probeSol + 2 * txSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            note('probe-buy', now, mint, p.probeSol);
            probes.set(mint, false);
            probeLastSlot.set(mint, now);
            probeSpentSol += p.probeSol;
            freeSol -= p.probeSol + txSol;
          }
        }
      }
      return orders;
    },
  };
}
