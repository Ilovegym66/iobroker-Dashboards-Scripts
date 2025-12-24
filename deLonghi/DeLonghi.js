'use strict';
/**************************************************************
 * DeLonghi Dashboard – Axios Read‑Only + Refresh + Retries
 * v2.0.0-public
 * (c) ilovegym66 & chatgpt
 * Zweck
 *  - Reines Lesen (KEINE Brew-/Power-Kommandos)
 *  - Stabile Anmeldung (Gigya → JWT → Ayla) mit form‑urlencoding
 *  - Optionaler Refresh-Ping (app_data_request) vor jedem Poll
 *  - Retries mit Exponential Backoff + Jitter, Keep‑Alive
 *  - 401 → Re‑Login → erneuter Versuch
 *  - Poll‑Lock verhindert Überlappungen
 *  - Default‑1 Theme (CSS/Frame aus States mit Fallback)
 *  - Filter: d580/d581/d702 und d733..d740 (Service/Noise)
 *  - Output: 0_userdata.0.Geraete.Delonghi.Statushtml
 *           + 0_userdata.0.vis.Dashboards.DelonghiHTML
 *
 * Veröffentlichung
 *  - KEINE persönlichen Zugangsdaten im Code.
 *  - Alle Secrets werden aus States oder Umgebungsvariablen gelesen.
 **************************************************************/

const axios = require('axios');
const https = require('https');

/*** =========================
 * Konstanten & Defaults
 * ========================= ***/
const ROOT            = '0_userdata.0.Geraete.Delonghi';
const OUT_HTML        = '0_userdata.0.vis.Dashboards.DelonghiHTML';
const THEME_CSS_DP    = '0_userdata.0.vis.Templates.Default1.css';
const THEME_FRAME_DP  = '0_userdata.0.vis.Templates.Default1.frameHtml';
const TITLE           = 'De’Longhi Dashboard';

// Secrets (States oder ENV); die States werden beim Start (leer) angelegt
const SECRETS_ROOT    = '0_userdata.0.Secrets.Delonghi';
const ENV             = process.env || {};

const DEFAULTS = {
  INTERVAL_MIN: 1,                 // Poll-Intervall in Minuten
  HTTP_TIMEOUT_MS: 20000,          // Request‑Timeout
  HTTP_RETRIES: 2,                 // Anzahl Retries bei Timeout/Netzfehler
  HTTP_BACKOFF_MS: 800,            // Start‑Backoff
  POLL_LOCK_MS: 45000,             // Poll‑Überlappungsschutz
  REFRESH_ON_POLL: true,           // Vor Poll Refresh anstoßen
  REFRESH_DELAY_MS: 2500,          // Wartezeit nach Refresh
  STALE_THRESHOLD_SEC: 300,        // Badge "Veraltet" > 5min
  REFRESH_PROP: 'app_data_request' // Property für Refresh‑Ping
};

// Keep‑Alive Agenten
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 8 });

/*** =========================
 * Laufvariablen
 * ========================= ***/
let SESSION = {};          // Ayla Session inkl. access_token
let DEVICE_DSNS = [];      // Liste der Geräte‑DSNs
let POLLING = false;
let LAST_POLL_TS = 0;

/*** =========================
 * Helpers
 * ========================= ***/
function gv(id){ try{ const s=getState(id); return s ? s.val : null; }catch{ return null; } }
function upsert(id, val){ if (existsState(id)) setState(id, val, true); else createState(id, val, true); }
function ensureSecretStates(){
  const keys = ['username','password','gigya_apiKey','app_id','app_secret'];
  for(const k of keys){
    const id = `${SECRETS_ROOT}.${k}`;
    if (!existsState(id)) createState(id, '', { type:'string', read:true, write:true, name:`DeLonghi ${k}` });
  }
}
function readSecrets(){
  // Reihenfolge: State → ENV → ''
  const s = {};
  s.username   = String(gv(`${SECRETS_ROOT}.username`)     || ENV.DELONGHI_USER       || '');
  s.password   = String(gv(`${SECRETS_ROOT}.password`)     || ENV.DELONGHI_PASS       || '');
  s.apiKey     = String(gv(`${SECRETS_ROOT}.gigya_apiKey`) || ENV.DELONGHI_GIGYA_APIKEY || '');
  s.app_id     = String(gv(`${SECRETS_ROOT}.app_id`)       || ENV.DELONGHI_APP_ID     || '');
  s.app_secret = String(gv(`${SECRETS_ROOT}.app_secret`)   || ENV.DELONGHI_APP_SECRET || '');
  return s;
}
function cfgNum(id, def){ const v = Number(gv(id)); return isFinite(v) && v>0 ? v : def; }
function cfgBool(id, def){ const v = gv(id); if (v === null || v === undefined) return def; return v === true || v === 'true' || v === 1 || v === '1'; }
function delay(ms){ return new Promise(r => setTimeout(r, ms)); }
function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
function isConnected(val){ const s = String(val ?? '').trim().toLowerCase(); return ['1','true','yes','on','connected'].includes(s); }
function prettyKey(name){
  if (!name) return '';
  if (name === 'app_device_status')     return 'Gerätestatus';
  if (name === 'app_device_connected')  return 'App-Verbindung';
  if (name === 'd512_percentage_to_deca') return 'Prozent bis Entkalkung';
  if (name === 'd513_percentage_usage_fltr') return 'Prozent Wasserfilter';
  if (/^d\d+_/.test(name)){
    const parts = name.split('_').slice(1);
    const map = { tot:'Gesamt', bev:'Getränke', qty:'Menge', cnt:'Zähler', time:'Zeit',
      water:'Wasser', espressi:'Espressi', espr:'Espresso', id:'ID',
      capp:'Cappuccino', latte:'Latte', lattmacc:'Latte Macchiato', latte_macch:'Latte Macchiato',
      caffelatte:'Caffè Latte', flat:'Flat', white:'White', hot:'Heiß', milk:'Milch',
      tea:'Tee', coffee:'Kaffee', pot:'Kanne', brew:'Brühen', over:'über', ice:'Eis',
      americano:'Americano', doppio:'Doppio', mix:'Mix', cold:'Kalt', mug:'Becher' };
    return parts.map(p=>map[p]||p.replace(/^[a-z]/,m=>m.toUpperCase())).join(' ');
  }
  return name.replace(/_/g,' ').replace(/^[a-z]/,m=>m.toUpperCase());
}
function pctBar(pct, mode){
  const v = Math.max(0, Math.min(100, Number(pct)||0));
  const col = (mode==='ok') ? 'var(--good, #22c55e)' : (mode==='warn') ? '#eab308' : 'var(--bad, #ef4444)';
  return `<div class="progress"><div style="width:${v}%;height:100%;background:${col}"></div></div><div class="sub mono" style="text-align:right">${v}%</div>`;
}
function themeCssDefaultFallback(){
  return `:root{--bg:#0f1115;--card:#171a21;--muted:#9aa4b2;--text:#e6edf3;--accent:#6ab7ff;--accent2:#8be9fd;--rad:12px;--gap:10px;--shadow:0 10px 24px rgba(0,0,0,.30)}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:radial-gradient(1000px 600px at 10% -10%, #151a22 0%, #0f1115 60%, #0b0d11 100%);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px}
.brand{display:flex;align-items:center;gap:8px;font-weight:700}
.brand-logo{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:var(--shadow)}
.brand-title{font-size:14px;line-height:1.1}
.brand small{color:var(--muted);font-weight:500;display:block;margin-top:1px;font-size:11px}
.pill{padding:4px 8px;border-radius:999px;background:#12151b;color:#cbd5e1;border:1px solid #1d2230;font-size:11px}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:var(--gap);padding:0 12px 20px}
@media(max-width:1200px){.grid{grid-template-columns:repeat(8,1fr)}}
@media(max-width:900px){.grid{grid-template-columns:repeat(6,1fr)}}
@media(max-width:680px){.grid{grid-template-columns:repeat(4,1fr)}}
.card{background:linear-gradient(180deg,rgba(255,255,255,.02),rgba(255,255,255,.008));border:1px solid #1b2030;border-radius:var(--rad);padding:10px;box-shadow:var(--shadow);overflow:hidden}
.card h3{margin:0 0 6px 0;font-size:13px;color:#c7d2e1;font-weight:600;display:flex;gap:8px;align-items:center}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 8px}.kv dt{color:var(--muted);font-size:11px}.kv dd{margin:0;font-variant-numeric:tabular-nums}
.value{font-weight:700;font-size:20px;display:flex;gap:6px;align-items:baseline}
.sub{color:#9aa4b2;font-size:11px}
.progress{width:100%;height:8px;background:#0e1218;border-radius:999px;overflow:hidden;border:1px solid #202638}
.table{width:100%;border-collapse:collapse;border:1px solid #1b2030;border-radius:10px;overflow:hidden}
.table th,.table td{font-size:11.5px;padding:6px 8px;border-bottom:1px solid #1b2030}
.table th{color:#cbd5e1;background:#131823;text-align:left}
.table tr:nth-child(even){background:#11161f}
.tablewrap{max-height:280px; overflow:auto; border:1px solid #1b2030; border-radius:10px}
.badge{padding:1px 6px;border-radius:6px;border:1px solid #2a3145;background:#0f1521;font-size:11px}
.good{color:#22c55e}.bad{color:#ef4444}
.span-6{grid-column:span 6}.span-12{grid-column:span 12}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace}`;
}
function themeFrameDefaultFallback(){
  return '<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>{{TITLE}}</title>{{HEAD}}</head><body><header><div class="brand"><div class="brand-logo"></div><div class="brand-title">{{TITLE}}<br><small>Server-seitig gerendert (Default-1)</small></div></div><div><span class="pill">Stand: {{STAMP}}</span></div></header><main class="grid">{{BODY}}</main><footer>ioBroker · Default-1 Theme · {{STAMP}}</footer></body></html>';
}
function getThemeCss(){ try{ const s=getState(THEME_CSS_DP); if (s && s.val) return String(s.val); }catch{} return themeCssDefaultFallback(); }
function getThemeFrame(){ try{ const s=getState(THEME_FRAME_DP); if (s && s.val) return String(s.val); }catch{} return themeFrameDefaultFallback(); }
function applyTemplate(frame, headCss, bodyHtml, title, stamp){
  return frame.replace(/{{HEAD}}/g, `<style>${headCss}</style>`)
              .replace(/{{BODY}}/g, bodyHtml)
              .replace(/{{TITLE}}/g, String(title||'Dashboard'))
              .replace(/{{STAMP}}/g, String(stamp||''));
}
function getPropUpdatedAt(p){
  const dt = p?.datapoint || {};
  const c1 = dt.created_at || dt.updated_at || p?.updated_at || p?.created_at;
  if (!c1) return 0;
  const t = Date.parse(c1);
  return isNaN(t) ? 0 : t;
}
function isExcluded(name){
  if(!name) return false;
  if (name==='d580_service_parameters' || name==='d581_service_parameters' || name==='d702_tot_bev_other') return true;
  if (name.startsWith('d')){
    const n = parseInt(name.slice(1),10);
    if(!isNaN(n) && n>=733 && n<=740) return true;
  }
  return false;
}
function formEncode(obj){ return Object.keys(obj).map(k => encodeURIComponent(k)+'='+encodeURIComponent(obj[k])).join('&'); }

/*** =========================
 * Axios mit Retries/Backoff
 * ========================= ***/
async function axiosWithRetry(method, url, data, headers){
  const timeout   = cfgNum(`${ROOT}.Config.http_timeout_ms`,  DEFAULTS.HTTP_TIMEOUT_MS);
  const retries   = cfgNum(`${ROOT}.Config.http_retries`,     DEFAULTS.HTTP_RETRIES);
  const backoff0  = cfgNum(`${ROOT}.Config.http_backoff_ms`,  DEFAULTS.HTTP_BACKOFF_MS);

  for (let attempt=0; attempt<=retries; attempt++){
    try{
      const res = await axios({
        method, url, data,
        headers: Object.assign({
          'accept': '*/*',
          'user-agent': 'delonghi/4.7.0 (iPhone; iOS 15.8.3; Scale/2.00)',
          'accept-language': 'de-DE;q=1.0'
        }, headers || {}),
        timeout,
        maxRedirects: 5,
        validateStatus: () => true,
        httpAgent: httpsAgent,
        httpsAgent: httpsAgent
      });

      // 401 → Re-Login und wiederholen (soweit Versuche übrig)
      if (res.status === 401 && attempt < retries){
        log(`🔁 401 bei ${method.toUpperCase()} ${url} – erneutes Login … (Try ${attempt+1}/${retries})`, 'warn');
        await new Promise(resolve => login(resolve));
        continue;
      }

      const body = (typeof res.data === 'string') ? res.data : JSON.stringify(res.data);
      return { ok:true, status: res.status, body };

    }catch(e){
      const msg = e?.message ? String(e.message) : String(e);
      const isTimeout = /timeout/i.test(msg) || e?.code === 'ETIMEDOUT';
      const isNetErr  = isTimeout || e?.code === 'ECONNRESET' || e?.code === 'EAI_AGAIN';

      if (attempt < retries && isNetErr){
        const wait = backoff0 * Math.pow(2, attempt) + Math.floor(Math.random()*250);
        log(`⚠️ ${method.toUpperCase()} ${url} fehlgeschlagen (${msg}) – Retry in ${wait}ms (Try ${attempt+1}/${retries})`, 'warn');
        await delay(wait);
        continue;
      }
      log(`❌ Fehler bei ${method.toUpperCase()} ${url}: ${msg}`, 'error');
      return { ok:false, status: 0, body:'{}' };
    }
  }
  return { ok:false, status: 0, body:'{}' };
}

// Wrapper kompatibel zur alten Callback-Signatur
async function httpGet(url, headers, cb){ const r = await axiosWithRetry('get', url, undefined, headers); cb(r.body); }
async function httpPost(url, data, headers, cb){ const r = await axiosWithRetry('post', url, data, headers); cb(r.body, r.status); }
async function httpPostForm(url, dataObj, headers, cb){
  const r = await axiosWithRetry('post', url, formEncode(dataObj), Object.assign({'Content-Type':'application/x-www-form-urlencoded'}, headers||{}));
  cb(r.body, r.status);
}

/*** =========================
 * HTML Rendering
 * ========================= ***/
function buildCard({ id, name, appStatus, appConnected, rows, sums, percents, staleAgeSec }){
  const connected = isConnected(appConnected);
  const bConn  = connected ? `<span class="badge good">🟢 Verbunden</span>` : `<span class="badge bad">🔴 Offline</span>`;
  const bStat  = `<span class="badge">📟 ${escapeHtml(appStatus || 'unbekannt')}</span>`;
  const staleT = cfgNum(`${ROOT}.Config.stale_threshold_sec`, DEFAULTS.STALE_THRESHOLD_SEC);
  const bStale = (typeof staleAgeSec==='number' && staleAgeSec > staleT)
      ? `<span class="badge" style="border-color:#eab308;color:#eab308">⏳ Veraltet ~ ${Math.round(staleAgeSec/60)} min</span>` : '';

  const pctBlocks = [];
  if (typeof percents?.d512 === 'number'){
    const mode = percents.d512 >= 60 ? 'ok' : (percents.d512 >= 30 ? 'warn' : 'err');
    pctBlocks.push(`<dt>Prozent bis Entkalkung</dt><dd>${pctBar(percents.d512, mode)}</dd>`);
  }
  if (typeof percents?.d513 === 'number'){
    const mode = percents.d513 >= 60 ? 'ok' : (percents.d513 >= 30 ? 'warn' : 'err');
    pctBlocks.push(`<dt>Prozent Wasserfilter</dt><dd>${pctBar(percents.d513, mode)}</dd>`);
  }

  const sumItems = Object.entries(sums||{})
    .sort((a,b)=>a[0].localeCompare(b[0])).slice(0,8)
    .map(([k,v])=>{
      let val=v, unit='';
      if(/qty|water/i.test(k)){ val=(v/1000).toFixed(2); unit=' L'; }
      else if(/time/i.test(k)){ val=(v/60).toFixed(0);   unit=' min'; }
      return `<dt>🧮 ${escapeHtml(prettyKey(k))}</dt><dd class="mono">${escapeHtml(val)}${unit}</dd>`;
    });

  const tableRows = (rows&&rows.length)
    ? rows.map(r=>{
        const isPct=(r.name==='d512_percentage_to_deca'||r.name==='d513_percentage_usage_fltr');
        const valCell = isPct ? String(r.value) : escapeHtml(String(r.value));
        return `<tr><td title="${escapeHtml(r.name)}">${escapeHtml(prettyKey(r.name))}</td><td class="mono">${valCell}</td></tr>`;
      }).join('')
    : `<tr><td colspan="2" style="opacity:.6">Keine d500+ Werte</td></tr>`;

  return `
  <section class="card span-6">
    <div style="padding:14px 16px;border-bottom:1px solid #1b2030;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <div class="title">☕ ${escapeHtml(name)}</div>
      <div class="badges">${bConn}${bStat}${bStale}</div>
    </div>
    <div class="card-body">
      <div class="section-title">📊 Summen</div>
      <dl class="kv">
        ${pctBlocks.join('')}
        ${sumItems.join('') || `<dt class="muted">Summen</dt><dd class="muted">—</dd>`}
      </dl>
      <div class="section-title" style="margin-top:14px;">🧾 Status (d500+)</div>
      <div class="tablewrap">
        <table class="table">
          <thead><tr><th>Name</th><th>Wert</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>
    <div style="padding:10px 16px 14px;border-top:1px solid #1b2030;color:#9aa4b2;font-size:12px;display:flex;justify-content:space-between">
      <span class="dev-id">ID: ${escapeHtml(id)}</span>
    </div>
  </section>`;
}

function renderDashboard(cards){
  const now   = new Date();
  const stamp = now.toLocaleString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
  const css   = getThemeCss();
  const head  = `${css}\n.mono{font-variant-numeric:tabular-nums}`;
  const body  = (cards||[]).join('');
  const frame = getThemeFrame();
  const html  = applyTemplate(frame, head, body, TITLE, stamp);
  upsert(`${ROOT}.Statushtml`, html);
  upsert(OUT_HTML, html);
}

/*** =========================
 * Geräte & Polling
 * ========================= ***/
function getDevices(cb){
  httpGet('https://ads-eu.aylanetworks.com/apiv1/devices.json', {authorization:'auth_token '+SESSION.access_token}, (res)=>{
    try{
      const data = JSON.parse(res);
      DEVICE_DSNS = [];
      for(const d of data){
        const id   = d?.device?.dsn;
        const name = d?.device?.product_name;
        if(!id) continue;
        DEVICE_DSNS.push(id);
        if (name) upsert(`${ROOT}.${id}.Name`, name);
      }
      log(`🔍 ${DEVICE_DSNS.length} Gerät(e) gefunden`, 'info');
      cb();
    }catch(e){ log('❌ Fehler beim Geräteabruf: '+e, 'error'); }
  });
}

// Optionaler Refresh → 'app_data_request'
function refreshDevice(dsn, token, cb){
  const url = `https://ads-eu.aylanetworks.com/apiv1/dsns/${dsn}/properties/${DEFAULTS.REFRESH_PROP}/datapoints.json`;
  const headers = { authorization:'auth_token '+SESSION.access_token, 'Content-Type':'application/json' };
  const data = { datapoint:{ value:String(token) } };
  httpPost(url, data, headers, (_body, status)=>{
    if (status === 404 || status === 400){
      log(`ℹ️ ${dsn}: ${DEFAULTS.REFRESH_PROP} nicht verfügbar (status=${status}).`, 'warn');
    } else {
      log(`🔔 Refresh ${DEFAULTS.REFRESH_PROP} → ${dsn} (status=${status}).`, 'info');
    }
    cb();
  });
}

function fetchDevice(dsn, cbDone){
  httpGet(`https://ads-eu.aylanetworks.com/apiv1/dsns/${dsn}/properties.json`, { authorization:'auth_token '+SESSION.access_token }, (body)=>{
    if (!body || body.trim()===''){ log(`❌ Leere Antwort für ${dsn}`, 'error'); return cbDone(null); }
    let parsed; try{ parsed=JSON.parse(body); }catch(e){ log(`❌ Ungültiges JSON für ${dsn}: ${e}`, 'error'); return cbDone(null); }

    let props=[];
    if (Array.isArray(parsed)) props=parsed;
    else if (parsed?.properties) props=parsed.properties;
    else if (parsed?.property) props=[parsed];
    else { log(`⚠️ Unerwartetes Format für ${dsn}`, 'warn'); return cbDone(null); }

    let appStatus='', appConnected=''; const tableRows=[]; const sums={}; const percents={ d512:undefined, d513:undefined };
    let d701_val=null; let newestTs=0;

    for (const item of props){
      if (!item || typeof item!=='object') continue;
      const p = item.property || item;
      const name  = typeof p.name==='string' ? p.name : 'unbekannt';
      const value = Object.prototype.hasOwnProperty.call(p,'value') ? p.value : 'null';

      newestTs = Math.max(newestTs, getPropUpdatedAt(p));

      if (name==='app_device_status'){ appStatus=String(value??''); upsert(`${ROOT}.${dsn}.Status.${name}`, appStatus); continue; }
      if (name==='app_device_connected'){ appConnected=String(value??''); upsert(`${ROOT}.${dsn}.Status.${name}`, appConnected); continue; }
      if (isExcluded(name)) continue;

      if (name==='d701'){
        const num701 = (typeof value==='number')?value:parseFloat(value);
        if (!isNaN(num701)) d701_val = num701;
      }
      if (name==='d512_percentage_to_deca'){ const n = Number(value); if(!isNaN(n)) percents.d512=n; }
      if (name==='d513_percentage_usage_fltr'){ const n = Number(value); if(!isNaN(n)) percents.d513=n; }

      if (name && name.startsWith('d')){
        const n = parseInt(name.slice(1),10);
        if (!isNaN(n) && n>=500){
          upsert(`${ROOT}.${dsn}.Status.${name}`, value);
          tableRows.push({ name, value });
          const numeric = (typeof value==='number') ? value : parseFloat(value);
          if (!isNaN(numeric) && /_tot_|_qty_|_cnt_/i.test(name)){
            sums[name] = (sums[name] || 0) + numeric;
          }
        }
      }
    }
    if (d701_val !== null) sums['d701'] = (sums['d701'] || 0) + d701_val;

    let friendly = gv(`${ROOT}.${dsn}.Name`) || dsn;
    if (friendly==='AC000W030821349' || dsn==='AC000W030821349') friendly='De Longhi Eletta Explore 486';

    const staleSec = newestTs ? Math.max(0, Math.round((Date.now()-newestTs)/1000)) : undefined;
    cbDone(buildCard({ id: dsn, name: friendly, appStatus, appConnected, rows: tableRows, sums, percents, staleAgeSec: staleSec }));
  });
}

function refreshThenFetch(dsn, cb){
  const enabled = cfgBool(`${ROOT}.Config.refresh_on_poll`, DEFAULTS.REFRESH_ON_POLL);
  const delayMs = cfgNum(`${ROOT}.Config.refresh_delay_ms`, DEFAULTS.REFRESH_DELAY_MS);
  if (!enabled) return fetchDevice(dsn, cb);
  const token = 'poll:'+Date.now();
  refreshDevice(dsn, token, ()=> setTimeout(()=> fetchDevice(dsn, cb), delayMs));
}

function updateDevices(){
  const lockMs = cfgNum(`${ROOT}.Config.poll_lock_timeout_ms`, DEFAULTS.POLL_LOCK_MS);
  const now = Date.now();
  if (POLLING){
    if (now - LAST_POLL_TS < lockMs){ log('⏳ Poll übersprungen (Lock aktiv).', 'warn'); return; }
    log('⚠️ Vorheriger Poll hing – Lock aufgehoben.', 'warn');
    POLLING=false;
  }
  POLLING=true; LAST_POLL_TS = now;

  if (!Array.isArray(DEVICE_DSNS) || DEVICE_DSNS.length===0){
    const msg = '<div style="color:#fff;background:#1e1e1e;padding:14px;font-family:sans-serif">Keine Geräte gefunden.</div>';
    upsert(`${ROOT}.Statushtml`, msg); upsert(OUT_HTML, msg);
    POLLING=false; return;
  }

  const cards=[]; let pending = DEVICE_DSNS.length;
  for (const dsn of DEVICE_DSNS){
    refreshThenFetch(dsn, (card)=>{
      if (card) cards.push(card);
      pending--;
      if (pending===0){ renderDashboard(cards); POLLING=false; }
    });
  }
}

/*** =========================
 * Login (Gigya → JWT → Ayla)
 * ========================= ***/
function login(cb){
  const { username, password, apiKey, app_id, app_secret } = readSecrets();
  if (!username || !password || !apiKey || !app_id || !app_secret){
    log('❌ Secrets fehlen (username/password/apiKey/app_id/app_secret). Bitte States unter 0_userdata.0.Secrets.Delonghi befüllen.', 'error');
    return cb && cb();
  }

  // 1) Gigya Login
  const loginUrl  = 'https://accounts.eu1.gigya.com/accounts.login';
  const loginBody = { apiKey, loginID: username, password, sessionExpiration: 7776000, targetEnv: 'mobile', include: 'profile,data', site: 'eu1' };

  httpPostForm(loginUrl, loginBody, {}, (res1)=>{
    let loginData;
    try{ loginData = JSON.parse(res1); }catch{}
    const sess = loginData?.sessionInfo;
    if (!sess){ log('❌ Login fehlgeschlagen (Gigya).', 'error'); return cb && cb(); }

    // 2) getJWT mit sessionSecret
    const jwtUrl  = 'https://accounts.eu1.gigya.com/accounts.getJWT';
    const jwtBody = { apiKey, secret: sess.sessionSecret, expiration: 7776000 };
    httpPostForm(jwtUrl, jwtBody, { authorization: 'Bearer '+sess.sessionToken }, (res2)=>{
      let jwtData; try{ jwtData = JSON.parse(res2); }catch{}
      const idToken = jwtData?.id_token;
      if (!idToken){ log('❌ Fehler bei JWT (Gigya).', 'error'); return cb && cb(); }

      // 3) Ayla token_sign_in
      const aylaUrl = 'https://user-field-eu.aylanetworks.com/api/v1/token_sign_in';
      const body    = { app_id, app_secret, token: idToken };
      httpPost(aylaUrl, body, {
        accept:'application/json', 'content-type':'application/json',
        'user-agent':'delonghi/13 CFNetwork/1335.0.3.4 Darwin/21.6.0', 'accept-language':'de-DE,de;q=0.9'
      }, (res3)=>{
        try{
          SESSION = JSON.parse(res3);
          if (!SESSION?.access_token) throw new Error('Kein access_token');
          log('✅ Login erfolgreich', 'info');
          cb && cb();
        }catch(e){
          log('❌ Fehler beim Parsen Ayla Antwort: '+e, 'error');
          cb && cb();
        }
      });
    });
  });
}

/*** =========================
 * Start
 * ========================= ***/
(function main(){
  // Secret‑States anlegen (leer)
  ensureSecretStates();

  // Config‑States (falls nicht vorhanden)
  const CFG = [
    ['refresh_on_poll',        DEFAULTS.REFRESH_ON_POLL,   { type:'boolean', role:'switch', name:'Refresh (app_data_request) vor Poll' }],
    ['refresh_delay_ms',       DEFAULTS.REFRESH_DELAY_MS,  { type:'number', role:'value',  name:'Wartezeit nach Refresh (ms)' }],
    ['http_timeout_ms',        DEFAULTS.HTTP_TIMEOUT_MS,   { type:'number', role:'value',  name:'HTTP Timeout (ms)' }],
    ['http_retries',           DEFAULTS.HTTP_RETRIES,      { type:'number', role:'value',  name:'HTTP Retries' }],
    ['http_backoff_ms',        DEFAULTS.HTTP_BACKOFF_MS,   { type:'number', role:'value',  name:'HTTP Backoff Start (ms)' }],
    ['poll_lock_timeout_ms',   DEFAULTS.POLL_LOCK_MS,      { type:'number', role:'value',  name:'Poll‑Lock Timeout (ms)' }],
    ['stale_threshold_sec',    DEFAULTS.STALE_THRESHOLD_SEC, { type:'number', role:'value', name:'Stale‑Schwelle (Sek.)' }],
    ['interval_min',           DEFAULTS.INTERVAL_MIN,      { type:'number', role:'value',  name:'Poll‑Intervall (Minuten)' }],
  ];
  for (const [k,def,meta] of CFG){
    const id = `${ROOT}.Config.${k}`;
    if (!existsState(id)) createState(id, def, Object.assign({ read:true, write:true }, meta));
  }

  // Login → Devices → erster Poll → Intervall
  login(()=>{
    getDevices(()=>{
      updateDevices();
      const everyMin = Math.max(1, cfgNum(`${ROOT}.Config.interval_min`, DEFAULTS.INTERVAL_MIN));
      schedule(`*/${everyMin} * * * *`, updateDevices);
    });
  });
})();
