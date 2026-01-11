'use strict';

/**
 * ioBroker Crypto Prices (CoinGecko) + Alerts + VIS Mini Widget
 * Version: 1.0.0
 *
 * Features
 * - Fetch BTC/ETH/XRP prices (EUR or USD) from CoinGecko (no API key)
 * - Stores values under: 0_userdata.0.Finance.Crypto.*
 * - Threshold alerts (below/above) with hysteresis + per-coin cooldown
 * - Notifications via SynoChat alias "send" state (ack=false)
 * - Mini VIS widget HTML output with up/down arrows (24h change)
 *
 * Requirements
 * - ioBroker JavaScript adapter v9.x
 * - (Optional) SynoChat integration behind an alias state (write=true)
 *
 * Notes
 * - CoinGecko is rate-limited. Default polling is 60s with backoff on 429.
 */

const CFG = {
  // Root for values + alert states
  ROOT: '0_userdata.0.Finance.Crypto',

  // Output HTML state for VIS widget
  OUT_HTML: '0_userdata.0.vis.Dashboards.FinanceCryptohtml',

  // Quote currency: 'eur' or 'usd'
  VS: 'eur',

  // Polling interval (seconds). 60s recommended to avoid rate-limits.
  INTERVAL_SEC: 60,
  TIMEOUT_MS: 12000,

  // CoinGecko coin IDs
  COINS: [
    { id: 'bitcoin',  symbol: 'BTC', name: 'Bitcoin'  },
    { id: 'ethereum', symbol: 'ETH', name: 'Ethereum' },
    { id: 'ripple',   symbol: 'XRP', name: 'XRP'      },
  ],

  ALERTS: {
    enabled: true,

    // SynoChat alias "send" datapoint (write=true, type string)
    // IMPORTANT: command/send states usually require ack=false (handled by this script).
    SYNOCHAT_SEND_ID: '0_userdata.0.Notifications.SynoChat.send',

    // Optional prefix in sent messages
    MSG_PREFIX: '[Crypto]',

    /**
     * Thresholds per coin in VS currency.
     * - low: alert if price <= low
     * - high: alert if price >= high
     * Use null to disable one side.
     */
    THRESHOLDS: {
      BTC: { low: 35000, high: 60000 },
      ETH: { low: 1800,  high: 3500  },
      XRP: { low: 0.40,  high: 0.90  },
    },

    /**
     * Hysteresis to avoid alert flapping around the threshold.
     * The coin must move back beyond the threshold +/- gap before re-arming.
     * - pct: percent gap relative to the threshold (e.g., 0.3 => 0.3%)
     * - minAbs: minimal absolute gap in VS units
     */
    HYSTERESIS: { pct: 0.3, minAbs: 0.0 },

    // Minimum minutes between notifications per coin
    COOLDOWN_MIN: 15,

    // Optional: send a "back to normal" message after re-arming
    notifyBackToNormal: false,
  },
};

const https = require('https');

let backoffMs = 0;
let inFlight = false;
let lastErrSig = '';
let lastNotifyErrSig = '';

/** =========================
 * Helpers (ioBroker)
 * ========================= */
function ensureState(id, common) {
  if (!existsState(id)) createState(id, common);
}

function safeSet(id, val) {
  if (!existsState(id)) return;
  setState(id, val, true);
}

function readNum(id) {
  const s = getState(id);
  const v = s ? s.val : null;
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}

function readStr(id) {
  const s = getState(id);
  const v = s ? s.val : '';
  return (v === null || v === undefined) ? '' : String(v);
}

function logOnce(msg, level = 'warn') {
  const sig = `${level}|${msg}`;
  if (sig === lastErrSig) return;
  lastErrSig = sig;
  log(msg, level);
}

function logNotifyOnce(msg, level = 'warn') {
  const sig = `${level}|${msg}`;
  if (sig === lastNotifyErrSig) return;
  lastNotifyErrSig = sig;
  log(msg, level);
}

/** =========================
 * HTTP / CoinGecko
 * ========================= */
function buildUrl() {
  const ids = CFG.COINS.map(c => c.id).join(',');
  return `https://api.coingecko.com/api/v3/simple/price` +
    `?ids=${encodeURIComponent(ids)}` +
    `&vs_currencies=${encodeURIComponent(CFG.VS)}` +
    `&include_24hr_change=true` +
    `&include_last_updated_at=true`;
}

function httpGetJson(url, cb) {
  const req = https.request(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'ioBroker-js/crypto-monitor',
      'Connection': 'close',
    },
    timeout: CFG.TIMEOUT_MS,
  }, (res) => {
    let data = '';
    res.on('data', (d) => data += d);
    res.on('end', () => {
      const status = res.statusCode || 0;
      if (status < 200 || status >= 300) return cb(null, status, data, null);
      try {
        const json = JSON.parse(data);
        return cb(null, status, data, json);
      } catch (e) {
        return cb(e, status, data, null);
      }
    });
  });

  req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch (e) {} });
  req.on('error', (e) => cb(e, 0, '', null));
  req.end();
}

/** =========================
 * Formatting
 * ========================= */
function formatMoney(val) {
  if (val === null || val === undefined || typeof val !== 'number' || !isFinite(val)) return '—';
  // heuristic: small values (XRP) -> more decimals
  const dec = val < 10 ? 4 : val < 100 ? 2 : 0;
  return val.toLocaleString('de-DE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function formatPct(val) {
  if (val === null || val === undefined || typeof val !== 'number' || !isFinite(val)) return '—';
  const sign = val > 0 ? '+' : '';
  return sign + val.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** =========================
 * SynoChat Notifications
 * ========================= */
function sendNotification(message) {
  const full = `${CFG.ALERTS.MSG_PREFIX} ${message}`.trim();
  const id = CFG.ALERTS.SYNOCHAT_SEND_ID;

  if (!id) {
    logNotifyOnce('[Crypto] SYNOCHAT_SEND_ID is empty – cannot send notifications.', 'warn');
    return;
  }
  if (!existsState(id)) {
    logNotifyOnce(`[Crypto] SynoChat alias state not found: ${id}`, 'warn');
    return;
  }

  try {
    // Command/send states usually need ack=false
    setState(id, full, false);
  } catch (e) {
    logNotifyOnce(`[Crypto] SynoChat send failed: ${e.message}`, 'warn');
  }

  log(full, 'info');
}

/** =========================
 * Alert Logic
 * ========================= */
function getZone(symbol, price) {
  const t = (CFG.ALERTS.THRESHOLDS && CFG.ALERTS.THRESHOLDS[symbol]) ? CFG.ALERTS.THRESHOLDS[symbol] : null;
  if (!t || typeof price !== 'number' || !isFinite(price)) return { zone: 'unknown', t };

  const low = (typeof t.low === 'number') ? t.low : null;
  const high = (typeof t.high === 'number') ? t.high : null;

  if (low !== null && price <= low) return { zone: 'below', t };
  if (high !== null && price >= high) return { zone: 'above', t };
  return { zone: 'normal', t };
}

function hysteresisGap(ref) {
  const pctGap = (CFG.ALERTS.HYSTERESIS?.pct || 0) / 100;
  const minAbs = CFG.ALERTS.HYSTERESIS?.minAbs || 0;
  const byPct = Math.abs(ref) * pctGap;
  return Math.max(byPct, minAbs);
}

function shouldRearm(price, prevZone, thresholds) {
  if (prevZone !== 'below' && prevZone !== 'above') return true;

  const low = (typeof thresholds.low === 'number') ? thresholds.low : null;
  const high = (typeof thresholds.high === 'number') ? thresholds.high : null;

  if (prevZone === 'below' && low !== null) {
    const gap = hysteresisGap(low);
    return price > (low + gap);
  }
  if (prevZone === 'above' && high !== null) {
    const gap = hysteresisGap(high);
    return price < (high - gap);
  }
  return true;
}

function checkAndNotifyCoin(c, price, chg24) {
  if (!CFG.ALERTS.enabled) return;

  const base = `${CFG.ROOT}.${c.symbol}`;
  const zoneStateId = `${base}.alert.zone`;
  const lastSentId = `${base}.alert.lastSent`;
  const lastMsgId = `${base}.alert.lastMsg`;

  const prevZone = (getState(zoneStateId)?.val || 'unknown') + '';
  const lastSent = getState(lastSentId)?.val || 0;

  const { zone: newZone, t } = getZone(c.symbol, price);
  if (!t) return;

  const now = Date.now();
  const cooldownMs = (CFG.ALERTS.COOLDOWN_MIN || 0) * 60 * 1000;

  // Back to normal only after hysteresis is satisfied
  if (newZone === 'normal' && (prevZone === 'below' || prevZone === 'above')) {
    if (!shouldRearm(price, prevZone, t)) return;

    safeSet(zoneStateId, 'normal');

    if (CFG.ALERTS.notifyBackToNormal) {
      if ((now - lastSent) >= cooldownMs) {
        const msg = `${c.symbol} back to NORMAL: ${formatMoney(price)} ${CFG.VS.toUpperCase()} (24h ${formatPct(chg24)})`;
        sendNotification(msg);
        safeSet(lastSentId, now);
        safeSet(lastMsgId, msg);
      }
    }
    return;
  }

  // Edge-trigger notifications for below/above transitions
  if (newZone === 'below' || newZone === 'above') {
    if (newZone !== prevZone) {
      if ((now - lastSent) < cooldownMs) {
        safeSet(zoneStateId, newZone);
        return;
      }

      const thrVal = (newZone === 'below') ? t.low : t.high;
      const dirText = (newZone === 'below') ? 'BELOW' : 'ABOVE';

      const msg =
        `${c.symbol} crossed ${dirText} threshold (${formatMoney(thrVal)} ${CFG.VS.toUpperCase()}): ` +
        `now ${formatMoney(price)} ${CFG.VS.toUpperCase()} (24h ${formatPct(chg24)})`;

      sendNotification(msg);
      safeSet(zoneStateId, newZone);
      safeSet(lastSentId, now);
      safeSet(lastMsgId, msg);
      return;
    }
    return;
  }

  if (newZone === 'normal' && prevZone !== 'normal') safeSet(zoneStateId, 'normal');
}

/** =========================
 * VIS Mini Widget (HTML)
 * - Uses 24h change percentage for arrow direction
 * ========================= */
function arrowInfo(chgPct) {
  if (typeof chgPct !== 'number' || !isFinite(chgPct)) return { arrow: '•', cls: 'neu' };
  if (chgPct > 0) return { arrow: '▲', cls: 'up' };
  if (chgPct < 0) return { arrow: '▼', cls: 'down' };
  return { arrow: '■', cls: 'flat' };
}

function renderCryptoMiniWidget() {
  const cur = CFG.VS.toUpperCase();

  const rows = CFG.COINS.map(c => {
    const base = `${CFG.ROOT}.${c.symbol}`;
    const price = readNum(`${base}.price`);
    const chg = readNum(`${base}.change24hPct`);

    const a = arrowInfo(chg);

    return `
      <div class="fc-row">
        <div class="fc-left">
          <div class="fc-sym">${escHtml(c.symbol)}</div>
          <div class="fc-name">${escHtml(c.name || c.symbol)}</div>
        </div>

        <div class="fc-right">
          <div class="fc-price">${escHtml(formatMoney(price))} <span class="fc-cur">${escHtml(cur)}</span></div>
          <div class="fc-chg ${a.cls}">
            <span class="fc-arrow">${a.arrow}</span>
            <span class="fc-pct">${escHtml(formatPct(chg))}</span>
          </div>
        </div>
      </div>
    `.trim();
  }).join('');

  return `
  <div class="fc-card">
    <div class="fc-head">
      <div class="fc-title">Crypto</div>
      <div class="fc-sub">24h Change</div>
    </div>

    <div class="fc-body">
      ${rows}
    </div>
  </div>

  <style>
    .fc-card{
      background: var(--card, rgba(255,255,255,0.06));
      border: 1px solid var(--border, rgba(255,255,255,0.10));
      border-radius: 14px;
      padding: 10px 12px;
      color: var(--text, #e9eef5);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      width: 100%;
      box-sizing: border-box;
    }
    .fc-head{ display:flex; align-items:baseline; justify-content:space-between; margin-bottom:8px; }
    .fc-title{ font-weight: 700; font-size: 14px; letter-spacing: .2px; }
    .fc-sub{ font-size: 12px; opacity:.75; }

    .fc-body{ display:flex; flex-direction:column; gap:8px; }

    .fc-row{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 12px;
      background: var(--rowbg, rgba(0,0,0,0.18));
    }

    .fc-left{ display:flex; flex-direction:column; min-width: 120px; }
    .fc-sym{ font-weight:700; font-size:13px; line-height:1.1; }
    .fc-name{ font-size:12px; opacity:.75; line-height:1.1; }

    .fc-right{ display:flex; flex-direction:column; align-items:flex-end; gap:2px; }
    .fc-price{ font-weight:700; font-size:13px; line-height:1.1; }
    .fc-cur{ font-size:11px; opacity:.75; margin-left:2px; }

    .fc-chg{ font-size:12px; display:flex; align-items:center; gap:6px; }
    .fc-arrow{ font-size:12px; width:14px; text-align:center; }

    /* Arrow colors */
    .fc-chg.up   { color: var(--ok, #31d17c); }   /* green */
    .fc-chg.down { color: var(--err, #ff4d4d); }  /* red */
    .fc-chg.flat { color: var(--warn, #ffcc66); } /* yellow */
    .fc-chg.neu  { color: rgba(233,238,245,.65); }/* neutral */

    @media (max-width: 420px){
      .fc-left{ min-width: 92px; }
      .fc-row{ padding: 8px 8px; }
    }
  </style>
  `.trim();
}

function writeHtmlIfChanged(html) {
  const old = readStr(CFG.OUT_HTML);
  if (old === html) return;
  setState(CFG.OUT_HTML, html, true);
}

/** =========================
 * State Initialization
 * ========================= */
function initStates() {
  ensureState(`${CFG.ROOT}.meta.source`, { type: 'string', role: 'text', read: true, write: false, def: 'coingecko' });
  ensureState(`${CFG.ROOT}.meta.lastUpdate`, { type: 'number', role: 'value.time', read: true, write: false });
  ensureState(`${CFG.ROOT}.meta.lastOk`, { type: 'number', role: 'value.time', read: true, write: false });
  ensureState(`${CFG.ROOT}.meta.lastError`, { type: 'string', role: 'text', read: true, write: false });

  ensureState(CFG.OUT_HTML, { type: 'string', role: 'html', read: true, write: false });

  for (const c of CFG.COINS) {
    const base = `${CFG.ROOT}.${c.symbol}`;
    ensureState(`${base}.price`, { type: 'number', role: 'value', read: true, write: false });
    ensureState(`${base}.change24hPct`, { type: 'number', role: 'value', read: true, write: false });
    ensureState(`${base}.updatedAt`, { type: 'number', role: 'value.time', read: true, write: false });
    ensureState(`${base}.currency`, { type: 'string', role: 'text', read: true, write: false, def: CFG.VS.toUpperCase() });

    // Alert states (persist across restarts)
    ensureState(`${base}.alert.zone`, { type: 'string', role: 'text', read: true, write: false, def: 'unknown' }); // below|normal|above|unknown
    ensureState(`${base}.alert.lastSent`, { type: 'number', role: 'value.time', read: true, write: false });
    ensureState(`${base}.alert.lastMsg`, { type: 'string', role: 'text', read: true, write: false });
  }
}

/** =========================
 * Scheduler Loop
 * ========================= */
function scheduleNext(ms) {
  setTimeout(tick, Math.max(250, ms));
}

function tick() {
  if (inFlight) return scheduleNext(500);
  inFlight = true;

  const url = buildUrl();
  httpGetJson(url, (err, status, body, json) => {
    inFlight = false;
    safeSet(`${CFG.ROOT}.meta.lastUpdate`, Date.now());

    if (err) {
      const msg = `[Crypto] HTTP error: ${err.message}`;
      safeSet(`${CFG.ROOT}.meta.lastError`, msg);
      logOnce(msg, 'warn');
      backoffMs = backoffMs ? Math.min(backoffMs * 2, 30 * 60 * 1000) : 60 * 1000;
      return scheduleNext(backoffMs + Math.floor(Math.random() * 1500));
    }

    if (status === 429) {
      const msg = `[Crypto] HTTP 429 (rate limit). Increasing backoff.`;
      safeSet(`${CFG.ROOT}.meta.lastError`, msg);
      logOnce(msg, 'warn');
      backoffMs = backoffMs ? Math.min(backoffMs * 2, 30 * 60 * 1000) : 2 * 60 * 1000;
      return scheduleNext(backoffMs + Math.floor(Math.random() * 2000));
    }

    if (status !== 200 || !json) {
      const msg = `[Crypto] HTTP ${status}: ${String(body).slice(0, 160)}`;
      safeSet(`${CFG.ROOT}.meta.lastError`, msg);
      logOnce(msg, 'warn');
      backoffMs = backoffMs ? Math.min(backoffMs * 2, 30 * 60 * 1000) : 60 * 1000;
      return scheduleNext(backoffMs + Math.floor(Math.random() * 1500));
    }

    try {
      // Update values + alerts
      for (const c of CFG.COINS) {
        const o = json[c.id];
        const base = `${CFG.ROOT}.${c.symbol}`;

        const price = o ? o[CFG.VS] : null;
        const chg = o ? o[`${CFG.VS}_24h_change`] : null;
        const upd = o ? o.last_updated_at : null;

        safeSet(`${base}.price`, (typeof price === 'number') ? price : null);
        safeSet(`${base}.change24hPct`, (typeof chg === 'number') ? chg : null);
        safeSet(`${base}.updatedAt`, (typeof upd === 'number') ? (upd * 1000) : null);
        safeSet(`${base}.currency`, CFG.VS.toUpperCase());

        checkAndNotifyCoin(c, (typeof price === 'number') ? price : null, (typeof chg === 'number') ? chg : null);
      }

      safeSet(`${CFG.ROOT}.meta.source`, 'coingecko');
      safeSet(`${CFG.ROOT}.meta.lastOk`, Date.now());
      safeSet(`${CFG.ROOT}.meta.lastError`, '');

      // Render + write VIS widget HTML (only if changed)
      const html = renderCryptoMiniWidget();
      writeHtmlIfChanged(html);

      backoffMs = 0;
      return scheduleNext(CFG.INTERVAL_SEC * 1000 + Math.floor(Math.random() * 1200));

    } catch (e) {
      const msg = `[Crypto] Parse/apply error: ${e.message}`;
      safeSet(`${CFG.ROOT}.meta.lastError`, msg);
      logOnce(msg, 'warn');
      backoffMs = backoffMs ? Math.min(backoffMs * 2, 30 * 60 * 1000) : 60 * 1000;
      return scheduleNext(backoffMs + Math.floor(Math.random() * 1500));
    }
  });
}

// Start
initStates();
tick();
