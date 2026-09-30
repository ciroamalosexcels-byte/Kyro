'use strict';
// Kyro Photo Selector — servidor local.
// Corre en la PC que guarda las fotos elegidas; la interfaz se abre desde cualquier dispositivo de la red.
//   node server.js ["C:\carpeta\con\fotos"]

process.env.UV_THREADPOOL_SIZE ??= '16'; // más lecturas en paralelo: por red cada una espera mucho

const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { exec, execFile } = require('child_process');
const media = require('./lib/media');

const PORT = Number(process.env.KYRO_PORT) || 8420;
const CONFIG_FILE = process.env.KYRO_CONFIG || path.join(__dirname, 'kyro-config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UNDOABLE_DELETES = 10;
const SKIP_DIRS = new Set(['$RECYCLE.BIN', 'System Volume Information']);
const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

// ================= Configuración (última selección) =================

let config = { src: null, dst: null, opts: {}, recent: [], preset: '', nodeId: '', manualPeers: [] };
try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch { /* primera vez */ }
if (!config.nodeId) {
  config.nodeId = crypto.randomUUID().slice(0, 8);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
const SELF = { id: config.nodeId, name: os.hostname() };

function saveConfig() {
  fsp.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2)).catch(() => {});
}

function remember(dir) {
  config.recent = [dir, ...config.recent.filter((d) => d !== dir)].slice(0, 8);
}

// ================= Red de Kyros =================
// Cada PC con Kyro se anuncia por la red local; así se pueden elegir carpetas de cualquiera de ellas.

const DISCOVERY_PORT = PORT + 1;
const PEER_TIMEOUT = 20000;
const peers = new Map(); // id -> { id, name, url, lastSeen, active, src }

const isOnline = (p) => Date.now() - p.lastSeen < PEER_TIMEOUT;

function helloJson() {
  return { kyro: 1, id: SELF.id, name: SELF.name, port: PORT, active: !!session, src: session ? session.src : '' };
}

function registerPeer(info, address) {
  if (!info?.id || info.id === SELF.id || !address) return;
  address = address.replace(/^::ffff:/, '');
  peers.set(info.id, {
    id: info.id, name: info.name || address, url: `http://${address}:${info.port || PORT}`,
    lastSeen: Date.now(), active: !!info.active, src: info.src || '',
  });
}

function peerOf(nodeId) {
  if (!nodeId || nodeId === SELF.id) return null;
  const p = peers.get(nodeId);
  if (!p || !isOnline(p)) throw new HttpError(503, `El equipo ${p?.name || ''} no está conectado. ¿Está abierto Kyro ahí?`);
  return p;
}

function nodesJson() {
  return [
    { id: SELF.id, name: SELF.name, self: true, online: true, active: !!session },
    ...[...peers.values()].map((p) => ({ id: p.id, name: p.name, url: p.url, online: isOnline(p), active: p.active, src: p.src })),
  ];
}

function broadcastAddrs() {
  const out = new Set(['255.255.255.255']);
  const toInt = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const b = (toInt(a.address) | (~toInt(a.netmask) >>> 0)) >>> 0;
      out.add([b >>> 24, (b >>> 16) & 255, (b >>> 8) & 255, b & 255].join('.'));
    }
  }
  return [...out];
}

const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
udp.on('message', (msg, rinfo) => {
  try { const info = JSON.parse(msg); if (info.kyro === 1) registerPeer(info, rinfo.address); } catch { /* no es de Kyro */ }
});
udp.on('error', () => { /* sin descubrimiento automático: quedan los equipos agregados a mano */ });

function announce() {
  const msg = Buffer.from(JSON.stringify(helloJson()));
  for (const b of broadcastAddrs()) udp.send(msg, DISCOVERY_PORT, b, () => {});
}

// Además del anuncio por la red, se saluda por HTTP a los equipos conocidos (y a los agregados por IP)
async function probe(url) {
  const res = await fetch(url + '/peer/hello', {
    headers: { 'X-Kyro-From': JSON.stringify(helloJson()) }, signal: AbortSignal.timeout(4000),
  });
  const info = await res.json();
  if (info.kyro === 1) registerPeer(info, new URL(url).hostname);
  return info;
}

function probeAll() {
  const urls = new Set([...peers.values()].map((p) => p.url));
  for (const host of config.manualPeers) urls.add(`http://${host.includes(':') ? host : `${host}:${PORT}`}`);
  for (const u of urls) probe(u).catch(() => {});
}

async function proxyJson(p, method, pathQ, body) {
  let res;
  try {
    res = await fetch(p.url + pathQ, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(90000),
    });
  } catch {
    throw new HttpError(503, `No se pudo conectar con ${p.name}. ¿Está abierto Kyro ahí?`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, data.error || `Error en ${p.name}`);
  return data;
}

// Manda un archivo a la carpeta `dir` de otro Kyro; devuelve el nombre con que quedó guardado
async function pushToPeer(p, dir, localFile, name) {
  const st = await fsp.stat(localFile);
  const u = new URL(p.url + '/peer/file');
  u.searchParams.set('dir', dir);
  u.searchParams.set('name', name);
  return new Promise((resolve, reject) => {
    const req = http.request(u, { method: 'PUT', headers: { 'Content-Length': st.size, 'X-Mtime': String(st.mtimeMs) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let data = {};
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* respuesta vacía */ }
        if (res.statusCode === 200) resolve(data.name);
        else reject(new Error(data.error || `${p.name} respondió ${res.statusCode}`));
      });
    });
    req.on('error', () => reject(new Error(`se cortó la conexión con ${p.name}`)));
    fs.createReadStream(localFile).on('error', reject).pipe(req);
  });
}

// Trae un archivo de otro Kyro (para deshacer un "mover")
function pullFromPeer(p, remotePath, localPath) {
  const u = new URL(p.url + '/peer/file');
  u.searchParams.set('path', remotePath);
  return new Promise((resolve, reject) => {
    http.get(u, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${p.name} respondió ${res.statusCode}`)); }
      const out = fs.createWriteStream(localPath, { flags: 'wx' });
      res.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    }).on('error', () => reject(new Error(`se cortó la conexión con ${p.name}`)));
  });
}

async function peerDelete(p, remotePath) {
  const u = new URL(p.url + '/peer/file');
  u.searchParams.set('path', remotePath);
  const res = await fetch(u, { method: 'DELETE', signal: AbortSignal.timeout(30000) });
  if (!res.ok && res.status !== 404) throw new Error(`${p.name} no pudo borrar la copia`);
}

// Una ubicación es { node, path }; las rutas sueltas (versiones anteriores) son de esta PC
function normLoc(x) {
  if (!x) return null;
  if (typeof x === 'string') return x ? { node: SELF.id, path: x } : null;
  return x.path ? { node: x.node || SELF.id, path: String(x.path) } : null;
}

function locLabel(loc) {
  if (!loc) return '';
  if (loc.node === SELF.id) return loc.path;
  return `${peers.get(loc.node)?.name || loc.nodeName || 'otro equipo'}: ${loc.path}`;
}

// ================= Sesión =================
// Una sola sesión compartida: el celular y la PC ven y mueven la misma lista.

let session = null;
let version = 0;
const bump = () => { version++; };
let nextId = 1;

const partsOf = (e) => [e, ...(e.companions || [])];
const splitName = (name) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot + 1) } : { base: name, ext: '' };
};

function newSession(opts, src, dst) {
  return {
    src: src.path, dst: dst.path,
    // destino en otra PC: los matches se le mandan a su Kyro
    dstPeer: dst.node === SELF.id ? null : { id: dst.node, name: peers.get(dst.node)?.name || 'otro equipo' },
    srcLabel: locLabel(src), dstLabel: locLabel(dst),
    opts: {
      likeOp: ['copy', 'move'].includes(opts.likeOp) ? opts.likeOp : 'copy',
      nopeOp: ['keep', 'discard', 'delete'].includes(opts.nopeOp) ? opts.nopeOp : 'keep',
      groupRaw: opts.groupRaw !== false, keepTree: !!opts.keepTree,
      sortBy: opts.sortBy || 'name', sortDir: opts.sortDir || 'asc',
    },
    files: [], byId: new Map(),
    index: 0, history: [], likes: 0, nopes: 0,
    queue: [], working: false, errors: [],
    thumbs: new Map(),
    scan: { running: true, cancel: false, skipDir: false, skipWaiters: [], found: 0, where: '', skipped: [], sorting: '' },
  };
}

// ---------------- Búsqueda de fotos ----------------

// Junta "IMG_1.JPG" + "IMG_1.NEF" de la misma carpeta; se muestra el JPG y el resto va en companions
function groupRawPairs(files) {
  const isRaw = (f) => media.RAW_EXT.includes(f.ext);
  const rank = (f) => (isRaw(f) ? 2 : media.NATIVE_EXT.includes(f.ext) ? 0 : 1);
  const groups = new Map();
  for (const f of files) {
    const key = f.folder + '/' + splitName(f.name).base.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const out = [];
  for (const list of groups.values()) {
    if (!list.some(isRaw) || list.every(isRaw)) { out.push(...list); continue; }
    list.sort((a, b) => rank(a) - rank(b));
    const [main, ...rest] = list;
    main.companions = rest;
    out.push(main);
  }
  return out;
}

const pathOf = (f) => (f.folder ? f.folder + '/' : '') + f.name;

function sortList(list, opts) {
  const dir = opts.sortDir === 'desc' ? -1 : 1;
  const byName = (a, b) => collator.compare(pathOf(a), pathOf(b));
  const cmp = {
    name: byName,
    date: (a, b) => (a.mtime ?? 0) - (b.mtime ?? 0) || byName(a, b),
    capture: (a, b) => (a.exif?.date?.getTime() ?? a.mtime ?? 0) - (b.exif?.date?.getTime() ?? b.mtime ?? 0) || byName(a, b),
    size: (a, b) => (a.size ?? 0) - (b.size ?? 0) || byName(a, b),
    type: (a, b) => collator.compare(a.ext, b.ext) || byName(a, b),
  }[opts.sortBy] || byName;
  list.sort((a, b) => dir * cmp(a, b));
}

function addFiles(s, list) {
  if (!list.length) return;
  const group = s.opts.groupRaw ? groupRawPairs(list) : list;
  sortList(group, { ...s.opts, sortBy: ['name', 'type'].includes(s.opts.sortBy) ? s.opts.sortBy : 'name' });
  for (const f of group) {
    f.id = nextId++;
    s.byId.set(f.id, f);
    s.files.push(f);
  }
  bump();
}

function waitSkip(s) {
  return new Promise((resolve) => s.scan.skipWaiters.push(resolve));
}

async function walk(s, dirAbs, rel) {
  if (s.scan.cancel) return;
  s.scan.where = rel || 'carpeta principal';
  bump();
  let dir;
  try {
    dir = await fsp.opendir(dirAbs);
  } catch (e) {
    s.errors.push({ name: rel || dirAbs, message: 'no se pudo abrir la carpeta: ' + e.code });
    return;
  }
  const skip = waitSkip(s).then(() => 'skip');
  const it = dir[Symbol.asyncIterator]();
  const subdirs = [];
  let batch = [];
  let seen = 0;
  try {
    while (true) {
      if (s.scan.cancel) break;
      // la foto que alguien está esperando tiene prioridad: el disco de la otra PC atiende de a una cosa
      while (photoLoads > 0 && !s.scan.cancel) await new Promise((r) => setTimeout(r, 50));
      const step = await Promise.race([it.next(), skip]);
      if (step === 'skip') { s.scan.skipped.push(rel || 'carpeta principal'); break; }
      if (step.done) break;
      const de = step.value;
      if (++seen % 200 === 0) { s.scan.where = `${rel || 'carpeta principal'} (${seen} archivos)`; bump(); }
      if (de.isDirectory()) {
        if (de.name.startsWith('.') || de.name.startsWith('$') || SKIP_DIRS.has(de.name)) continue;
        if (!rel && de.name === 'Descartadas') continue;
        const abs = path.join(dirAbs, de.name);
        if (!s.dstPeer && path.resolve(abs).toLowerCase() === path.resolve(s.dst).toLowerCase()) continue;
        subdirs.push(de.name);
        continue;
      }
      const { ext } = splitName(de.name);
      if (!media.IMAGE_EXT.has(ext.toLowerCase())) continue;
      batch.push({ dir: dirAbs, name: de.name, ext: ext.toLowerCase(), folder: rel });
      s.scan.found++;
      // en carpetas enormes se van mostrando de a tandas; se retiene el último nombre para no separar un RAW de su JPG
      if (batch.length >= 300) {
        const lastBase = splitName(batch.at(-1).name).base.toLowerCase();
        const hold = batch.filter((f) => splitName(f.name).base.toLowerCase() === lastBase);
        addFiles(s, batch.filter((f) => !hold.includes(f)));
        batch = hold;
      }
    }
  } catch (e) {
    s.errors.push({ name: rel || dirAbs, message: 'error leyendo la carpeta: ' + (e.code || e.message) });
  }
  s.scan.skipWaiters = [];
  dir.close().catch(() => {});
  addFiles(s, batch);
  subdirs.sort(collator.compare);
  for (const sub of subdirs) await walk(s, path.join(dirAbs, sub), rel ? rel + '/' + sub : sub);
}

async function runScan(s) {
  try {
    await walk(s, s.src, '');
  } finally {
    s.scan.running = false;
    s.scan.where = '';
    bump();
  }
  if (!s.scan.cancel && session === s && !['name', 'type'].includes(s.opts.sortBy)) await sortRemaining(s);
}

// ---------------- Orden ----------------

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function ensureSortData(s, list) {
  const by = s.opts.sortBy;
  if (by === 'name' || by === 'type') return;
  const need = list.filter((e) => (by === 'capture' ? e.exif === undefined : e.mtime === undefined));
  let done = 0;
  await pool(need, 8, async (e) => {
    const p = path.join(e.dir, e.name);
    if (by === 'capture') e.exif = await media.readExif(p).catch(() => null);
    const st = await fsp.stat(p).catch(() => null);
    if (st) { e.size = st.size; e.mtime = st.mtimeMs; }
    if (++done % 50 === 0) { s.scan.sorting = `Leyendo datos para ordenar… ${done} de ${need.length}`; bump(); }
  });
  s.scan.sorting = '';
}

// Reordena lo que falta ver; la foto en pantalla y las ya vistas no se mueven
async function sortRemaining(s) {
  const start = Math.min(s.index + 1, s.files.length);
  const rest = s.files.slice(start);
  s.scan.sorting = 'Ordenando…';
  bump();
  await ensureSortData(s, rest);
  sortList(rest, s.opts);
  if (session !== s) return;
  const keepCount = Math.max(start, Math.min(s.index + 1, s.files.length));
  const kept = new Set(s.files.slice(0, keepCount).map((f) => f.id));
  const inRest = new Set(rest.map((f) => f.id));
  const added = s.files.slice(start).filter((f) => !inRest.has(f.id)); // encontradas mientras se ordenaba
  s.files = s.files.slice(0, keepCount).concat(rest.filter((f) => !kept.has(f.id)), added);
  s.scan.sorting = '';
  bump();
}

// ---------------- Operaciones de archivos ----------------

async function freeName(dir, name) {
  const { base, ext } = splitName(name);
  const dot = ext ? '.' + ext : '';
  let candidate = name;
  for (let i = 1; ; i++) {
    try {
      await fsp.access(path.join(dir, candidate));
      candidate = `${base} (${i})${dot}`;
    } catch {
      return candidate;
    }
  }
}

// Mueve de verdad si se puede (conserva todo); si es otro disco o la red, copia y borra
async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch {
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    await fsp.unlink(from);
  }
}

// Carpeta de llegada; si el destino está en otra PC, la crea su Kyro al recibir el archivo
async function targetDir(s, op, entry, remote) {
  let dir = op === 'discard' ? path.join(s.src, 'Descartadas') : s.dst;
  if (s.opts.keepTree && entry.folder) dir = path.join(dir, ...entry.folder.split('/'));
  if (!remote) await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function applyOp(s, step) {
  const entry = s.byId.get(step.id);
  const { op } = step;
  if (op === 'keep') return;
  const remote = (op === 'copy' || op === 'move') && s.dstPeer;
  const target = op === 'delete' ? null : await targetDir(s, op, entry, remote);
  try {
    for (const part of partsOf(entry)) {
      const from = path.join(part.dir, part.name);
      const r = { part, dir: target };
      if (remote) {
        r.remote = true;
        r.name = await pushToPeer(peerOf(s.dstPeer.id), target, from, part.name);
        if (op === 'move') await fsp.unlink(from);
      } else if (op === 'copy') {
        r.name = await freeName(target, part.name);
        await fsp.copyFile(from, path.join(target, r.name), fs.constants.COPYFILE_EXCL);
      } else if (op === 'move' || op === 'discard') {
        r.name = await freeName(target, part.name);
        await moveFile(from, path.join(target, r.name));
      } else if (op === 'delete') {
        r.bytes = await fsp.readFile(from); // en memoria para poder deshacer
        await fsp.unlink(from);
      }
      step.parts.push(r);
    }
  } catch (e) {
    // si falló a mitad de un par RAW+JPG, se revierte lo que ya se hizo
    await revertOp(s, step).catch(() => {});
    throw e;
  }
}

async function revertOp(s, step) {
  const entry = s.byId.get(step.id);
  for (const r of [...step.parts].reverse()) {
    if (r.remote) {
      const p = peerOf(s.dstPeer.id);
      const full = path.join(r.dir, r.name);
      if (step.op === 'move') {
        const name = await freeName(r.part.dir, r.part.name);
        await pullFromPeer(p, full, path.join(r.part.dir, name));
        r.part.name = name;
      }
      await peerDelete(p, full);
    } else if (step.op === 'copy') {
      await fsp.unlink(path.join(r.dir, r.name)).catch(() => {});
    } else if (step.op === 'move' || step.op === 'discard') {
      const name = await freeName(r.part.dir, r.part.name);
      await moveFile(path.join(r.dir, r.name), path.join(r.part.dir, name));
      r.part.name = name;
    } else if (step.op === 'delete') {
      const name = await freeName(r.part.dir, r.part.name);
      await fsp.writeFile(path.join(r.part.dir, name), r.bytes, { flag: 'wx' });
      r.part.name = name;
    }
  }
  step.parts = [];
  entry.meta = null;
}

// Las operaciones corren en fila y en segundo plano: deslizar no espera a que termine la copia
async function worker(s) {
  if (s.working) return;
  s.working = true;
  while (s.queue.length) {
    const step = s.queue[0];
    step.status = 'running';
    bump();
    step.promise = applyOp(s, step).then(
      () => { step.status = 'done'; },
      (e) => {
        step.status = 'error';
        s.errors.push({ name: step.name, message: `no se pudo ${OP_VERB[step.op]}: ${e.code || e.message}` });
      },
    );
    await step.promise;
    s.queue.shift();
    trimDeletedBuffers(s);
    bump();
  }
  s.working = false;
}

const OP_VERB = { copy: 'copiar', move: 'mover', discard: 'mover a Descartadas', delete: 'borrar', keep: 'dejar' };

function trimDeletedBuffers(s) {
  let kept = 0;
  for (let i = s.history.length - 1; i >= 0; i--) {
    const st = s.history[i];
    if (st.op !== 'delete' || st.status !== 'done' || !st.parts[0]?.bytes) continue;
    if (++kept > UNDOABLE_DELETES) { st.parts.forEach((r) => { r.bytes = null; }); st.lost = true; }
  }
}

// ================= Estado para la interfaz =================

function publicEntry(e) {
  return { id: e.id, name: e.name, folder: e.folder, ext: e.ext, parts: partsOf(e).map((p) => ({ name: p.name, ext: p.ext })) };
}

function stateJson() {
  if (!session) {
    return { version, active: false, self: SELF, config: publicConfig(), preset: config.preset || '' };
  }
  const s = session;
  return {
    version, active: true, self: SELF,
    src: s.srcLabel, dst: s.dstLabel, opts: s.opts,
    index: s.index, total: s.files.length, likes: s.likes, nopes: s.nopes,
    window: s.files.slice(s.index, s.index + 3).map(publicEntry),
    history: s.history.filter((h) => !h.skip).slice(-150).map((h) => ({ id: h.id, action: h.action, name: h.name })),
    canUndo: s.history.length > 0,
    pending: s.queue.length,
    scan: { running: s.scan.running, found: s.scan.found, where: s.scan.where, sorting: s.scan.sorting },
    errors: s.errors.slice(-5).map((e, i) => ({ ...e, n: s.errors.length - Math.min(5, s.errors.length) + i })),
    preset: config.preset || '',
  };
}

function publicConfig() {
  const withName = (loc) => loc && { ...loc, nodeName: loc.node === SELF.id ? SELF.name : (peers.get(loc.node)?.name || loc.nodeName) };
  return {
    src: withName(normLoc(config.preset || config.src)),
    dst: withName(normLoc(config.dst)),
    opts: config.opts, recent: config.recent,
  };
}

function lanUrls() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254')) continue;
      const virtual = /vethernet|virtual|vmware|hyper-v|wsl|loopback|bluetooth/i.test(name);
      out.push({ url: `http://${a.address}:${PORT}`, name, virtual });
    }
  }
  return out.sort((a, b) => a.virtual - b.virtual);
}

// ================= Explorador de carpetas =================

function listShares(host) {
  return new Promise((resolve) => {
    execFile('net', ['view', `\\\\${host}`], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) return resolve([]);
      const shares = [];
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^(\S.*?)\s{2,}(Disco|Disk)\b/);
        if (m) shares.push(m[1].trim());
      }
      resolve(shares);
    });
  });
}

async function browse(p) {
  if (!p) {
    const roots = [];
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      if (fs.existsSync(`${l}:\\`)) roots.push({ name: `Disco ${l}:`, path: `${l}:\\` });
    }
    const home = os.homedir();
    const places = [['Imágenes', 'Pictures'], ['Escritorio', 'Desktop'], ['Descargas', 'Downloads'], ['Documentos', 'Documents']]
      .map(([name, dir]) => ({ name, path: path.join(home, dir) }))
      .filter((x) => fs.existsSync(x.path));
    const recent = config.recent.map((d) => ({ name: d, path: d }));
    return { path: '', parent: null, dirs: [], roots, places, recent };
  }
  const unc = p.match(/^\\\\([^\\]+)\\?$/);
  if (unc) {
    const shares = await listShares(unc[1]);
    return {
      path: p, parent: '',
      dirs: shares.map((name) => ({ name, path: `\\\\${unc[1]}\\${name}` })),
      note: shares.length ? '' : 'No se encontraron carpetas compartidas en esa PC (o no hay acceso).',
    };
  }
  const entries = await fsp.readdir(p, { withFileTypes: true });
  const dirs = entries
    .filter((d) => d.isDirectory() && !d.name.startsWith('$') && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name))
    .map((d) => ({ name: d.name, path: path.join(p, d.name) }))
    .sort((a, b) => collator.compare(a.name, b.name));
  const parsed = path.parse(p);
  const isRoot = path.resolve(p) === path.resolve(parsed.root);
  const images = entries.filter((d) => d.isFile() && media.IMAGE_EXT.has(splitName(d.name).ext.toLowerCase())).length;
  return { path: p, parent: isRoot ? '' : path.dirname(p), dirs, images };
}

// ================= Vista previa =================

const previewCache = new Map(); // id -> Promise<{buf, type, rotate, note}>
let photoLoads = 0;              // fotos leyéndose ahora (pausan la búsqueda)

function getDisplay(entry) {
  if (!previewCache.has(entry.id)) {
    photoLoads++;
    const p = (async () => {
      const file = path.join(entry.dir, entry.name);
      if (media.RAW_EXT.includes(entry.ext)) {
        const jpg = await media.rawPreview(file);
        if (!jpg) throw new Error('el RAW no trae una vista previa legible');
        return { buf: jpg.buf, type: 'image/jpeg', rotate: jpg.rotate, note: `RAW · vista previa embebida de ${jpg.w} × ${jpg.h}` };
      }
      const buf = await fsp.readFile(file);
      if (media.HEIC_EXT.includes(entry.ext)) return { buf, type: 'application/octet-stream', convert: 'heic', note: 'HEIC convertido para mostrar' };
      if (media.TIFF_EXT.includes(entry.ext)) return { buf, type: 'application/octet-stream', convert: 'tiff', note: 'TIFF convertido para mostrar' };
      return { buf, type: media.MIME[entry.ext] || 'application/octet-stream' };
    })();
    p.finally(() => { photoLoads--; }).catch(() => {});
    p.catch(() => previewCache.delete(entry.id));
    previewCache.set(entry.id, p);
    // se guardan las últimas 8 (las que están en pantalla y las precargadas)
    while (previewCache.size > 8) previewCache.delete(previewCache.keys().next().value);
  }
  return previewCache.get(entry.id);
}

async function getMeta(entry) {
  if (entry.meta) return entry.meta;
  const file = path.join(entry.dir, entry.name);
  const st = await fsp.stat(file);
  entry.size = st.size;
  entry.mtime = st.mtimeMs;
  if (entry.exif === undefined) entry.exif = await media.readExif(file).catch(() => null);
  const parts = [];
  for (const part of partsOf(entry)) {
    const size = part === entry ? st.size : (await fsp.stat(path.join(part.dir, part.name)).catch(() => ({ size: 0 }))).size;
    parts.push({ name: part.name, ext: part.ext, size });
  }
  entry.meta = { exif: entry.exif, size: st.size, mtime: st.mtimeMs, parts, root: path.basename(session?.src || '') };
  return entry.meta;
}

// ================= HTTP =================

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 5e6) { reject(new Error('pedido demasiado grande')); req.destroy(); }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

class HttpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function requireSession() {
  if (!session) throw new HttpError(409, 'No hay ninguna sesión activa');
  return session;
}

function entryById(id) {
  const e = requireSession().byId.get(Number(id));
  if (!e) throw new HttpError(404, 'Foto desconocida');
  return e;
}

const routes = {
  'GET /api/state': () => stateJson(),
  'GET /api/info': () => ({ urls: lanUrls(), port: PORT, host: os.hostname() }),
  'GET /api/config': () => publicConfig(),
  'GET /api/nodes': () => nodesJson(),

  'POST /api/add-peer': async (q, body) => {
    // "192.168.100.2" o "192.168.100.2:8420"
    const host = String(body.ip || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!host) throw new HttpError(400, 'Escribí la IP de la otra PC');
    try {
      await probe(`http://${host.includes(':') ? host : `${host}:${PORT}`}`);
    } catch {
      throw new HttpError(503, `No hay un Kyro abierto en ${host}. Abrilo en esa PC y probá de nuevo.`);
    }
    config.manualPeers = [...new Set([...config.manualPeers, host])];
    saveConfig();
    return nodesJson();
  },

  'GET /api/browse': async (q) => {
    const p = peerOf(q.get('node'));
    if (p) return proxyJson(p, 'GET', '/api/browse?path=' + encodeURIComponent(q.get('path') || ''));
    try {
      return await browse(q.get('path') || '');
    } catch (e) {
      throw new HttpError(400, `No se pudo abrir “${q.get('path')}”: ${e.code || e.message}`);
    }
  },

  'POST /api/mkdir': async (q, body) => {
    const peer = peerOf(body.node);
    if (peer) return proxyJson(peer, 'POST', '/api/mkdir', { path: body.path, name: body.name });
    const name = String(body.name || '').trim();
    if (!name || /[<>:"/\\|?*]/.test(name)) throw new HttpError(400, 'Nombre de carpeta inválido');
    const p = path.join(body.path, name);
    await fsp.mkdir(p);
    return { path: p };
  },

  'POST /api/start': async (q, body) => {
    const src = normLoc(body.src), dst = normLoc(body.dst);
    if (!src) throw new HttpError(400, 'Elegí la carpeta con las fotos');
    if (!dst) throw new HttpError(400, 'Elegí una carpeta destino');

    // Las fotos están en otra PC: la sesión corre en su Kyro (lee del disco local) y la interfaz se muda ahí
    const srcPeer = peerOf(src.node);
    if (srcPeer) {
      await probe(srcPeer.url).catch(() => {}); // que esa PC nos conozca, por si el destino es esta
      const st = await proxyJson(srcPeer, 'POST', '/api/start', { ...body, src, dst });
      return { ...st, redirect: srcPeer.url };
    }

    if (session?.queue.length) throw new HttpError(409, 'Esperá a que terminen de procesarse las fotos pendientes');
    const st = await fsp.stat(src.path).catch(() => null);
    if (!st?.isDirectory()) throw new HttpError(400, 'La carpeta de origen no existe');
    const dstPeer = peerOf(dst.node);
    if (dstPeer) {
      await proxyJson(dstPeer, 'POST', '/peer/ensure-dir', { path: dst.path });
    } else {
      if (path.resolve(src.path).toLowerCase() === path.resolve(dst.path).toLowerCase()) throw new HttpError(400, 'Origen y destino no pueden ser la misma carpeta');
      await fsp.mkdir(dst.path, { recursive: true });
    }
    if (session) session.scan.cancel = true;
    previewCache.clear();

    session = newSession(body, src, dst);
    config.src = src;
    config.dst = { ...dst, nodeName: dstPeer?.name };
    config.preset = '';
    config.opts = session.opts;
    remember(src.path);
    if (!dstPeer) remember(dst.path);
    saveConfig();
    bump();
    runScan(session).catch((e) => session?.errors.push({ name: 'búsqueda', message: e.message }));
    return stateJson();
  },

  'POST /api/stop': () => {
    if (session?.queue.length) throw new HttpError(409, 'Esperá a que terminen de procesarse las fotos pendientes');
    if (session) session.scan.cancel = true;
    session = null;
    bump();
    return stateJson();
  },

  'POST /api/decide': (q, body) => {
    const s = requireSession();
    const entry = s.files[s.index];
    if (!entry || body.id !== entry.id) throw new HttpError(409, 'Otro dispositivo ya avanzó; se actualizó la foto');
    const action = body.action === 'like' ? 'like' : 'nope';
    const op = action === 'like' ? s.opts.likeOp : s.opts.nopeOp;
    const step = { id: entry.id, index: s.index, action, op, name: entry.name, parts: [], status: 'pending' };
    if (typeof body.thumb === 'string' && body.thumb.startsWith('data:image/')) s.thumbs.set(entry.id, body.thumb);
    s.history.push(step);
    if (action === 'like') s.likes++; else s.nopes++;
    s.index++;
    if (op === 'keep') step.status = 'done';
    else { s.queue.push(step); worker(s); }
    bump();
    return stateJson();
  },

  'POST /api/undo': async () => {
    const s = requireSession();
    const step = s.history.at(-1);
    if (!step) throw new HttpError(409, 'No hay nada para deshacer');
    if (step.skip) {
      s.history.pop();
      s.index = step.index;
      bump();
      return stateJson();
    }
    if (step.lost) throw new HttpError(409, 'Esa foto ya se borró definitivamente, no se puede recuperar');
    s.history.pop();
    if (step.status === 'pending') {
      s.queue.splice(s.queue.indexOf(step), 1); // todavía no se hizo nada
    } else {
      if (step.status === 'running') await step.promise;
      if (step.status === 'done') {
        try { await revertOp(s, step); } catch (e) {
          s.history.push(step);
          throw new HttpError(500, 'No se pudo deshacer: ' + (e.code || e.message));
        }
      }
    }
    if (step.action === 'like') s.likes--; else s.nopes--;
    s.thumbs.delete(step.id);
    previewCache.delete(step.id);
    s.index = step.index;
    bump();
    return stateJson();
  },

  'POST /api/skip-folder': (q, body) => {
    const s = requireSession();
    const entry = s.files[s.index];
    if (!entry || body.id !== entry.id) throw new HttpError(409, 'Otro dispositivo ya avanzó');
    let next = s.index + 1;
    while (next < s.files.length && s.files[next].folder === entry.folder) next++;
    s.history.push({ skip: true, index: s.index });
    s.index = next;
    bump();
    return { ...stateJson(), skipped: next - s.history.at(-1).index };
  },

  'POST /api/skip-scan-dir': () => {
    const s = requireSession();
    s.scan.skipWaiters.forEach((r) => r());
    s.scan.skipWaiters = [];
    return stateJson();
  },

  'POST /api/cancel-scan': () => {
    const s = requireSession();
    s.scan.cancel = true;
    s.scan.skipWaiters.forEach((r) => r());
    return stateJson();
  },

  'POST /api/sort': (q, body) => {
    const s = requireSession();
    s.opts.sortBy = body.sortBy || s.opts.sortBy;
    s.opts.sortDir = body.sortDir || s.opts.sortDir;
    config.opts = s.opts;
    saveConfig();
    sortRemaining(s).catch(() => {});
    return stateJson();
  },

  'POST /api/preset': (q, body) => {
    config.preset = String(body.src || '');
    bump();
    return { ok: true };
  },

  'POST /api/clear-preset': () => {
    config.preset = '';
    bump();
    return stateJson();
  },

  'GET /api/meta': async (q) => getMeta(entryById(q.get('id'))),

  'POST /peer/ensure-dir': async (q, body) => {
    await fsp.mkdir(String(body.path), { recursive: true });
    return { ok: true };
  },
};

// ---------- Archivos pedidos por otro Kyro (destino en esta PC) ----------

async function handlePeerFile(req, res, q) {
  if (req.method === 'PUT') {
    const dir = q.get('dir'), name = path.basename(q.get('name') || '');
    if (!dir || !name) return sendJson(res, 400, { error: 'Faltan datos' });
    await fsp.mkdir(dir, { recursive: true });
    const finalName = await freeName(dir, name);
    const full = path.join(dir, finalName);
    const out = fs.createWriteStream(full, { flags: 'wx' });
    req.pipe(out);
    out.on('finish', async () => {
      const mtime = Number(req.headers['x-mtime']);
      if (mtime) await fsp.utimes(full, new Date(), new Date(mtime)).catch(() => {}); // conserva la fecha original
      sendJson(res, 200, { name: finalName });
    });
    out.on('error', (e) => sendJson(res, 500, { error: 'no se pudo guardar: ' + (e.code || e.message) }));
    req.on('aborted', () => { out.destroy(); fsp.unlink(full).catch(() => {}); });
    return;
  }
  const file = q.get('path');
  if (!file) return sendJson(res, 400, { error: 'Falta la ruta' });
  if (req.method === 'GET') {
    const st = await fsp.stat(file).catch(() => null);
    if (!st) return sendJson(res, 404, { error: 'No existe' });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === 'DELETE') {
    await fsp.unlink(file).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    return sendJson(res, 200, { ok: true });
  }
  sendJson(res, 405, { error: 'Método no permitido' });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
  }

  if (url.pathname === '/peer/hello') {
    try { registerPeer(JSON.parse(req.headers['x-kyro-from'] || 'null'), req.socket.remoteAddress); } catch { /* saludo sin datos */ }
    return sendJson(res, 200, helloJson());
  }

  if (url.pathname === '/peer/file') {
    try { return await handlePeerFile(req, res, q); } catch (e) { return sendJson(res, 500, { error: e.code || e.message }); }
  }

  const photo = url.pathname.match(/^\/api\/photo\/(\d+)$/);
  if (photo && req.method === 'GET') {
    try {
      const d = await getDisplay(entryById(photo[1]));
      const headers = { 'Content-Type': d.type, 'Content-Length': d.buf.length, 'Cache-Control': 'no-store' };
      if (d.rotate) headers['X-Orientation'] = String(d.rotate);
      if (d.convert) headers['X-Convert'] = d.convert;
      if (d.note) headers['X-Note'] = encodeURIComponent(d.note);
      res.writeHead(200, headers);
      return res.end(d.buf);
    } catch (e) {
      return sendJson(res, e.code === 404 ? 404 : 500, { error: e.message });
    }
  }

  const thumb = url.pathname.match(/^\/api\/thumb\/(\d+)$/);
  if (thumb && req.method === 'GET') {
    const data = session?.thumbs.get(Number(thumb[1]));
    if (!data) { res.writeHead(404); return res.end(); }
    const [meta, b64] = data.split(',');
    res.writeHead(200, { 'Content-Type': meta.slice(5).split(';')[0], 'Cache-Control': 'private, max-age=86400' });
    return res.end(Buffer.from(b64, 'base64'));
  }

  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) return sendJson(res, 404, { error: 'No existe' });
  try {
    const body = req.method === 'POST' ? await readBody(req) : null;
    sendJson(res, 200, await route(q, body));
  } catch (e) {
    const code = e instanceof HttpError ? e.code : 500;
    sendJson(res, code, { error: e.message, state: stateJson() });
  }
}

// ================= Arranque =================

function openBrowser(url) {
  if (process.argv.includes('--no-open')) return;
  exec(`start "" "${url}"`, { windowsHide: true });
}

const presetArg = process.argv.slice(2).find((a) => !a.startsWith('--'));

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => { try { sendJson(res, 500, { error: e.message }); } catch { /* ya respondido */ } });
});

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  // Kyro ya está abierto: se le pasa la carpeta elegida y se abre el navegador
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/preset', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {
    openBrowser(`http://localhost:${PORT}`);
    setTimeout(() => process.exit(0), 500);
  });
  req.on('error', () => { console.error(`El puerto ${PORT} está ocupado por otro programa.`); process.exit(1); });
  req.end(JSON.stringify({ src: presetArg || '' }));
});

server.listen(PORT, '0.0.0.0', () => {
  if (presetArg) { config.preset = presetArg; }
  udp.bind(DISCOVERY_PORT, () => {
    udp.setBroadcast(true);
    announce();
    setInterval(announce, 5000);
  });
  probeAll();
  setInterval(probeAll, 5000);
  console.log('\n  Kyro Photo Selector está funcionando.\n');
  console.log(`  En esta PC:     http://localhost:${PORT}`);
  for (const u of lanUrls().filter((x) => !x.virtual)) console.log(`  Desde la red:   ${u.url}   (${u.name})`);
  console.log('\n  Dejá esta ventana abierta mientras lo usás. Para cerrarlo, cerrá la ventana.\n');
  openBrowser(`http://localhost:${PORT}`);
});
