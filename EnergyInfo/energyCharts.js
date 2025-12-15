/**
 * Energy-Charts → ioBroker (Public Power DE) + Default-1 Dashboard
 * Version: 1.5.0 (2025-11-02)
 * (c) ilovegym
 *
 * States:
 *   Basis: 0_userdata.0.Energy-Charts.*
 *   Dashboard HTML: 0_userdata.0.Energy-Charts.Dashboard.HTML (voll gerendert mit Default-1)
 *
 * Voraussetzungen:
 *   - COUNTRY muss lowercase sein (z. B. 'de')
 *   - Default-1 Theme liegt in:
 *       0_userdata.0.vis.Templates.Default1.css
 *       0_userdata.0.vis.Templates.Default1.frameHtml
 */

'use strict';

const ROOT         = '0_userdata.0.Strom.Energy-Charts';
const COUNTRY      = 'de';          // lowercase!
const HOURS_BACK   = 48;            // Zeitraum rückwärts (h)
const INTERVAL_MIN = 59;            // 1..59 (Cron)
const VERIFY_SSL   = true;
const LOG_PREFIX   = '⚡ Energy-Charts';
const LAST_GOOD_HTML_DP = `${ROOT}.Dashboard.LastGoodHTML`;

// Anzeige-Optionen
const SHOW_ALL_ROWS  = true;  // true = alle verfügbaren Reihen anzeigen
const DASH_MAX_ROWS  = 15;    // nur relevant, wenn SHOW_ALL_ROWS = false

// *** VIS/Minuvis: schlanker separater Branch NUR fürs Rendering ***
const VIS_ROOT               = '0_userdata.0.vis.Pages.Energy-Charts';
const DASH_HTML_DP           = `${VIS_ROOT}.Dashboard.HTML`;
const LAST_GOOD_HTML_VIS_DP  = `${VIS_ROOT}.Dashboard.LastGoodHTML`;
const MINUVIS_DP             = `${VIS_ROOT}.Dashboard.MinuvisHTML`;

// Große Rohdaten abstellen (verhindert weiße Screens bei mehreren Pages)
const STORE_RAW    = false;   // raw JSON NICHT in States ablegen
const STORE_SERIES = false;   // series.*.json NICHT in States ablegen

const SPARK_POINTS = 48;

// Schriftgrößen (Pixel) – nach Geschmack anpassen
const EC_FONT_BASE_PX   = 14;
const EC_TITLE_PX       = 16;
const EC_VALUE_PX       = 26;
const EC_TABLE_PX       = 13;
const EC_BADGE_PX       = 12;

// Default-1 Template-Quellen
const THEME_CSS_DP   = '0_userdata.0.vis.Templates.Default1.css';
const THEME_FRAME_DP = '0_userdata.0.vis.Templates.Default1.frameHtml';

const ENDPOINT_BASE  = 'https://api.energy-charts.info';
const https = require('https');

// ---------- Logging ----------
function logI(m){ log(`${LOG_PREFIX}: ${m}`,'info'); }
function logW(m){ log(`${LOG_PREFIX}: ${m}`,'warn'); }
function logE(m){ log(`${LOG_PREFIX}: ${m}`,'error'); }

// ---------- ioBroker Helpers (GlobalTools Wrapper) ----------
// GlobalTools vorhanden: ensureState, setStateIfChanged, getStr/getNum/getBool/getSafeState

function _setIfChanged(id, val, ack=true){
  try{
    if (typeof setStateIfChanged === 'function') setStateIfChanged(id, val, ack);
    else setState(id, val, ack);
  }catch(e){
    try{ setState(id, val, ack); }catch(e2){}
  }
}

function writeStr(id, val){
  // Legacy ensureState braucht Initialwert als 3. Arg
  ensureState(id, {type:'string',role:'text',read:true,write:true,def:''}, '');
  _setIfChanged(id, String(val), true);
}

function writeNum(id, val, unit){
  ensureState(id, {type:'number',role:'value',unit:unit||'',read:true,write:true,def:0}, 0);
  const v = (val==null || isNaN(val)) ? null : Number(val);
  _setIfChanged(id, v, true);
}

function writeBool(id,val){
  ensureState(id, {type:'boolean',role:'indicator',read:true,write:true,def:false}, false);
  _setIfChanged(id, !!val, true);
}

function gv(dp){
  try{
    if (typeof getStr === 'function') return getStr(dp, '');
    const s=getState(dp); return s&&s.val!=null ? String(s.val) : '';
  }catch(e){ return ''; }
}

function sanitizeId(name) {
  return String(name)
    .replace(/[()]/g,'')
    .replace(/[^\wäöüÄÖÜß\-\.]/g,'_')
    .replace(/_+/g,'_')
    .replace(/\.$/,'')
    .toLowerCase();
}

function fmtMW(x){
  if(x==null||isNaN(x))return '—';
  try{return Number(x).toLocaleString('de-DE',{maximumFractionDigits:0});}
  catch{return String(Math.round(Number(x)));}
}

// ---------- Debug ----------
function storeDebug(root, {url, status, err, bytes, preview}) {
  writeStr(`${root}.Info.LastURL`, url||'');
  if (typeof status==='number') writeNum(`${root}.Info.LastHTTP`, status);
  writeStr(`${root}.Info.LastError`, err||'');
  if (typeof bytes==='number') writeNum(`${root}.Info.LastBytes`, bytes,'B');
  writeStr(`${root}.Info.LastPayloadPreview`, preview||'');
}

// ---------- HTTP ----------
function httpGetJSON(urlStr, timeoutMs=15000, verify=true){
  return new Promise((resolve)=>{
    try{
      const agent = new https.Agent({rejectUnauthorized: verify});
      const req = https.get(urlStr, {agent, timeout: timeoutMs, headers:{
        'User-Agent':'ioBroker Energy-Charts Script','Accept':'application/json','Accept-Encoding':'identity'
      }}, res=>{
        let data=''; res.on('data',c=>data+=c);
        res.on('end', ()=>{
          const status = res.statusCode||0; const bytes = Buffer.byteLength(data||'','utf8');
          if (status>=200 && status<300){
            try{ resolve({ok:true,status, json: JSON.parse(data), raw:data, bytes}); }
            catch(e){ resolve({ok:false,status,error:`JSON parse error: ${e.message}`, raw:data, bytes}); }
          } else resolve({ok:false,status,error:`HTTP ${status}: ${String(data).slice(0,600)}`, raw:data, bytes});
        });
      });
      req.on('timeout',()=>req.destroy(new Error('request timeout')));
      req.on('error',err=>resolve({ok:false,status:0,error:String(err),raw:'',bytes:0}));
    }catch(err){ resolve({ok:false,status:0,error:String(err),raw:'',bytes:0}); }
  });
}
function unixSecondsNow(){ return Math.floor(Date.now()/1000); }

async function fetchPublicPower(country){
  const c = String(country).toLowerCase();
  const end = unixSecondsNow(), start = end - HOURS_BACK*3600;
  const url = `${ENDPOINT_BASE}/public_power?country=${encodeURIComponent(c)}&start=${start}&end=${end}`;
  logI(`Abruf: ${url}`);
  let r = await httpGetJSON(url,15000,VERIFY_SSL);
  if(!r.ok && /self signed|unable to verify|certificate|CERT/i.test(r.error||'')){
    logW('SSL-Problem erkannt – versuche ohne Zert-Prüfung …');
    r = await httpGetJSON(url,15000,false);
  }
  storeDebug(ROOT,{url,status:r.status,err:r.ok?'':r.error,bytes:r.bytes,preview:String(r.raw||'').slice(0,3000)});
  if(!r.ok) throw new Error(r.error||'Request failed');
  return r.json;
}

// ---------- Serien-Helpers ----------
const LENGTH_TOLERANCE = 3;
function findLatestNumber(arr){
  for(let i=arr.length-1;i>=0;i--){
    const v=arr[i];
    if(typeof v==='number' && isFinite(v)) return v;
  }
  return null;
}

// Schöne deutsche Labels + Icons
function prettyLabel(name){
  const key = String(name).toLowerCase().trim();
  const map = {
    'solar':                     {label:'Solar',                       icon:'☀️'},
    'wind onshore':              {label:'Wind (Onshore)',              icon:'🌬️'},
    'wind offshore':             {label:'Wind (Offshore)',             icon:'🌊🌬️'},
    'nuclear':                   {label:'Kernenergie',                 icon:'⚛️'},
    'biomass':                   {label:'Biomasse',                    icon:'🌿'},
    'geothermal':                {label:'Geothermie',                  icon:'♨️'},
    'waste':                     {label:'Abfall',                      icon:'🗑️'},
    'other renewable':           {label:'Sonstige erneuerbare',        icon:'♻️'},
    'other':                     {label:'Sonstige',                    icon:'🧩'},
    'hydro run-of-river and poundage': {label:'Wasserkraft (Laufwasser)', icon:'💧'},
    'hydro water reservoir':           {label:'Wasserkraft (Speicher)',   icon:'🏔️💧'},
    'hydro pumped storage':            {label:'Pumpspeicher (Erzeugung)', icon:'🔋⬆️'},
    'hydro pumped storage consumption':{label:'Pumpspeicher (Verbrauch)', icon:'🔋⬇️'},
    'fossil brown coal/lignite': {label:'Braunkohle',                  icon:'🪨'},
    'fossil hard coal':          {label:'Steinkohle',                  icon:'⛏️'},
    'gas':                       {label:'Erdgas',                      icon:'🔥'},
    'oil':                       {label:'Öl',                          icon:'🛢️'}
  };
  if (map[key]) return map[key];
  if (key.includes('wind') && key.includes('offshore')) return map['wind offshore'];
  if (key.includes('wind')) return map['wind onshore'];
  if (key.includes('hydro') && key.includes('consumption')) return map['hydro pumped storage consumption'];
  if (key.includes('hydro') && key.includes('pumped') && key.includes('storage')) return map['hydro pumped storage'];
  if (key.includes('hydro') && key.includes('reservoir')) return map['hydro water reservoir'];
  if (key.includes('hydro') && (key.includes('river')||key.includes('poundage'))) return map['hydro run-of-river and poundage'];
  if (key.includes('brown coal')||key.includes('lignite')) return map['fossil brown coal/lignite'];
  if (key.includes('hard coal')) return map['fossil hard coal'];
  if (key.includes('renewable')) return map['other renewable'];
  return {label:name, icon:'🔹'};
}

// ---------- Speicherung + Dashboard ----------
function storePublicPower(root, payload){
  const base = `${root}.PublicPower`;

  // Rohdaten & Meta
  if (STORE_RAW) {
    ensureState(`${base}.raw`, {type:'string', role:'json', read:true, write:false, def:''}, '');
    _setIfChanged(`${base}.raw`, JSON.stringify(payload), true);
  }
  if (typeof payload?.deprecated === 'boolean') writeBool(`${base}.deprecated`, payload.deprecated);
  if (typeof payload?.substitute === 'boolean') writeBool(`${base}.substitute`, payload.substitute);
  writeStr(`${base}.lastFetchISO`, new Date().toISOString());

  const ts = Array.isArray(payload?.unix_seconds) ? payload.unix_seconds : null;
  if (ts?.length) writeNum(`${base}.lastTimestamp`, ts[ts.length-1], 's');

  const sources = [];

  // production_types [{name, data}]
  if (Array.isArray(payload?.production_types) && payload.production_types.length){
    for (const pt of payload.production_types){
      const name = pt?.name || 'unknown';
      const data = Array.isArray(pt?.data) ? pt.data : null;
      if (!data || data.length < 4) continue;
      if (ts && data.length < (ts.length - LENGTH_TOLERANCE)) continue;

      const safe   = sanitizeId(name);
      const latest = findLatestNumber(data);

      writeNum(`${base}.latest.${safe}`, latest, 'MW');

      if (STORE_SERIES) {
        writeStr(`${base}.series.${safe}.json`, JSON.stringify({ unix_seconds: ts||null, values: data }));
      }

      const tail = data.filter(v=>typeof v==='number'&&isFinite(v)).slice(-SPARK_POINTS);
      sources.push({ key:name, safe, latest:Number(latest), tail });
    }
  }

  writeStr(`${root}.Info.SeriesKeys`, sources.map(s=>s.key).join(', '));
  writeNum(`${root}.Info.SeriesCount`, sources.length);
  writeNum(`${root}.Info.SampleCount`, Array.isArray(ts)?ts.length:0);

  const totalGen  = sources.reduce((sum,s)=> sum + (isFinite(s.latest)&&s.latest>0 ? s.latest:0), 0);
  const totalCons = sources.reduce((sum,s)=> sum + (isFinite(s.latest)&&s.latest<0 ? s.latest:0), 0); // negativ
  const netTotal  = totalGen + totalCons;
  writeNum(`${base}.latest.total_generation`, totalGen, 'MW');
  writeNum(`${base}.latest.total_consumption_like`, totalCons, 'MW');
  writeNum(`${base}.latest.net_total`, netTotal, 'MW');

  renderDashboardDefault1(root, sources, totalGen, totalCons, netTotal);
}

// ---------- Sparkline (inline SVG, scoped) ----------
function sparkline(values, isNeg){
  try{
    const pts = (values||[]).filter(v=>typeof v==='number' && isFinite(v));
    if (pts.length < 2) return '';
    const min=Math.min(...pts), max=Math.max(...pts);
    const w=120, h=34, pad=2, span=Math.max(1, max-min), stepX=(w-pad*2)/(pts.length-1);
    const toY = v => h - pad - ((v-min)/span)*(h - pad*2);
    const d = pts.map((v,i)=>`${i?'L':'M'} ${pad+i*stepX} ${toY(v)}`).join(' ');
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <path d="${d}" fill="none" stroke="${isNeg?'#ff6b6b':'var(--accent)'}" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;
  }catch{return '';}
}

// ---------- Default-1 Theme Page Builder ----------
function buildDefault1Page(title, bodyHTML, headExtraCSS){
  const css = gv(THEME_CSS_DP);
  const frame = gv(THEME_FRAME_DP);
  const stamp = new Date().toLocaleString('de-DE');

  const head = [
    css ? `<style>${css}</style>` : '',
    `<style>${headExtraCSS||''}</style>`
  ].join('\n');

  const frameTpl = frame && frame.includes('{{BODY}}')
    ? frame
    : `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>{{TITLE}}</title>{{HEAD}}</head><body><header><div class="brand"><div class="brand-logo"></div><div class="brand-title">{{TITLE}}<br><small>Server-seitig gerendert (Default-1)</small></div></div><div><span class="pill">Stand: {{STAMP}}</span></div></header><main class="grid">{{BODY}}</main><footer>ioBroker · Default-1 Theme · {{STAMP}}</footer></body></html>`;

  return frameTpl
    .replaceAll('{{TITLE}}', title)
    .replaceAll('{{HEAD}}', head)
    .replaceAll('{{STAMP}}', stamp)
    .replaceAll('{{BODY}}', bodyHTML);
}

// ---------- Renderer (Default-1 kompatibel) ----------
const SPLIT_AT = 13;

function renderDashboardDefault1(root, sources, totalGen, totalCons, netTotal){
  const out = DASH_HTML_DP;
  ensureState(out, {type:'string', role:'html', read:true, write:false, def:''}, '');
  ensureState(LAST_GOOD_HTML_DP, {type:'string', role:'html', read:true, write:false, def:''}, '');

  const hasData = Array.isArray(sources) && sources.length > 0;

  const all = (sources || [])
    .filter(s => isFinite(s.latest))
    .sort((a,b) => Math.abs(b.latest) - Math.abs(a.latest));

  const leftItems  = all.slice(0, SPLIT_AT);
  const rightItems = all.slice(SPLIT_AT);

  const sumAbs = all.reduce((acc, s) => acc + (isFinite(s.latest) ? Math.abs(s.latest) : 0), 0) || 1;

  const scopedCSS = `
  .ec-page, .ec-card-full { grid-column: 1 / -1 !important; width: 100%; }

  .ec { font-size: 15px; color: var(--text); }
  .ec h3 { font-size: 18px !important; }
  .ec .value { font-size: 28px !important; }
  .ec .badge, .ec .pill, .ec .sub, .ec .mono { font-size: 12px; }
  .ec .table th, .ec .table td { font-size: 13.5px !important; }

  .ec .tablewrap { max-height: none !important; overflow: visible !important;
                   border:1px solid #1b2030; border-radius:10px; }

  .ec .cols { display:grid; grid-template-columns: 1fr 1fr; gap: var(--gap); }
  @media (max-width: 900px){ .ec .cols { grid-template-columns: 1fr; } }

  .ec .right { text-align:right; font-variant-numeric: tabular-nums; }
  .ec .srcname { display:flex; align-items:center; gap:8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ec .srcname .ic { display:inline-flex; width:18px; justify-content:center; }
  .ec .spark svg { display:block; }

  .ec .progress { width:100%; height:10px; background:#0e1218; border-radius:999px; overflow:hidden; border:1px solid #202638; }
  .ec .barfill { height:100%; background: var(--accent); }
  .ec tr.neg .barfill { background:#ff6b6b; }

  .ec .alert { position: sticky; top: 8px; z-index: 50; }
  `;

  const metaCard = `
  <div class="card ec-card-full metric">
    <h3>Übersicht</h3>
    <div class="grid-2">
      <div class="card">
        <div class="value">${fmtMW(totalGen)} <span class="sub">MW</span></div>
        <div class="sub">Summe Erzeugung</div>
      </div>
      <div class="card">
        <div class="value" style="color:#ff6b6b">${fmtMW(totalCons)} <span class="sub">MW</span></div>
        <div class="sub">Verbrauchsähnlich</div>
      </div>
    </div>
    <div class="row" style="justify-content:space-between; margin-top:6px;">
      <div class="sub">Netto gesamt: <b>${fmtMW(netTotal)} MW</b></div>
      <div class="badge mono">Samples: ${getState(`${root}.Info.SampleCount`)?.val ?? '—'}</div>
    </div>
  </div>`;

  function rowTr(s){
    const meta = prettyLabel(s.key);
    const isNeg = s.latest < 0;
    const pct = Math.min(100, (Math.abs(s.latest)/sumAbs)*100);
    return `<tr class="${isNeg?'neg':'pos'}">
      <td><div class="srcname"><span class="ic">${meta.icon}</span>${meta.label}</div></td>
      <td class="spark">${sparkline(s.tail, isNeg)}</td>
      <td class="right mono">${fmtMW(s.latest)}</td>
      <td><div class="progress"><div class="barfill" style="width:${pct.toFixed(1)}%"></div></div></td>
    </tr>`;
  }

  const leftRows  = (leftItems.length  ? leftItems.map(rowTr).join('')  : `<tr><td colspan="4" class="sub">—</td></tr>`);
  const rightRows = (rightItems.length ? rightItems.map(rowTr).join('') : `<tr><td colspan="4" class="sub">—</td></tr>`);

  const twinTablesCard = `
  <div class="card ec-card-full">
    <h3>Alle Quellen (links ${SPLIT_AT}, rechts fortlaufend)</h3>
    <div class="cols">
      <div>
        <div class="tablewrap">
          <table class="table">
            <thead><tr><th>Quelle</th><th>Verlauf</th><th class="right">MW</th><th>Anteil</th></tr></thead>
            <tbody>${leftRows}</tbody>
          </table>
        </div>
      </div>
      <div>
        <div class="tablewrap">
          <table class="table">
            <thead><tr><th>Quelle</th><th>Verlauf</th><th class="right">MW</th><th>Anteil</th></tr></thead>
            <tbody>${rightRows}</tbody>
          </table>
        </div>
      </div>
    </div>
  </div>`;

  const body = `<section class="ec ec-page">${metaCard}${twinTablesCard}</section>`;
  const title = `Energy-Charts (DE)`;
  const fullHTML = buildDefault1Page(title, body, scopedCSS);

  writeStr(LAST_GOOD_HTML_VIS_DP, fullHTML);
  writeStr(out, fullHTML);
  writeStr(MINUVIS_DP, buildMinuvisFragment(leftItems, rightItems, totalGen, totalCons, netTotal, sumAbs));
}

// ---------- Ablauf ----------
function injectStickyBanner(html, message){
  try{
    const stamp = new Date().toLocaleString('de-DE');
    const banner = `
    <div class="grid">
      <div class="card span-12 alert">
        <div class="row" style="justify-content:space-between; align-items:center;">
          <div><b>Hinweis:</b> Letzte erfolgreiche Ansicht wird angezeigt.</div>
          <div class="badge mono">${stamp}</div>
        </div>
        <div class="sub mono" style="margin-top:4px; white-space:pre-wrap">${message}</div>
      </div>
    </div>`;
    if (html.includes('</header>')){
      return html.replace('</header>', `</header>\n${banner}`);
    }
    if (html.includes('<main')) {
      return html.replace('<main', `${banner}\n<main`);
    }
    return banner + html;
  }catch{ return html; }
}

async function updateOnce(){
  try {
    const data = await fetchPublicPower(COUNTRY);
    storePublicPower(ROOT, data);
    writeStr(`${ROOT}.Info.LastOK`, new Date().toISOString());
    writeStr(`${ROOT}.Info.LastError`, '');
    logI('Daten aktualisiert.');
  } catch(err){
    const msg = `${new Date().toISOString()} | ${String(err)}`;
    writeStr(`${ROOT}.Info.LastError`, msg);
    logE(`Update fehlgeschlagen: ${msg}`);

    const last = gv(LAST_GOOD_HTML_VIS_DP);
    if (last) {
      writeStr(DASH_HTML_DP, injectStickyBanner(last, msg));
    } else {
      const empty = buildDefault1Page(
        'Energy-Charts (DE)',
        `<section class="ec ec-page">
           <div class="card ec-card-full alert">
             <h3>Keine Daten</h3>
             <p class="sub">Noch keine erfolgreiche Aktualisierung. Prüfe Netzwerk/SSL/Endpoint.</p>
             <pre class="mono" style="white-space:pre-wrap">${msg}</pre>
           </div>
         </section>`,
        `.ec .alert { position: sticky; top: 8px; z-index: 50; }`
      );
      writeStr(DASH_HTML_DP, empty);
    }
  }
}

function buildMinuvisFragment(leftItems, rightItems, totalGen, totalCons, netTotal, sumAbs){
  function row(s){
    const meta = prettyLabel(s.key);
    const isNeg = s.latest < 0;
    const pct = sumAbs>0 ? Math.min(100, Math.abs(s.latest)/sumAbs*100) : 0;
    const bar = `<div style="width:${pct.toFixed(1)}%;height:100%;background:${isNeg?'#ff6b6b':'#6ab7ff'}"></div>`;
    return `<tr>
      <td style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
        <span style="display:inline-block;width:18px;text-align:center">${meta.icon}</span> ${meta.label}
      </td>
      <td><div style="width:120px;height:10px;background:#0e1218;border:1px solid #202638;border-radius:999px;overflow:hidden">${bar}</div></td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtMW(s.latest)}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${pct.toFixed(1)}%</td>
    </tr>`;
  }
  const left  = leftItems.length  ? leftItems.map(row).join('')  : `<tr><td colspan="4" style="opacity:.7">—</td></tr>`;
  const right = rightItems.length ? rightItems.map(row).join('') : `<tr><td colspan="4" style="opacity:.7">—</td></tr>`;
  return `
  <div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial;color:#e6edf3">
    <div style="margin:0 0 10px 0;padding:10px;border:1px solid #1b2030;border-radius:12px;background:rgba(255,255,255,.02)">
      <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:space-between">
        <div><b>Erzeugung:</b> ${fmtMW(totalGen)} MW</div>
        <div><b style="color:#ff6b6b">Verbrauchsähnlich:</b> ${fmtMW(totalCons)} MW</div>
        <div><b>Netto:</b> ${fmtMW(netTotal)} MW</div>
      </div>
    </div>
    <div style="width:49%;float:left">
      <div style="padding:10px;border:1px solid #1b2030;border-radius:12px;background:rgba(255,255,255,.02)">
        <div style="margin:0 0 6px 0;font-weight:600">Quellen (links)</div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="text-align:left;border-bottom:1px solid #1b2030;padding:6px 4px">Quelle</th>
            <th style="text-align:left;border-bottom:1px solid #1b2030;padding:6px 4px">Anteil</th>
            <th style="text-align:right;border-bottom:1px solid #1b2030;padding:6px 4px">MW</th>
            <th style="text-align:right;border-bottom:1px solid #1b2030;padding:6px 4px">%</th>
          </tr></thead>
          <tbody>${left}</tbody>
        </table>
      </div>
    </div>
    <div style="width:49%;float:right">
      <div style="padding:10px;border:1px solid #1b2030;border-radius:12px;background:rgba(255,255,255,.02)">
        <div style="margin:0 0 6px 0;font-weight:600">Quellen (rechts)</div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="text-align:left;border-bottom:1px solid #1b2030;padding:6px 4px">Quelle</th>
            <th style="text-align:left;border-bottom:1px solid #1b2030;padding:6px 4px">Anteil</th>
            <th style="text-align:right;border-bottom:1px solid #1b2030;padding:6px 4px">MW</th>
            <th style="text-align:right;border-bottom:1px solid #1b2030;padding:6px 4px">%</th>
          </tr></thead>
          <tbody>${right}</tbody>
        </table>
      </div>
    </div>
    <div style="clear:both"></div>
  </div>`;
}

// ---------- Init ----------
(function initStates(){
  writeStr(`${ROOT}.Info.ScriptVersion`, '1.5.0');

  ensureState(`${ROOT}.Cmd.UpdateNow`, {type:'boolean', role:'button', write:true, read:true, def:false}, false);
  _setIfChanged(`${ROOT}.Cmd.UpdateNow`, false, true);

  writeStr(`${ROOT}.Config.Country`, COUNTRY);
  writeNum(`${ROOT}.Config.HoursBack`, HOURS_BACK, 'h');
  writeNum(`${ROOT}.Config.IntervalMin`, INTERVAL_MIN, 'min');
  writeBool(`${ROOT}.Config.VerifySSL`, VERIFY_SSL);
  writeStr(`${ROOT}.Config.TemplateCSS`, THEME_CSS_DP);
  writeStr(`${ROOT}.Config.TemplateFrame`, THEME_FRAME_DP);

  ensureState(DASH_HTML_DP,          { type:'string', role:'html', write:false, read:true, def:'' }, '');
  ensureState(LAST_GOOD_HTML_VIS_DP, { type:'string', role:'html', write:false, read:true, def:'' }, '');
  ensureState(MINUVIS_DP,            { type:'string', role:'html', write:false, read:true, def:'' }, '');
})();

on({id:`${ROOT}.Cmd.UpdateNow`, change:'any'}, async o=>{
  if (o?.state?.val===true){
    logI('Manueller Abruf …');
    await updateOnce();
    _setIfChanged(`${ROOT}.Cmd.UpdateNow`, false, true);
  }
});

// Start + Intervall
(async ()=>{
  await updateOnce();
  const step = Math.max(1, Math.min(59, Number(INTERVAL_MIN) || 30));
  schedule(`*/${step} * * * *`, updateOnce);
  logI(`Scheduler aktiv: alle ${step} Minuten (Zeitraum: -${HOURS_BACK}h).`);
})();
