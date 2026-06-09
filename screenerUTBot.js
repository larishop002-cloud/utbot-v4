/**
 * Screener — UT Bot Alert (1H)
 *
 * Filter tokenized stocks via symbolFilter.js (field areaSymbol dari API Bitget).
 */

import { getCandles, getAllTickers } from './bitget.js';
import { calcUTBot, calcEMA }        from './indicators.js';
import { config }                    from './config.js';
import { log }                       from './logger.js';
import { hasPosition }               from './state.js';
import { filterCryptoOnly }          from './symbolFilter.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const _sentSignals = new Map();

function signalKey(symbol, signal, timestamp) {
  return `${symbol}_${signal}_${timestamp}`;
}

async function is1HBullish(symbol) {
  try {
    const raw1H = await getCandles(symbol, '1h', 60);
    if (!Array.isArray(raw1H) || raw1H.length < 25) return true;

    const now         = Date.now();
    const periodMs    = 3600000;
    const periodStart = now - (now % periodMs);
    const closed      = raw1H
      .filter(c => parseInt(c[0]) < periodStart)
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

    if (closed.length < 22) return true;

    const closes    = closed.map(c => parseFloat(c[4]));
    const ema21     = calcEMA(closes, 21);
    const lastClose = closes[closes.length - 1];

    const bullish = ema21 ? lastClose > ema21 : true;
    log('utbot', `  [1H EMA21] ${symbol}: close=${lastClose?.toFixed(6)} EMA21=${ema21?.toFixed(6)} → ${bullish ? '✅ BULLISH' : '❌ BEARISH'}`);
    return bullish;
  } catch {
    return true;
  }
}

// ── Scan satu symbol dengan retry ─────────────────────────────────────────────
async function scanSymbol(symbol, cfg, _retry = 0) {
  const { keyValue, atrPeriod, filter1H_EMA21 } = cfg;
  const MAX_RETRY = 2;

  try {
    const raw1H = await getCandles(symbol, '1h', Math.max(atrPeriod * 3 + 20, 60));
    if (!Array.isArray(raw1H) || raw1H.length < atrPeriod + 10) return null;

    const now         = Date.now();
    const periodMs    = 3600000;
    const periodStart = now - (now % periodMs);
    const closed      = raw1H
      .filter(c => parseInt(c[0]) < periodStart)
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

    if (closed.length < atrPeriod + 5) return null;

    const highs  = closed.map(c => parseFloat(c[2]));
    const lows   = closed.map(c => parseFloat(c[3]));
    const closes = closed.map(c => parseFloat(c[4]));
    const lastTs = parseInt(closed[closed.length - 1][0]);

    const result = calcUTBot(highs, lows, closes, keyValue, atrPeriod);
    if (!result || !result.signal) return null;
    if (result.signal !== 'BUY') return null;

    const key = signalKey(symbol, result.signal, lastTs);
    if (_sentSignals.has(key)) return null;

    if (filter1H_EMA21 !== false) {
      const bullish1H = await is1HBullish(symbol);
      if (!bullish1H) {
        log('utbot', `  ${symbol} BUY signal tapi 1H bearish → difilter`);
        return null;
      }
    }

    _sentSignals.set(key, Date.now());

    const cutoff = Date.now() - 86400000;
    for (const [k, ts] of _sentSignals.entries()) {
      if (ts < cutoff) _sentSignals.delete(k);
    }

    const slBuffer = config.management?.slBuffer ?? 0.005;
    const slPrice  = result.trailingStop * (1 - slBuffer);
    const low20    = Math.min(...lows.slice(-20));
    const ema21_1H = calcEMA(closes, 21);

    return {
      symbol,
      signal:       result.signal,
      close:        result.close,
      trailingStop: result.trailingStop,
      atr:          result.atr,
      nLoss:        result.nLoss,
      candleTs:     lastTs,
      lastPrice:    result.close,
      slPrice,
      zones: [{
        type:        'UTBot',
        entryPct:    100,
        priceTop:    result.close * 1.005,
        priceBottom: result.trailingStop,
        label:       `UT Bot zone ${result.trailingStop.toFixed(6)} - ${(result.close * 1.005).toFixed(6)}`,
      }],
      strategy:  'utbot',
      triggered: true,
      signals: {
        utbotSignal: { bullish: true, label: `UT Bot BUY — close ${result.close} cross above trailing stop ${result.trailingStop.toFixed(6)}` },
        atrTrailing: { bullish: true, label: `ATR=${result.atr.toFixed(6)} | nLoss=${result.nLoss.toFixed(6)} | keyValue=${keyValue}` },
        ema21_1H:    { bullish: true, label: ema21_1H ? `Close ${result.close.toFixed(6)} > EMA21 1H ${ema21_1H.toFixed(6)} ✅` : 'EMA21 1H: data kurang' },
        support:     { bullish: true, label: `Low20 1H = ${low20.toFixed(6)} | SL ref = ${result.trailingStop.toFixed(6)}` },
      },
      ema21_1H,
      matchCount: 3,
      score: 50,
    };

  } catch (err) {
    const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout') || err.message?.includes('exceeded');

    if (isTimeout && _retry < MAX_RETRY) {
      const waitMs = 3000 * (_retry + 1);
      log('utbot', `  ⏳ ${symbol} timeout — retry ${_retry + 1}/${MAX_RETRY} dalam ${waitMs / 1000}s`);
      await sleep(waitMs);
      return scanSymbol(symbol, cfg, _retry + 1);
    }

    if (isTimeout) {
      log('utbot', `  ⚠ ${symbol} timeout setelah ${MAX_RETRY + 1} percobaan — skip`);
    } else {
      log('utbot_error', `Scan ${symbol}: ${err.message}`);
    }
    return null;
  }
}

export async function runUTBotScreener(tickersOrSymbols, opts = {}) {
  const utCfg = config.screening?.utbot ?? {};

  const keyValue       = utCfg.keyValue       ?? 2;
  const atrPeriod      = utCfg.atrPeriod      ?? 10;
  const filter1H_EMA21 = utCfg.filter1H_EMA21 !== false;
  const minVol         = utCfg.minVolume24h   ?? config.screening?.minVolume24h ?? 5_000_000;
  const maxSignals     = opts.maxSignals       ?? utCfg.maxSignalsPerRun ?? 5;
  const quoteAsset     = config.trading.quoteAsset || 'USDT';
  const whitelist      = config.whitelist ?? [];
  const fromGainer     = opts.fromGainer ?? false;

  log('utbot', `══ UT Bot Alert Screener (1H | key=${keyValue} atr=${atrPeriod} | EMA21-1H: ${filter1H_EMA21 ? 'ON' : 'OFF'}) ══`);

  let filtered;

  if (fromGainer && Array.isArray(tickersOrSymbols)) {
    filtered = tickersOrSymbols.filter(t => !hasPosition(t.symbol));
    log('utbot', `Dari gainer pipeline: ${filtered.length} koin (sudah crypto spot murni)`);
  } else {
    const tickers = Array.isArray(tickersOrSymbols) ? tickersOrSymbols : [];
    const cryptoTickers = await filterCryptoOnly(tickers);

    filtered = cryptoTickers
      .filter(t => {
        if (!t.symbol.endsWith(quoteAsset))                        return false;
        if (config.blacklist?.includes(t.symbol))                  return false;
        if (parseFloat(t.usdtVol || t.quoteVolume || 0) < minVol) return false;
        if (whitelist.length > 0 && !whitelist.includes(t.symbol)) return false;
        return true;
      })
      .sort((a, b) => parseFloat(b.usdtVol || 0) - parseFloat(a.usdtVol || 0));
  }

  log('utbot', `Scanning ${filtered.length} koin untuk BUY signal (crypto spot murni)...`);

  const signals    = [];
  let   timeouts   = 0;
  const MAX_CONSEC_TIMEOUT = 3; // stop sementara jika 3 timeout berturut-turut

  for (let i = 0; i < filtered.length; i++) {
    const coin   = filtered[i];
    const before = Date.now();
    const result = await scanSymbol(coin.symbol, { keyValue, atrPeriod, filter1H_EMA21 });
    const elapsed = Date.now() - before;

    // Deteksi timeout berturut-turut
    if (elapsed > 15000) {
      timeouts++;
      if (timeouts >= MAX_CONSEC_TIMEOUT) {
        log('utbot', `  ⚠ ${timeouts} timeout berturut-turut — jeda 10s untuk stabilkan koneksi`);
        await sleep(10000);
        timeouts = 0;
      }
    } else {
      timeouts = 0;
    }

    if (result) {
      const hasPos     = hasPosition(result.symbol);
      result.hasPosition = hasPos;
      result.vol24h    = coin.vol24h    ?? parseFloat(coin.usdtVol || coin.quoteVolume || 0);
      result.change24h = coin.change24h ?? parseFloat(coin.change24h || 0);

      log('utbot', `  🔔 BUY: ${result.symbol} @ ${result.close} | TS=${result.trailingStop.toFixed(6)}${hasPos ? ' [POSISI OPEN]' : ''}`);
      signals.push(result);

      if (signals.length >= maxSignals) {
        log('utbot', `  Max ${maxSignals} sinyal tercapai, berhenti`);
        break;
      }
    }

    // Jeda adaptif: lebih lama setelah tiap 5 koin, atau jika baru timeout
    if (i % 10 === 9)       await sleep(1000);
    else if (i % 5 === 4)   await sleep(500);
    else if (elapsed > 5000) await sleep(500); // lambat? beri jeda ekstra
    else                     await sleep(200);
  }

  log('utbot', `UT Bot selesai → ${signals.length} BUY signal`);
  return signals;
}
