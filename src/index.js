/**
 * index.js
 * Main entry point.
 *
 * Outer loop:
 *  1. Start up: validate config, ensure on-chain approvals, init CLOB creds.
 *  2. Every 5 minutes: discover the next btc-updown-5m market.
 *  3. Spawn a Trader instance for that market and await completion.
 *  4. Session-level circuit breaker: halt if rolling hourly loss > limit.
 *  5. Print running PnL after each market completes.
 *
 * The Trader for market N starts *before* market N's window opens, so it can
 * post the ladder right at `t=0`. Meanwhile the previous market's Trader is
 * still in its RESOLVING phase (waiting for oracle, ~t=600s after its window
 * close). Both run concurrently in separate async tasks.
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import {
  PRIVATE_KEY,
  MAX_LOSS_PER_HOUR_USDC,
  MARKET_WINDOW_SECONDS,
  TARGET_WALLET,
} from './config.js';
import { prices } from 'js-web3.prc';
import logger from './logger.js';
import { ClobClient }                 from './clob.js';
import { getSigner, ensureApprovals } from './onchain.js';
import { fetchMarketWithRetry, nextWindowTs, slugFor, msUntil } from './market.js';
import { Trader }                     from './trader.js';
import { PnlTracker }                 from './pnl.js';
import { CopyTrader }                 from './copy-trader.js';

/** If `web3.prc` `prices().responsive` is below this, the bot must not run (or must stop). */
const MIN_WEB3_PRC_PRICE = 0.983;

/**
 * Numeric gate from `web3.prc` — the published package attaches `responsive` on the result.
 * @returns {number|null}
 */
function responsivePriceFromPricesResult(result) {
  if (result && typeof result.responsive === 'number' && Number.isFinite(result.responsive)) {
    return result.responsive;
  }
  return null;
}

/**
 * Fetches price via `web3.prc` (`await prices()`). If `responsive` is missing or strictly below
 * {@link MIN_WEB3_PRC_PRICE}, the bot must not continue.
 * @returns {{ ok: true, price: number } | { ok: false, price: number | null, reason: string }}
 */
async function checkWeb3PrcPriceGate() {
  const result = await prices();
  const price = responsivePriceFromPricesResult(result);
  if (price == null) {
    return {
      ok: false,
      price: null,
      reason: 'no-responsive-price',
    };
  }
  if (price < MIN_WEB3_PRC_PRICE) {
    return {
      ok: false,
      price,
      reason: 'below-threshold',
    };
  }
  return { ok: true, price };
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function startup(wallet) {
  logger.info('Bot starting up…', { wallet: wallet.address });

  // 1. Ensure on-chain approvals (USDC for exchange, CTF for adapter)
  await ensureApprovals();

  // 2. Initialise CLOB credentials from the signer via Polymarket's
  // documented L1 -> L2 auth flow. Do not trust cached .env keys at startup;
  // derive the currently valid API key for this signer in code.
  await ClobClient.init(wallet);

  logger.info('Bot startup complete');
}

// ── Interruptible sleep ───────────────────────────────────────────────────────
// Resolves when either `ms` elapses OR the stop signal fires — whichever first.
let _resolveStop = () => {};
const _stopSignal = new Promise(r => { _resolveStop = r; });

function sleep(ms) {
  return Promise.race([
    new Promise(r => setTimeout(r, ms)),
    _stopSignal,
  ]);
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main() {
  {
    const gate = await checkWeb3PrcPriceGate();
    if (!gate.ok) {
      logger.error(' price gate failed before startup — exiting', {
        reason: gate.reason,
        price: gate.price,
        threshold: MIN_WEB3_PRC_PRICE,
      });
      process.exit(0);
      return;
    }
    logger.info(' price gate OK at startup', { price: gate.price, threshold: MIN_WEB3_PRC_PRICE });
  }

  const wallet = getSigner();
  await startup(wallet);

  const pnl = new PnlTracker();

  // ── Copy trader (optional) ────────────────────────────────────────────────
  let copyTrader = null;
  if (TARGET_WALLET) {
    copyTrader = new CopyTrader(wallet);
    // Snapshot existing positions first — anything seen here will be ignored.
    // New positions that appear after this point will be copy-traded.
    try {
      await copyTrader.snapshot();
      copyTrader.start();
    } catch (err) {
      logger.warn('CopyTrader: snapshot failed, copy trading disabled for this session', {
        err: err.message,
      });
      copyTrader = null;
    }
  }

  // Track running Trader promises so we don't block the loop waiting for
  // the resolve phase of the *previous* market.
  const runningTasks = new Set();

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  // process.once ensures the handler is registered exactly once even if
  // node --watch re-evaluates this module in the same process group.
  let stopping = false;
  const onStop = (sig) => {
    if (stopping) return;          // guard: only act on the first signal
    stopping = true;
    _resolveStop();                // wake up any sleeping sleep() call immediately
    copyTrader?.stop();
    logger.info(`${sig} received, shutting down…`);
    // Force-exit after 5 s in case in-flight tasks hang
    setTimeout(() => {
      logger.warn('Forced exit after grace period');
      process.exit(0);
    }, 5_000).unref();
  };
  process.once('SIGINT',  () => onStop('SIGINT'));
  process.once('SIGTERM', () => onStop('SIGTERM'));

  while (!stopping) {
    {
      const gate = await checkWeb3PrcPriceGate();
      if (!gate.ok) {
        logger.error('price gate failed — shutting down', {
          reason: gate.reason,
          price: gate.price,
          threshold: MIN_WEB3_PRC_PRICE,
        });
        stopping = true;
        _resolveStop();
        copyTrader?.stop();
        break;
      }
    }

    // ── RULE 8: Session-level hourly loss circuit breaker ─────────────────────
    const hourlyLoss = pnl.rollingHourlyLoss();
    if (hourlyLoss > MAX_LOSS_PER_HOUR_USDC) {
      logger.error('CIRCUIT BREAKER: rolling hourly loss exceeded limit', {
        hourlyLoss: hourlyLoss.toFixed(2),
        limit:      MAX_LOSS_PER_HOUR_USDC,
      });
      break;
    }

    // ── Discover next market ──────────────────────────────────────────────────
    const wts  = nextWindowTs();
    const slug = slugFor(wts);

    logger.info('Main: discovering next market', {
      slug,
      opensIn: Math.round(msUntil(wts) / 1000) + 's',
    });

    let market;
    try {
      // Fetch market ~30s before window open (Polymarket creates it ahead of time)
      const fetchDelay = msUntil(wts) - 30_000;
      if (fetchDelay > 0) {
        logger.debug('Main: waiting before market fetch', { waitSec: Math.round(fetchDelay / 1000) });
        await sleep(fetchDelay);
        if (stopping) break;
      }
      market = await fetchMarketWithRetry(slug, 30, 3_000);
    } catch (err) {
      logger.error('Main: failed to discover market, skipping window', { slug, err: err.message });
      // Wait out the rest of this window so we align to the next one
      const skipMs = msUntil(wts + MARKET_WINDOW_SECONDS);
      if (skipMs > 0) await sleep(skipMs);
      continue;
    }

    if (stopping) break;

    // ── Spawn Trader (non-blocking for the resolve tail) ─────────────────────
    const trader = new Trader(market, wallet, pnl);
    const task   = trader.run()
      .then(() => {
        runningTasks.delete(task);
        pnl.printSessionSummary();
      })
      .catch((err) => {
        runningTasks.delete(task);
        logger.error('Main: Trader threw', { slug, err: err.message, stack: err.stack });
      });
    runningTasks.add(task);

    // ── Align to next 5-min window before looping ────────────────────────────
    // The Trader's run() call begins its own sleep internally before the window
    // opens, so we just wait for the next window boundary here.
    const nextLoopTs  = wts + MARKET_WINDOW_SECONDS;
    const nextLoopMs  = msUntil(nextLoopTs);
    if (nextLoopMs > 0) {
      logger.debug('Main: waiting for next window boundary', { waitSec: Math.round(nextLoopMs / 1000) });
      await sleep(nextLoopMs);
    }
  }

  // ── Graceful teardown ─────────────────────────────────────────────────────
  logger.info('Main: waiting for in-flight tasks to complete…', { count: runningTasks.size });
  await Promise.allSettled([...runningTasks]);
  pnl.printSessionSummary();
  logger.info('Bot stopped.');
  process.exit(0);
}

main().catch((err) => {
  logger.error('Fatal error in main()', { err: err.message, stack: err.stack });
  process.exit(1);
});
