/**
 * Screener — UT Bot Alert (4H only dari pipeline Gainer)
 *
 * Perubahan v3.3:
 *  - Baca config timeframe dari user-config.json
 *  - Jika timeframe = '4h', hanya scan 4H (skip 1H)
 *  - Filter EMA21 dimatikan untuk pipeline Gainer+UTBot
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
    const periodMs = tf === '4H' ? 14400000 : 3600000;
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

    log('utbot', `  [${tf} EMA21] ${symbol}: close=${lastClose?.toFixed(6)} EMA21=${ema21?.toFixed(6)} → ${bullish ? '✅' : '❌'}`);
    return bullish;
  } catch {
    return true;
  }
}

// ── Normalisasi timeframe string ke format Bitget API ────────────────────────
// Bitget pakai: '1H', '4H', '1D' (huruf besar)
function normalizeTF(tf) {
  const map = {
    '1h': '1H', '4h': '4H', '1d': '1D',
    '1H': '1H', '4H': '4H', '1D': '1D',
  };
  return map[tf] ?? tf.toUpperCase();
}

// ── Scan satu timeframe untuk satu symbol ────────────────────────────────────
async function scanTimeframe(symbol, tf, cfg, _retry = 0) {
  const { keyValue, atrPeriod, filterEMA21 } = cfg;
  const MAX_RETRY = 2;

  // Normalisasi ke format Bitget
  const bitgetTF  = normalizeTF(tf);
  const periodMs  = bitgetTF === '4H' ? 14400000 : 3600000;

  try {
    const candleLimit = Math.max(atrPeriod * 3 + 20, 60);
    const raw         = await getCandles(symbol, bitgetTF, candleLimit);
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
    const key = signalKey(symbol, result.signal, bitgetTF, lastTs);
    if (_sentSignals.has(key)) return null;

    // Filter EMA21 (opsional, dimatikan untuk pipeline 4H)
    if (filterEMA21) {
      const bullish = await isEMABullish(symbol, bitgetTF);
      if (!bullish) {
        log('utbot', `  ${symbol} [${bitgetTF}] BUY tapi EMA21 bearish → difilter`);
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
      tf: bitgetTF,
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
      log('utbot', `  ⏳ ${symbol} [${bitgetTF}] timeout — retry ${_retry + 1}/${MAX_RETRY} dalam ${waitMs / 1000}s`);
      await sleep(waitMs);
      return scanTimeframe(symbol, tf, cfg, _retry + 1);
    }

    if (isTimeout) log('utbot', `  ⚠ ${symbol} [${bitgetTF}] timeout setelah ${MAX_RETRY + 1}x — skip`);
    else           log('utbot_error', `Scan ${symbol} [${bitgetTF}]: ${err.message}`);
    return null;
  }
}

// ── Scan symbol sesuai config timeframe ──────────────────────────────────────
async function scanSymbol(symbol, cfg) {
  const { timeframes, keyValue, atrPeriod } = cfg;

  // Scan semua timeframe yang dikonfigurasi secara paralel
  const results = await Promise.all(
    timeframes.map(tf => scanTimeframe(symbol, tf, cfg))
  );

  const validResults = results.filter(Boolean);
  if (!validResults.length) return null;

  // Tentukan label timeframe yang trigger
  const triggeredTFs = validResults.map(r => r.tf);
  const tfLabel      = triggeredTFs.length > 1
    ? triggeredTFs.join('+') + ' 🔥'
    : triggeredTFs[0];

  // Score: lebih banyak TF = lebih tinggi
  const score = triggeredTFs.length > 1 ? 80
    : triggeredTFs[0] === '4H'          ? 65
    : 50;

  // Prefer 4H jika ada, fallback ke TF lain
  const primary = validResults.find(r => r.tf === '4H') ?? validResults[0];

  log('utbot', `  🔔 BUY [${tfLabel}]: ${symbol} @ ${primary.close} | TS=${primary.trailingStop.toFixed(6)}`);

  // Build signals object per TF
  const signalsObj = { utbotSignal: {
    bullish: true,
    label: `UT Bot BUY [${tfLabel}] — close ${primary.close} cross above trailing stop ${primary.trailingStop.toFixed(6)}`,
  }};

  for (const r of validResults) {
    signalsObj[`tf_${r.tf}`] = {
      bullish: true,
      label: `${r.tf} signal ✅ | EMA21=${r.ema21val?.toFixed(6) ?? '—'} | Low20=${r.low20?.toFixed(6)}`,
    };
  }

  // TF yang tidak trigger
  for (const tf of timeframes) {
    const bitgetTF = normalizeTF(tf);
    if (!triggeredTFs.includes(bitgetTF)) {
      signalsObj[`tf_${bitgetTF}`] = {
        bullish: false,
        label: `${bitgetTF}: tidak ada signal`,
      };
    }
  }

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
    triggeredTFs,
    zones: [{
      type:        'UTBot',
      entryPct:    100,
      priceTop:    primary.close * 1.005,
      priceBottom: primary.trailingStop,
      label:       `UT Bot [${tfLabel}] zone ${primary.trailingStop.toFixed(6)} - ${(primary.close * 1.005).toFixed(6)}`,
    }],
    strategy:  'utbot',
    triggered: true,
    signals:   signalsObj,
    ema21_primary: primary.ema21val ?? null,
    matchCount: validResults.length,
    score,
  };
}

// ── Main screener ─────────────────────────────────────────────────────────────
export async function runUTBotScreener(tickersOrSymbols, opts = {}) {
  const utCfg = config.screening?.utbot ?? {};

  const keyValue       = utCfg.keyValue        ?? 2;
  const atrPeriod      = utCfg.atrPeriod       ?? 10;
  const minVol         = utCfg.minVolume24h    ?? config.screening?.minVolume24h ?? 5_000_000;
  const maxSignals     = opts.maxSignals        ?? utCfg.maxSignalsPerRun ?? 10;
  const quoteAsset     = config.trading.quoteAsset || 'USDT';
  const whitelist      = config.whitelist ?? [];
  const fromGainer     = opts.fromGainer ?? false;

  // Baca timeframe dari config, default ke ['4H']
  const configTF  = utCfg.timeframe ?? '4h';
  const timeframes = Array.isArray(configTF)
    ? configTF
    : [configTF];

  // Filter EMA21: dari pipeline gainer selalu false, dari config jika standalone
  const filterEMA21 = fromGainer
    ? false
    : (utCfg.filter1H_EMA21 !== false && timeframes.some(tf => normalizeTF(tf) === '1H'));

  log('utbot', `══ UT Bot Alert Screener (TF: ${timeframes.map(normalizeTF).join('+')} | key=${keyValue} atr=${atrPeriod} | EMA21: ${filterEMA21 ? 'ON' : 'OFF'}) ══`);

  let filtered;

  if (fromGainer && Array.isArray(tickersOrSymbols)) {
    filtered = tickersOrSymbols.filter(t => !hasPosition(t.symbol));
    log('utbot', `Dari gainer pipeline: ${filtered.length} koin`);
  } else {
    const tickers       = Array.isArray(tickersOrSymbols) ? tickersOrSymbols : [];
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

  log('utbot', `Scanning ${filtered.length} koin (TF: ${timeframes.map(normalizeTF).join('+')})...`);

  const signals  = [];
  let   timeouts = 0;
  const MAX_CONSEC_TIMEOUT = 3;

  for (let i = 0; i < filtered.length; i++) {
    const coin    = filtered[i];
    const before  = Date.now();
    const result  = await scanSymbol(coin.symbol, { keyValue, atrPeriod, filterEMA21, timeframes });
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

    // Jeda adaptif
    if (i % 10 === 9)        await sleep(1500);
    else if (i % 5 === 4)    await sleep(800);
    else if (elapsed > 8000) await sleep(800);
    else                     await sleep(300);
  }

  // Sort by score tertinggi
  signals.sort((a, b) => b.score - a.score);

  log('utbot', `UT Bot selesai → ${signals.length} BUY signal`);
  if (signals.length > 0) {
    signals.forEach(s => log('utbot', `  ✅ ${s.symbol} [${s.timeframe}] score=${s.score}`));
  }
  return signals;
}
