/**
 * Screener — UT Bot Alert (1H + 4H, Opsi B: Either Timeframe)
 *
 * Sinyal muncul jika BUY signal ada di 1H ATAU 4H.
 * Tiap sinyal diberi tag timeframe mana yang trigger.
 */

import { getCandles, getAllTickers } from './bitget.js';
import { calcUTBot, calcEMA }        from './indicators.js';
import { config }                    from './config.js';
import { log }                       from './logger.js';
import { hasPosition }               from './state.js';
import { filterCryptoOnly }          from './symbolFilter.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const _sentSignals = new Map();

function signalKey(symbol, signal, tf, timestamp) {
  return `${symbol}_${signal}_${tf}_${timestamp}`;
}

// ── Cek EMA21 bullish untuk timeframe tertentu ────────────────────────────────
async function isEMABullish(symbol, tf) {
  try {
    const periodMs = tf === '4h' ? 14400000 : 3600000;
    const raw      = await getCandles(symbol, tf, 60);
    if (!Array.isArray(raw) || raw.length < 25) return true;

    const now         = Date.now();
    const periodStart = now - (now % periodMs);
    const closed      = raw
      .filter(c => parseInt(c[0]) < periodStart)
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

    if (closed.length < 22) return true;

    const closes    = closed.map(c => parseFloat(c[4]));
    const ema21     = calcEMA(closes, 21);
    const lastClose = closes[closes.length - 1];
    const bullish   = ema21 ? lastClose > ema21 : true;

    log('utbot', `  [${tf.toUpperCase()} EMA21] ${symbol}: close=${lastClose?.toFixed(6)} EMA21=${ema21?.toFixed(6)} → ${bullish ? '✅' : '❌'}`);
    return bullish;
  } catch {
    return true;
  }
}

// ── Scan satu timeframe untuk satu symbol ────────────────────────────────────
async function scanTimeframe(symbol, tf, cfg, _retry = 0) {
  const { keyValue, atrPeriod, filter1H_EMA21 } = cfg;
  const MAX_RETRY = 2;
  const periodMs  = tf === '4h' ? 14400000 : 3600000;

  try {
    const candleLimit = Math.max(atrPeriod * 3 + 20, 60);
    const raw         = await getCandles(symbol, tf, candleLimit);
    if (!Array.isArray(raw) || raw.length < atrPeriod + 10) return null;

    const now         = Date.now();
    const periodStart = now - (now % periodMs);
    const closed      = raw
      .filter(c => parseInt(c[0]) < periodStart)
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

    if (closed.length < atrPeriod + 5) return null;

    const highs  = closed.map(c => parseFloat(c[2]));
    const lows   = closed.map(c => parseFloat(c[3]));
    const closes = closed.map(c => parseFloat(c[4]));
    const lastTs = parseInt(closed[closed.length - 1][0]);

    const result = calcUTBot(highs, lows, closes, keyValue, atrPeriod);
    if (!result || result.signal !== 'BUY') return null;

    // Deduplikasi per timeframe
    const key = signalKey(symbol, result.signal, tf, lastTs);
    if (_sentSignals.has(key)) return null;

    // Filter EMA21 per timeframe (hanya untuk 1H jika filter1H_EMA21 aktif)
    if (tf === '1h' && filter1H_EMA21 !== false) {
      const bullish = await isEMABullish(symbol, '1h');
      if (!bullish) {
        log('utbot', `  ${symbol} [1H] BUY tapi EMA21 bearish → difilter`);
        return null;
      }
    }

    _sentSignals.set(key, Date.now());

    // Cleanup signal cache
    const cutoff = Date.now() - 86400000;
    for (const [k, ts] of _sentSignals.entries()) {
      if (ts < cutoff) _sentSignals.delete(k);
    }

    const slBuffer = config.management?.slBuffer ?? 0.005;
    const slPrice  = result.trailingStop * (1 - slBuffer);
    const low20    = Math.min(...lows.slice(-20));
    const ema21val = calcEMA(closes, 21);

    return {
      tf,
      signal:       result.signal,
      close:        result.close,
      trailingStop: result.trailingStop,
      atr:          result.atr,
      nLoss:        result.nLoss,
      candleTs:     lastTs,
      slPrice,
      low20,
      ema21val,
    };

  } catch (err) {
    const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout') || err.message?.includes('exceeded');

    if (isTimeout && _retry < MAX_RETRY) {
      const waitMs = 3000 * (_retry + 1);
      log('utbot', `  ⏳ ${symbol} [${tf}] timeout — retry ${_retry + 1}/${MAX_RETRY} dalam ${waitMs / 1000}s`);
      await sleep(waitMs);
      return scanTimeframe(symbol, tf, cfg, _retry + 1);
    }

    if (isTimeout) log('utbot', `  ⚠ ${symbol} [${tf}] timeout setelah ${MAX_RETRY + 1}x — skip`);
    else           log('utbot_error', `Scan ${symbol} [${tf}]: ${err.message}`);
    return null;
  }
}

// ── Scan symbol di 1H DAN 4H, return jika salah satu BUY ────────────────────
async function scanSymbol(symbol, cfg) {
  const { keyValue, atrPeriod } = cfg;

  // Scan 1H dan 4H secara paralel
  const [res1H, res4H] = await Promise.all([
    scanTimeframe(symbol, '1h', cfg),
    scanTimeframe(symbol, '4h', cfg),
  ]);

  if (!res1H && !res4H) return null;

  // Tentukan timeframe mana yang trigger
  const triggered1H = !!res1H;
  const triggered4H = !!res4H;
  const primary      = res4H || res1H; // prefer 4H jika keduanya ada (lebih kuat)

  const tfLabel = triggered1H && triggered4H ? '1H+4H 🔥' : triggered4H ? '4H' : '1H';
  const score   = triggered1H && triggered4H ? 80 : triggered4H ? 65 : 50;

  log('utbot', `  🔔 BUY [${tfLabel}]: ${symbol} @ ${primary.close} | TS=${primary.trailingStop.toFixed(6)}`);

  return {
    symbol,
    signal:       'BUY',
    close:        primary.close,
    trailingStop: primary.trailingStop,
    atr:          primary.atr,
    nLoss:        primary.nLoss,
    candleTs:     primary.candleTs,
    lastPrice:    primary.close,
    slPrice:      primary.slPrice,
    timeframe:    tfLabel,
    triggered1H,
    triggered4H,
    zones: [{
      type:        'UTBot',
      entryPct:    100,
      priceTop:    primary.close * 1.005,
      priceBottom: primary.trailingStop,
      label:       `UT Bot [${tfLabel}] zone ${primary.trailingStop.toFixed(6)} - ${(primary.close * 1.005).toFixed(6)}`,
    }],
    strategy:  'utbot',
    triggered: true,
    signals: {
      utbotSignal: {
        bullish: true,
        label: `UT Bot BUY [${tfLabel}] — close ${primary.close} cross above trailing stop ${primary.trailingStop.toFixed(6)}`,
      },
      atrTrailing: {
        bullish: true,
        label: `ATR=${primary.atr.toFixed(6)} | nLoss=${primary.nLoss.toFixed(6)} | key=${keyValue} atr=${atrPeriod}`,
      },
      tf1H: triggered1H ? {
        bullish: true,
        label: `1H signal ✅ | EMA21=${res1H.ema21val?.toFixed(6) ?? '—'} | Low20=${res1H.low20?.toFixed(6)}`,
      } : { bullish: false, label: '1H: tidak ada signal' },
      tf4H: triggered4H ? {
        bullish: true,
        label: `4H signal ✅ | EMA21=${res4H.ema21val?.toFixed(6) ?? '—'} | Low20=${res4H.low20?.toFixed(6)}`,
      } : { bullish: false, label: '4H: tidak ada signal' },
    },
    ema21_1H: res1H?.ema21val ?? null,
    ema21_4H: res4H?.ema21val ?? null,
    matchCount: (triggered1H ? 1 : 0) + (triggered4H ? 1 : 0),
    score,
  };
}

// ── Main screener ─────────────────────────────────────────────────────────────
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

  log('utbot', `══ UT Bot Alert Screener (1H + 4H | key=${keyValue} atr=${atrPeriod} | EMA21-1H: ${filter1H_EMA21 ? 'ON' : 'OFF'}) ══`);
  log('utbot', `   Mode: EITHER — sinyal lolos jika BUY di 1H ATAU 4H`);

  let filtered;

  if (fromGainer && Array.isArray(tickersOrSymbols)) {
    filtered = tickersOrSymbols.filter(t => !hasPosition(t.symbol));
    log('utbot', `Dari gainer pipeline: ${filtered.length} koin`);
  } else {
    const tickers      = Array.isArray(tickersOrSymbols) ? tickersOrSymbols : [];
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

  log('utbot', `Scanning ${filtered.length} koin (1H+4H paralel)...`);

  const signals  = [];
  let   timeouts = 0;
  const MAX_CONSEC_TIMEOUT = 3;

  for (let i = 0; i < filtered.length; i++) {
    const coin    = filtered[i];
    const before  = Date.now();
    const result  = await scanSymbol(coin.symbol, { keyValue, atrPeriod, filter1H_EMA21 });
    const elapsed = Date.now() - before;

    if (elapsed > 20000) {
      timeouts++;
      if (timeouts >= MAX_CONSEC_TIMEOUT) {
        log('utbot', `  ⚠ ${timeouts} timeout berturut-turut — jeda 10s`);
        await sleep(10000);
        timeouts = 0;
      }
    } else {
      timeouts = 0;
    }

    if (result) {
      result.hasPosition = hasPosition(result.symbol);
      result.vol24h      = coin.vol24h    ?? parseFloat(coin.usdtVol || coin.quoteVolume || 0);
      result.change24h   = coin.change24h ?? parseFloat(coin.change24h || 0);
      signals.push(result);

      if (signals.length >= maxSignals) {
        log('utbot', `  Max ${maxSignals} sinyal tercapai, berhenti`);
        break;
      }
    }

    // Jeda adaptif — lebih longgar karena sekarang scan 2 TF per koin
    if (i % 10 === 9)        await sleep(1500);
    else if (i % 5 === 4)    await sleep(800);
    else if (elapsed > 8000) await sleep(800);
    else                     await sleep(300);
  }

  // Sort: 1H+4H dulu, lalu 4H only, lalu 1H only
  signals.sort((a, b) => b.score - a.score);

  log('utbot', `UT Bot selesai → ${signals.length} BUY signal`);
  if (signals.length > 0) {
    signals.forEach(s => log('utbot', `  ✅ ${s.symbol} [${s.timeframe}] score=${s.score}`));
  }
  return signals;
}
