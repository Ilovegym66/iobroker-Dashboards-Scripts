/***************************************************************
 * Synology Photos – v3.0.6p (JS 9.0.11 fix + recent-fallback)
 * - (c) ilovegym66 github.com/ilovegym66
 * - Vollscan + Quick-Refresh (TTL/dirTotal)
 * - Slideshow entkoppelt, Timer läuft dauerhaft
 * - Pool-Seed aus persistiertem Index (sampleImages) – RANDOM
 * - Zeitfenster: CFG.recentYears (0 = kein Filter)
 * - Fallback: Bilder ohne mtime / mtime=0 werden zugelassen
 * - Thumbs via _sid -> ioBroker /files (Web-Adapter)
 * - Throttle für setState: kein 1000/min Kill mehr
 ***************************************************************/
'use strict';

/*** ===== KONFIG ===== ***/
const CFG = {
  // NAS-Login (FileStation-API auf Photos-Port)
  host: 'IPofSynology',
  port: 5000,
  https: false,
  username: 'place your username here',
  password: 'place your pw here',
  otpState: '',

  // Scan-Wurzeln (bitte anpassen)
  basePaths: ['/photo', '/homes/ilovegym/Photos'],

  // Web-Adapter (für Bildanzeige in MinuVis/Browser)
  webBase: 'http://10.1.1.2:8081',     //iobroker is 10.1.1.2:8081

  // Dateiablage im ioBroker-FS
  FILE_NS:  '0_userdata.0',
  FILE_DIR: 'synophoto/thumbs',
  PERSIST_FILE_DIR:  'synophoto/persist',
  PERSIST_FILE_NAME: 'index.json',

  // State-Pfade
  ROOT: '0_userdata.0.Geraete.SynoPhotos',
  HTML_STATS: '0_userdata.0.vis.Dashboards.SynoPhotosStatsHTML',    //Dashboard with Statistics
  HTML_SHOW:  '0_userdata.0.vis.Dashboards.SynoPhotosShowHTML',     //Dashboard with the current pic

  // Startup-Scan-Policy: 'full' | 'quick' | 'never'
  startupScan: 'full',

  // TTL: Wenn Ordner-Eintrag jünger als so viel, darf Quick ihn skippen
  folderTTLsec: 12 * 60 * 60,   // 12h

  // Quick-Refresh Plan (Cron)
  refreshIntervalSec: 6 * 60 * 60,  // alle 6h

  // Slideshow
  earlyCount: 1,
  slideshowChangeSec: 30,
  frame: { minHeightPx: 320, aspectRatio: '' },

  // Nur Bilder der letzten N Jahre; 0 = kein Zeitfilter
  recentYears: 0,

  // Datei-Endungen
  ext: {
    image: ['jpg','jpeg','png','gif','bmp','tif','tiff','heic','raw','cr2','nef','dng','rw2','orf','arw'],
    video: ['mp4','mov','m4v','mkv','avi','wmv','mpg','mpeg','flv','webm','3gp','3g2','mts','m2ts']
  },

  thumbSize: 'large',

  // Pool/Cache
  poolMax: 500,          // max Bilder im Slideshow-Pool (Sample aus Ordnern)
  samplePerFolder: 5,   // pro Ordner (für Pool)
  fileCache: {
    maxFiles: 100,
    maxAgeSec: 14*24*60*60,
    cleanupEveryMin: 15,
    indexStateId: '0_userdata.0.Geraete.SynoPhotos._persist.fileIndex'
  },

  // Blacklist-Pfade/Muster
  blacklist: [
    '/@eaDir/', '/@Recycle/', '/#recycle/',
    /\.ds_store$/i, /^~/, /\/\./,               // hidden/temp
    /(^|\/)\d+_original\.jpg$/i                 // z.B. 183427_original.jpg
  ],

  LOG: { INFO:true, DEBUG:false }
};

/*** ===== GLOBALS ===== ***/
let ABORT = false;
let SCAN_LOCK = false;
let SHOW_TIMER = null;
const ABORT_ERR = new Error('__ABORT__');
let AUTH = { sid:'', token:'' };
let COOKIE = '';

/** Persistenter Index (inkrementell) */
let INDEX = { version:1, updated:0, folders:{} };
function ensureIndexShape(){
  if (!INDEX || typeof INDEX !== 'object') INDEX = { version:1, updated:0, folders:{} };
  if (!INDEX.folders || typeof INDEX.folders !== 'object') INDEX.folders = {};
}

let ACTIVE_POOL = [];               // Slideshow-Pool: [{path,date}]
const CACHED   = new Set();         // Pfade mit lokalem Thumb
const BAD_SET  = new Set();         // dauerhaft skippen (defekt/gesperrt)
let FILE_INDEX = {};                // fname -> lastUsedTs

/*** ===== Utils ===== ***/
const https  = require('https');
const http   = require('http');
const { URL } = require('url');
const crypto = require('crypto');

function logI(x){ if (CFG.LOG.INFO)  log('[SynoPhotos] '+x); }
function logD(x){ if (CFG.LOG.DEBUG) log('[SynoPhotos] '+x); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function throttle(fn, ms){
  let t=0;
  return (...a)=>{
    const n=Date.now();
    if (n-t>=ms){
      t=n;
      try{ fn(...a); }catch(e){}
    }
  };
}
function setS(id, v){ try{ setState(id, v, true); }catch(e){ log('[SynoPhotos] setState '+id+' failed: '+e); } }
function getS(id){ try{ const s=getState(id); return s && s.val; }catch(_){ return undefined; } }

async function ensureState(id, defVal, common){
  try{
    if (!existsObject(id)){
      createState(
        id,
        defVal,
        Object.assign({
          type: typeof defVal === 'string' ? 'string' : typeof defVal,
          name: id.split('.').pop(),
          role: 'state',
          read:true,
          write:true
        }, common||{})
      );
    }
  }catch(e){ log('[SynoPhotos] ensureState '+id+' failed: '+e); }
}
function extOf(n){
  const m=/\.([^.]+)$/.exec(n||'');
  return m ? m[1].toLowerCase() : '';
}
function isBlacklisted(path){
  for (const r of CFG.blacklist){
    if (typeof r==='string'){
      if (String(path).includes(r)) return true;
    } else if (r instanceof RegExp){
      if (r.test(String(path))) return true;
    }
  }
  return false;
}
function fmtDEDate(ms){
  try{
    return ms ? new Date(ms).toLocaleDateString('de-DE',{
      year:'numeric',month:'2-digit',day:'2-digit'
    }) : '';
  }catch(_){ return ''; }
}
function nowISO(){ return new Date().toISOString(); }

/*** Zeitfenster „letzte N Jahre“ mit 0 = kein Filter ***/
function recentCutoffMs(){
  // recentYears <= 0 = kein Zeitfilter
  if (!CFG.recentYears || CFG.recentYears <= 0) return 0;
  return Date.now() - (CFG.recentYears * 365.25 * 24 * 60 * 60 * 1000);
}
function isRecentMs(ms){
  if (!CFG.recentYears || CFG.recentYears <= 0){
    // Kein Zeitfenster: jedes Bild mit gültiger mtime ist „ok“
    return typeof ms === 'number' && ms > 0;
  }
  return typeof ms === 'number' && ms > 0 && ms >= recentCutoffMs();
}
// Fallback – wenn mtime fehlt/0 → als „ok“ werten
function isRecentOrUnknown(ms){
  if (ms == null || isNaN(ms) || ms === 0) return true;
  return isRecentMs(ms);
}

// Shuffle (Fisher–Yates)
function shuffle(arr){
  for (let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// sanfter Throttle für Pfad-Updates (max ~40/min)
const setPathThrottled = (()=>{
  let t = 0, last = '';
  return (p)=>{
    const now = Date.now();
    if (p && p!==last && (now - t) > 1500) { // 1.5s
      t = now; last = p;
      try { setState(`${CFG.ROOT}.info.scanPathCurrent`, p, true); } catch {}
    }
  };
})();

/*** ===== ioBroker FS Wrapper ===== ***/
function ioWrite(pathRel, buf){
  return new Promise((res,rej)=>{
    const fn = globalThis['writeFile'];
    if (typeof fn!=='function') return rej(new Error('writeFile unavailable'));
    fn(CFG.FILE_NS, pathRel, buf, err=> err?rej(err):res());
  });
}
function ioRead(pathRel){
  return new Promise((res,rej)=>{
    const fn = globalThis['readFile'];
    if (typeof fn!=='function') return rej(new Error('readFile unavailable'));
    fn(CFG.FILE_NS, pathRel, (err,data)=> err?rej(err):res(data));
  });
}
function ioList(dirRel){
  return new Promise((res,rej)=>{
    const fn = globalThis['readDir'];
    if (typeof fn!=='function') return res([]);
    fn(CFG.FILE_NS, dirRel, (err,arr)=> err?rej(err):res(arr||[]));
  });
}
function ioUnlink(pathRel){
  return new Promise((res,rej)=>{
    const fn = globalThis['unlink'];
    if (typeof fn!=='function') return res();
    fn(CFG.FILE_NS, pathRel, err=> err?rej(err):res());
  });
}

/*** ===== HTTP & FileStation ===== ***/
function baseURL(){ return `${CFG.https?'https':'http'}://${CFG.host}:${CFG.port}`; }
function agent(){
  return CFG.https
    ? new https.Agent({ rejectUnauthorized:false })
    : new http.Agent();
}

async function httpCall({ method='GET', path='/webapi/entry.cgi', query={}, data=null, headers={}, binary=false }){
  const url = new URL(baseURL()+path);
  Object.keys(query||{}).forEach(k=> url.searchParams.append(k, String(query[k])));
  const opts = {
    method,
    headers: Object.assign({ 'Accept': binary? '*/*':'application/json' }, headers),
    agent: agent()
  };
  if (COOKIE)     opts.headers['Cookie']       = COOKIE;
  if (AUTH.token) opts.headers['X-SYNO-TOKEN'] = AUTH.token;

  return new Promise((resolve,reject)=>{
    const req=(CFG.https?https:http).request(url, opts, res=>{
      const chunks=[];
      res.on('data',d=>chunks.push(d));
      res.on('end',()=>{
        const buf=Buffer.concat(chunks);
        if (binary) return resolve({ status:res.statusCode, headers:res.headers, body:buf });
        const text=buf.toString('utf8');
        try{
          resolve({ status:res.statusCode, headers:res.headers, body: JSON.parse(text) });
        }catch(e){
          reject(new Error('Invalid JSON from NAS: '+text.slice(0,200)));
        }
      });
    });
    req.on('error', reject);

    if (data){
      const payload = typeof data==='string'
        ? data
        : Object.keys(data).map(k=>`${encodeURIComponent(k)}=${encodeURIComponent(String(k in data ? data[k] : ''))}`).join('&');
      opts.headers['Content-Type']='application/x-www-form-urlencoded';
      req.write(payload);
    }

    req.end();
  });
}

async function callFS(api, method, params){
  const q = Object.assign({ api, method, version:2 }, params||{});
  const r = await httpCall({ path:'/webapi/entry.cgi', query:q });
  if (!r.body || !r.body.success) throw new Error(JSON.stringify(r.body && r.body.error || r.body));
  return r.body.data;
}

/*** ===== Auth ===== ***/
async function synoLogin(){
  const otp = CFG.otpState ? (getS(CFG.otpState) || '') : '';
  const q = {
    api:'SYNO.API.Auth',
    method:'login',
    version:'7',
    account:CFG.username,
    passwd:CFG.password,
    session:'FileStation',
    format:'sid',
    enable_syno_token:'yes'
  };
  if (otp) q.otp_code = otp;
  const r = await httpCall({ path:'/webapi/auth.cgi', query:q });
  if (!r.body || !r.body.success) throw new Error('Login failed: '+JSON.stringify(r.body && r.body.error));
  AUTH.sid   = r.body.data?.sid || '';
  AUTH.token = r.body.data?.synotoken || r.body.data?.['synotoken'] || '';
  COOKIE = `id=${AUTH.sid}`;
  setS(`${CFG.ROOT}.auth.sid`, AUTH.sid);
  setS(`${CFG.ROOT}.auth.token`, AUTH.token);
  logI('Login ok (FileStation/synoToken)');
}

/*** ===== Thumb via _sid ===== ***/
function buildThumbQuery(pathStr, quoted=true){
  const pathParam = quoted ? `"${pathStr}"` : pathStr;
  const q = {
    api:'SYNO.FileStation.Thumb',
    version:2,
    method:'get',
    size:CFG.thumbSize,
    path:pathParam
  };
  if (AUTH.sid) q._sid = AUTH.sid;
  return q;
}
async function fetchThumbBinary(filePath){
  try{
    // 1) quoted
    let r = await httpCall({ path:'/webapi/entry.cgi', query: buildThumbQuery(filePath, true), binary:true });
    const ct1 = String(r.headers?.['content-type'] || r.headers?.['Content-Type'] || '');
    if (r.status===200 && r.body?.length && /^image\//i.test(ct1)) return r.body;

    // 2) plain
    r = await httpCall({ path:'/webapi/entry.cgi', query: buildThumbQuery(filePath, false), binary:true });
    const ct2 = String(r.headers?.['content-type'] || r.headers?.['Content-Type'] || '');
    if (r.status===200 && r.body?.length && /^image\//i.test(ct2)) return r.body;

    throw new Error(`Thumb fetch failed: HTTP=${r.status} CT=${ct2||ct1}`);
  }catch(e){
    setS(`${CFG.ROOT}.info.lastError`, `thumb fetch: ${e}`);
    throw e;
  }
}

/*** ===== Persist: Index lädt/schreibt (State + Datei) ===== ***/
async function ensurePersistStates(){
  await ensureState(`${CFG.ROOT}.auth.sid`,   '', {type:'string', role:'text'});
  await ensureState(`${CFG.ROOT}.auth.token`, '', {type:'string', role:'text'});

  await ensureState(`${CFG.ROOT}.info.lastError`, '', {type:'string', role:'text'});
  await ensureState(`${CFG.ROOT}.info.lastScan`,  '', {type:'string', role:'text'});
  await ensureState(`${CFG.ROOT}.info.scanActive`, false, {type:'boolean', role:'indicator'});
  await ensureState(`${CFG.ROOT}.info.scanMode`,  'idle', {type:'string', role:'text'});

  await ensureState(`${CFG.ROOT}.info.scannedFolders`, 0, {type:'number', role:'value'});
  await ensureState(`${CFG.ROOT}.info.scannedFiles`,   0, {type:'number', role:'value'});
  await ensureState(`${CFG.ROOT}.info.scannedImages`,  0, {type:'number', role:'value'});
  await ensureState(`${CFG.ROOT}.info.scannedVideos`,  0, {type:'number', role:'value'});
  await ensureState(`${CFG.ROOT}.info.scanPathCurrent`,'', {type:'string', role:'text'});

  // Pool-/Bad-Zähler
  await ensureState(`${CFG.ROOT}.info.poolSize`, 0, {type:'number', role:'value'});
  await ensureState(`${CFG.ROOT}.info.badCount`, 0, {type:'number', role:'value'});

  await ensureState(`${CFG.ROOT}.totals.images`, 0, {type:'number', role:'value'});
  await ensureState(`${CFG.ROOT}.totals.videos`, 0, {type:'number', role:'value'});
  await ensureState(`${CFG.ROOT}.totals.files`,  0, {type:'number', role:'value'});
  await ensureState(`${CFG.ROOT}.totals.folders`,0, {type:'number', role:'value'});

  await ensureState(`${CFG.ROOT}.control.fullScanNow`, false, {type:'boolean', role:'switch'});
  await ensureState(`${CFG.ROOT}.control.refreshNow`,  false, {type:'boolean', role:'switch'});
  await ensureState(`${CFG.ROOT}.control.cancelScan`,  false, {type:'boolean', role:'button'});

  await ensureState(`${CFG.ROOT}.info.lastImageURL`,  '', {type:'string', role:'text'});
  await ensureState(`${CFG.ROOT}.info.lastImagePath`, '', {type:'string', role:'text'});

  await ensureState(CFG.fileCache.indexStateId, '{}', {type:'string', role:'json'});
  await ensureState(`${CFG.ROOT}.persist.indexJSON`, '{}', {type:'string', role:'json'}); // Spiegel
}

async function ensurePersistDir(){
  try { await ioList(CFG.PERSIST_FILE_DIR); } catch(_){}
  try { await ioWrite(`${CFG.PERSIST_FILE_DIR}/.keep`, Buffer.from('')); } catch(_){}
}
async function ensureThumbsDir(){
  try { await ioList(CFG.FILE_DIR); } catch(_){}
  try { await ioWrite(`${CFG.FILE_DIR}/.keep`, Buffer.from('')); } catch(_){}
}

async function loadIndex(){
  try {
    const raw = getS(`${CFG.ROOT}.persist.indexJSON`);
    if (raw) { try { INDEX = JSON.parse(String(raw)); } catch(_){ } }
  } catch(_){ }

  if (!INDEX || !INDEX.folders){
    try{
      const buf = await ioRead(`${CFG.PERSIST_FILE_DIR}/${CFG.PERSIST_FILE_NAME}`);
      const txt = buf ? buf.toString('utf8') : '';
      if (txt) { try { INDEX = JSON.parse(txt); } catch(_){ } }
    }catch(_){}
  }
  ensureIndexShape();
}

async function saveIndex(){
  ensureIndexShape();
  INDEX.updated = Date.now();
  try { setS(`${CFG.ROOT}.persist.indexJSON`, JSON.stringify(INDEX)); } catch(_){ }
  try{
    await ensurePersistDir();
    await ioWrite(`${CFG.PERSIST_FILE_DIR}/${CFG.PERSIST_FILE_NAME}`, Buffer.from(JSON.stringify(INDEX)));
  }catch(e){
    setS(`${CFG.ROOT}.info.lastError`, 'Persist write error: '+e);
  }
}

/*** ===== FileCache Index ===== ***/
async function ensureFileIndexState(){
  try { FILE_INDEX = JSON.parse(getS(CFG.fileCache.indexStateId) || '{}') || {}; }
  catch { FILE_INDEX = {}; }
}
function saveFileIndexNow(){
  try { setS(CFG.fileCache.indexStateId, JSON.stringify(FILE_INDEX)); } catch(_){ }
}
const saveFileIndexThrottled = throttle(saveFileIndexNow, 20000);

/*** ===== Dir Listing ===== ***/
function isDirEntry(f){ return !!f && !!f.isdir; }

async function pathExists(p){
  try{
    if (/^\/[A-Za-z0-9._-]+$/.test(p)){
      const sh=await callFS('SYNO.FileStation.List','list_share',{});
      return !!(sh && sh.shares && sh.shares.some(s=> s.path===p || ('/'+s.name)===p));
    }
    await callFS('SYNO.FileStation.List','list',{ folder_path:p, limit:1 });
    return true;
  }catch(_){ return false; }
}
async function quickTotal(p){
  try{
    const d=await callFS('SYNO.FileStation.List','list',{ folder_path:p, limit:1, offset:0 });
    return (d && typeof d.total==='number') ? d.total : null;
  }catch(_){ return null; }
}
async function listFolderFull(p){
  const LIMIT=1000;
  let offset=0;
  let all=[];
  while(true){
    if (ABORT) throw ABORT_ERR;
    const d=await callFS('SYNO.FileStation.List','list',{
      folder_path:p,
      limit:LIMIT,
      offset,
      additional:'size,time'
    });
    const arr=(d&&Array.isArray(d.files))? d.files:[];
    all.push(...arr);
    if (!d || typeof d.total!=='number' || all.length>=d.total) break;
    offset=all.length;
    await sleep(3);
  }
  return all;
}

/*** ===== Scan-Kern (Voll / Quick) ===== ***/
function folderFresh(entry, dirTot, ttlMs){
  if (!entry) return false;
  const freshAge = (Date.now() - (entry.ts||0)) < ttlMs;
  if (dirTot == null) return freshAge;
  if (typeof entry.dirTotal === 'number' && entry.dirTotal === dirTot) return freshAge;
  return false;
}

async function scanNode(path, stats, forceFull, progress, poolRef){
  ensureIndexShape();
  if (ABORT) throw ABORT_ERR;
  stats.folders++;
  progress.path(path);

  let dirTot=null;
  try{ dirTot=await quickTotal(path);}catch(_){ dirTot=null; }

  const entry = (INDEX.folders && INDEX.folders[path]) ? INDEX.folders[path] : null;
  const ttlMs = CFG.folderTTLsec*1000;
  const fresh = !forceFull && folderFresh(entry, dirTot, ttlMs);

  if (fresh){
    const agg = entry.agg || {images:0,videos:0,files:0,bytes:0,folders:1};
    stats.images += agg.images;
    stats.videos += agg.videos;
    stats.files  += agg.files;
    stats.bytes  += agg.bytes;
    stats.folders += Math.max(0, (agg.folders||1) - 1);

    if (Array.isArray(entry.sampleImages)){
      for (const s of entry.sampleImages){
        if (poolRef.length >= CFG.poolMax) break;
        const pth  = (typeof s==='string') ? s : (s && s.path);
        const mtms = (typeof s==='object' && s.mtime) ? s.mtime : 0;
        if (pth && !isBlacklisted(pth) && isRecentOrUnknown(mtms)){
          poolRef.push({ path:pth, date: mtms ? fmtDEDate(mtms) : '' });
        }
      }
    }
    progress.bump();
    return Object.assign({folders:1}, agg);
  }

  // Voller Scan dieses Ordners
  const files = await listFolderFull(path);
  let agg={ images:0, videos:0, others:0, bytes:0, files:0, folders:1 };
  const sample=[]; const subdirs=[];

  for (const f of files){
    if (ABORT) throw ABORT_ERR;

    if (isDirEntry(f)){
      subdirs.push(f.path);
      continue;
    }
    if (isBlacklisted(f.path) || isBlacklisted(f.name)){
      progress.bump();
      continue;
    }

    const ext  = extOf(f.name);
    const size = (f.additional && f.additional.size) || 0;
    const mtime = ((f.additional && f.additional.time && f.additional.time.mtime) || 0) * 1000;

    agg.files++; stats.files++; agg.bytes+=size; stats.bytes+=size;

    if (CFG.ext.image.includes(ext)){
      agg.images++; stats.images++;
      const fp = f.path;
      const recentOk = isRecentOrUnknown(mtime);   // Fallback: unknown mtime zulassen

      if (recentOk){
        if (poolRef.length < CFG.poolMax){
          const dStr = mtime ? fmtDEDate(mtime) : '';
          poolRef.push({ path: fp, date: dStr });
        }
        if (sample.length < CFG.samplePerFolder){
          sample.push({ path: fp, mtime });
        }
      }

    } else if (CFG.ext.video.includes(ext)){
      agg.videos++; stats.videos++;
    } else {
      agg.others++;
    }

    progress.bump();
  }

  for (const sd of subdirs){
    const child = await scanNode(sd, stats, forceFull, progress, poolRef);
    agg.images+=child.images; agg.videos+=child.videos; agg.others+=child.others;
    agg.bytes +=child.bytes;  agg.files +=child.files;  agg.folders+=child.folders;
  }

  INDEX.folders[path] = {
    dirTotal:(dirTot!=null?dirTot:files.length),
    ts:Date.now(),
    agg,
    sampleImages: sample
  };
  return agg;
}

/*** ===== HTML ===== */
function statsCardHTML(title, value){
  return `<div style="flex:1 1 220px;background:linear-gradient(135deg,#243b55,#141e30);padding:14px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.25)">
    <div style="opacity:.8;font-size:12px;letter-spacing:.08em">${title}</div>
    <div style="font-size:28px;font-weight:700">${(value||0).toLocaleString? value.toLocaleString(): value}</div>
  </div>`;
}
function makeStatsHTML(t){
  return `
  <div class="card" style="--bg:rgba(20,22,30,.6);border-radius:16px;padding:16px;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial;color:#e6e6e6;">
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;">
      ${statsCardHTML('BILDER', t.images||0)}
      ${statsCardHTML('VIDEOS', t.videos||0)}
      ${statsCardHTML('ORDNER', t.folders||0)}
      ${statsCardHTML('DATEIEN', t.files||0)}
    </div>
    <div style="margin-top:12px;opacity:.8">Stand: ${new Date().toLocaleString()}</div>
  </div>`;
}
function makeShowHTML_FROM_FILE(url, caption){
  const minH = CFG.frame.minHeightPx || 320;
  const ratio = (CFG.frame.aspectRatio || '').trim();
  const ratioStyle = ratio ? `aspect-ratio:${ratio};` : '';
  return `
  <div class="card"
       style="height:100%;border-radius:16px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,.35);background:#111;">
    <div style="position:relative;width:100%;height:100%;min-height:${minH}px;${ratioStyle}">
      <img src="${url}" alt="Synology Photo" draggable="false"
           style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;object-position:center;background:#111;"/>
      <div style="position:absolute;left:8px;bottom:8px;padding:6px 10px;border-radius:12px;color:#eee;background:rgba(0,0,0,.55);font:500 12px/1.3 Inter,system-ui;max-width:92%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        ${caption||''}
      </div>
    </div>
  </div>`.trim();
}

/*** ===== Thumb-Cache ===== */
function hashName(p){ return crypto.createHash('sha1').update(String(p)).digest('hex') + '.jpg'; }
function fileUrl(fname){ return `${CFG.webBase}/files/${CFG.FILE_NS}/${CFG.FILE_DIR}/${fname}`; }
async function writeThumbFile(buf, fname){
  try{
    await ensureThumbsDir();
    await ioWrite(`${CFG.FILE_DIR}/${fname}`, buf);
  }catch(e){
    setS(`${CFG.ROOT}.info.lastError`, `thumb write: ${e}`);
    throw e;
  }
}
async function readThumbFile(fname){ return ioRead(`${CFG.FILE_DIR}/${fname}`); }
async function listThumbFiles(){ return ioList(CFG.FILE_DIR); }
async function delThumbFile(fname){ return ioUnlink(`${CFG.FILE_DIR}/${fname}`); }

async function cleanupCacheIfNeeded(){
  try{
    const list = await listThumbFiles();
    const files = (list||[]).filter(x=> x && x.isDir === false).map(x=> x.file);
    const now = Date.now();
    const limitAge = CFG.fileCache.maxAgeSec * 1000;

    for (const f of files){
      const last = FILE_INDEX[f] || 0;
      if (!last || (now - last) > limitAge){
        try { await delThumbFile(f); delete FILE_INDEX[f]; } catch(_){}
      }
    }

    let remain = await listThumbFiles();
    remain = (remain || []).filter(x=> x && x.isDir === false).map(x=> x.file);
    if (remain.length > CFG.fileCache.maxFiles){
      remain.sort((a,b)=> (FILE_INDEX[a]||0) - (FILE_INDEX[b]||0));
      const toDel = remain.slice(0, remain.length - CFG.fileCache.maxFiles);
      for (const f of toDel){
        try { await delThumbFile(f); delete FILE_INDEX[f]; } catch(_){}
      }
    }

    saveFileIndexNow();
  }catch(e){
    logD('cleanupCache error: '+e);
  }
}

/*** ===== Slideshow ===== */
async function getOrCreateLocalThumb(absPath){
  const fname = hashName(absPath);
  if (!CACHED.has(absPath)){
    try{
      await readThumbFile(fname);
    }catch(_){
      const buf = await fetchThumbBinary(absPath);
      await writeThumbFile(buf, fname);
      logI(`Thumb gespeichert: ${CFG.FILE_DIR}/${fname} (${buf.length} Bytes)`);
    }
    CACHED.add(absPath);
  }
  return fname;
}

async function rotateOnce(){
  if (!ACTIVE_POOL.length){
    seedPoolFromIndex(CFG.poolMax);
    if (!ACTIVE_POOL.length){
      setS(`${CFG.ROOT}.info.poolSize`, 0);

      const yrs = CFG.recentYears;
      const txt = (!yrs || yrs<=0)
        ? 'Keine geeigneten Bilder gefunden'
        : `Keine Bilder innerhalb der letzten ${yrs} Jahre gefunden`;

      setS(
        CFG.HTML_SHOW,
        makeShowHTML_FROM_FILE(
          `${CFG.webBase}/files/${CFG.FILE_NS}/${CFG.FILE_DIR}/single.jpg?t=${Date.now()}`,
          txt
        )
      );
      return;
    }
  }

  for (let tries=0; tries<6; tries++){
    const idx  = Math.floor(Math.random()*ACTIVE_POOL.length);
    const item = ACTIVE_POOL[idx];
    if (!item) return;

    if (BAD_SET.has(item.path) || isBlacklisted(item.path)){
      ACTIVE_POOL.splice(idx,1);
      tries--;
      continue;
    }

    try{
      const fname = await getOrCreateLocalThumb(item.path);
      const url = `${fileUrl(fname)}?t=${Date.now()}`;
      FILE_INDEX[fname] = Date.now();
      saveFileIndexThrottled();

      const cap = `${item.date ? item.date+'  ·  ' : ''}${item.path}`;
      setS(`${CFG.ROOT}.info.lastImageURL`,  url);
      setS(`${CFG.ROOT}.info.lastImagePath`, item.path);
      setS(CFG.HTML_SHOW, makeShowHTML_FROM_FILE(url, cap));

      if (Math.random()<0.05){
        cleanupCacheIfNeeded().catch(()=>{});
      }

      setS(`${CFG.ROOT}.info.poolSize`, ACTIVE_POOL.length);
      setS(`${CFG.ROOT}.info.badCount`, BAD_SET.size);
      return;

    }catch(e){
      BAD_SET.add(item.path);
      ACTIVE_POOL.splice(idx,1);
      setS(`${CFG.ROOT}.info.lastError`, 'rotate skip: '+e);
    }
  }
}

function startSlideshowTimer(){
  if (SHOW_TIMER) return;
  SHOW_TIMER = setInterval(()=> { rotateOnce().catch(()=>{}); }, CFG.slideshowChangeSec*1000);
  rotateOnce().catch(()=>{});
}

/*** ===== Index-Seed in den Pool – RANDOM + recent-only+fallback ===== */
function seedPoolFromIndex(max){
  ensureIndexShape();
  const all = [];

  for (const p in INDEX.folders){
    const entry = INDEX.folders[p];
    if (!entry) continue;
    const arr = Array.isArray(entry.sampleImages) ? entry.sampleImages : [];
    for (const s of arr){
      const path  = (typeof s === 'string') ? s : (s && s.path);
      const mtime = (typeof s === 'object' && s.mtime) ? s.mtime : 0;
      if (!path || isBlacklisted(path)) continue;
      if (!isRecentOrUnknown(mtime)) continue;
      all.push({ path, mtime });
    }
  }

  if (!all.length){
    setS(`${CFG.ROOT}.info.poolSize`, 0);
    return;
  }

  shuffle(all);

  const take = Math.min(max, all.length);
  ACTIVE_POOL = all.slice(0, take).map(x => ({
    path: x.path,
    date: x.mtime ? fmtDEDate(x.mtime) : ''
  }));

  setS(`${CFG.ROOT}.info.poolSize`, ACTIVE_POOL.length);
  logI(`Pool-Seed (letzte ${CFG.recentYears} Jahre ODER unbekannt, random): ${ACTIVE_POOL.length} Elemente`);
}

/*** ===== Scan Orchestrierung ===== */
function makeLoadingStatsHTML(p){
  const info = p||{ images:0, videos:0, files:0, folders:0, path:'' };
  return `
  <div class="card" style="--bg:rgba(20,22,30,.6);border-radius:16px;padding:16px;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial;color:#e6e6e6;">
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;">
      ${statsCardHTML('BILDER', info.images)}
      ${statsCardHTML('VIDEOS', info.videos)}
      ${statsCardHTML('ORDNER', info.folders)}
      ${statsCardHTML('DATEIEN', info.files)}
    </div>
    <div style="margin-top:12px;opacity:.9">Scan läuft… <span style="opacity:.8">${info.path||''}</span></div>
  </div>`;
}

async function runScan({ mode }){
  if (SCAN_LOCK){
    logI('Scan läuft bereits – skip.');
    return;
  }

  ensureIndexShape();
  SCAN_LOCK = true;
  ABORT = false;

  setS(`${CFG.ROOT}.info.scanActive`, true);
  setS(`${CFG.ROOT}.info.scanMode`,   mode);

  const started = Date.now();

  try{
    const basesRaw = Array.isArray(CFG.basePaths)
      ? CFG.basePaths.slice()
      : (typeof CFG.basePaths === 'string' ? [CFG.basePaths] : []);

    const bases = [];
    for (const raw of basesRaw){
      const p = (raw || '').toString().trim();
      if (!p || !p.startsWith('/')) continue;
      try { if (await pathExists(p)) bases.push(p); } catch(_){}
    }
    if (!bases.length) throw new Error('Keine gültigen basePaths.');

    const forceFull = (mode === 'full');
    let stats = { images:0, videos:0, files:0, bytes:0, folders:0 };
    const newPool = [];

    let progCount = 0;
    const updateThrottled = (()=>{
      let t = 0;
      return ()=>{
        const now = Date.now();
        if (now - t < 1500) return;
        t = now;
        setS(`${CFG.ROOT}.info.scannedFolders`, stats.folders);
        setS(`${CFG.ROOT}.info.scannedFiles`,   stats.files);
        setS(`${CFG.ROOT}.info.scannedImages`,  stats.images);
        setS(`${CFG.ROOT}.info.scannedVideos`,  stats.videos);
        setS(
          CFG.HTML_STATS,
          makeLoadingStatsHTML({
            images:stats.images,
            videos:stats.videos,
            files: stats.files,
            folders:stats.folders,
            path:getS(`${CFG.ROOT}.info.scanPathCurrent`)||''
          })
        );
      };
    })();

    const progress = {
      path: (p)=> setPathThrottled(p),
      bump: ()=> { if ((++progCount % 25) === 0) updateThrottled(); }
    };

    for (const root of bases){
      if (ABORT) throw ABORT_ERR;
      await scanNode(root, stats, forceFull, progress, newPool);
    }

    // Totale setzen
    setS(`${CFG.ROOT}.totals.images`, stats.images);
    setS(`${CFG.ROOT}.totals.videos`, stats.videos);
    setS(`${CFG.ROOT}.totals.files`,  stats.files);
    setS(`${CFG.ROOT}.totals.folders`,stats.folders);

    // Index persistieren
    await saveIndex();

    // HTML final
    setS(
      CFG.HTML_STATS,
      makeStatsHTML({
        images:stats.images,
        videos:stats.videos,
        files: stats.files,
        folders:stats.folders
      })
    );

    setS(`${CFG.ROOT}.info.lastScan`, nowISO());

    // Pool übernehmen NUR wenn >0 – vorher mischen
    if (newPool.length > 0){
      shuffle(newPool);
      ACTIVE_POOL = newPool;
      BAD_SET.clear();
      setS(`${CFG.ROOT}.info.poolSize`, ACTIVE_POOL.length);
    }

    logI(`${mode==='full'?'Vollscan':'Quick-Refresh'} fertig in ${Math.round((Date.now()-started)/1000)}s. Pool=${ACTIVE_POOL.length}, Bilder=${stats.images}, Videos=${stats.videos}, Ordner=${stats.folders}`);

  }catch(e){
    const cur = getS(`${CFG.ROOT}.info.scanPathCurrent`) || '';
    log('[SynoPhotos] Scan error at path: '+cur);
    if (e===ABORT_ERR){
      logI('Scan abgebrochen.');
    }else{
      setS(`${CFG.ROOT}.info.lastError`, 'Scan error: '+e);
      log('[SynoPhotos] Scan error: '+e);
    }
  }finally{
    setS(`${CFG.ROOT}.info.scanActive`, false);
    setS(`${CFG.ROOT}.info.scanMode`,   'idle');
    SCAN_LOCK=false;
  }
}

/*** ===== MAIN ===== */
(async function main(){
  onStop(()=>{
    ABORT = true;
    try{
      if (SHOW_TIMER){
        clearInterval(SHOW_TIMER);
        SHOW_TIMER = null;
      }
    }catch(_){}
    SCAN_LOCK = false;
  }, 2000);

  await ensurePersistStates();
  await ensureFileIndexState();
  await ensurePersistDir();
  await ensureThumbsDir();
  await loadIndex();

  // 1) Pool-Seed aus Index (falls vorhanden)
  seedPoolFromIndex(CFG.poolMax);

  // 2) Slideshow-Timer immer starten
  startSlideshowTimer();

  // Platzhalter-HTML
  setS(
    CFG.HTML_STATS,
    makeStatsHTML({images:0,videos:0,files:0,folders:0})
  );
  setS(
    CFG.HTML_SHOW,
    makeShowHTML_FROM_FILE(
      `${CFG.webBase}/files/${CFG.FILE_NS}/${CFG.FILE_DIR}/single.jpg?t=${Date.now()}`,
      'Slideshow lädt …'
    )
  );

  // Controls
  on({id: `${CFG.ROOT}.control.fullScanNow`, change:'ne'}, async obj=>{
    if (obj.state && obj.state.val){
      setState(obj.id, false, true);
      try{
        await synoLogin();
        await runScan({mode:'full'});
      }catch(e){
        log('[SynoPhotos] fullScanNow error: '+e);
      }
    }
  });

  on({id: `${CFG.ROOT}.control.refreshNow`, change:'ne'}, async obj=>{
    if (obj.state && obj.state.val){
      setState(obj.id, false, true);
      try{
        await synoLogin();
        await runScan({mode:'quick'});
      }catch(e){
        log('[SynoPhotos] refreshNow error: '+e);
      }
    }
  });

  on({id: `${CFG.ROOT}.control.cancelScan`, change:'any'}, ()=>{
    ABORT = true;
  });

  // Login & Startup-Scan
  await synoLogin();

  if (CFG.startupScan === 'full'){
    await runScan({mode:'full'});
  }else if (CFG.startupScan === 'quick'){
    await runScan({mode:'quick'});
  }else{
    logI('Startup-Scan: übersprungen');
  }

  // Geplanter Quick-Refresh
  const cron = (function(sec){
    const m=Math.max(1,Math.round(sec/60));
    if (m<=59) return `*/${m} * * * *`;
    const h=Math.max(1,Math.round(m/60));
    if (h<=23) return `0 */${h} * * *`;
    return `0 3 * * *`;
  })(CFG.refreshIntervalSec);

  schedule(cron, async ()=>{
    try{
      await synoLogin();
      await runScan({mode:'quick'});
    }catch(e){
      log('[SynoPhotos] scheduled refresh error: '+e);
    }
  });

  // Cache-Aufräumer
  schedule(`*/${Math.max(1,CFG.fileCache.cleanupEveryMin)} * * * *`, ()=>{
    cleanupCacheIfNeeded().catch(()=>{});
  });

})();
