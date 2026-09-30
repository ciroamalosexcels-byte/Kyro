'use strict';
// Lectura de metadata EXIF y de las vistas previas que traen adentro los RAW.
// Se leen solo los bytes necesarios: por red, bajar un RAW entero (20-60 MB) es lo que más tarda.

const fsp = require('fs').promises;

const NATIVE_EXT = ['jpg', 'jpeg', 'jfif', 'jpe', 'png', 'apng', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico'];
const RAW_EXT = ['cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'orf', 'rw2', 'raf', 'pef', 'ptx',
  'srw', 'x3f', 'rwl', '3fr', 'fff', 'iiq', 'mef', 'mos', 'erf', 'kdc', 'dcr', 'mrw', 'raw'];
const HEIC_EXT = ['heic', 'heif', 'hif'];
const TIFF_EXT = ['tif', 'tiff'];
const IMAGE_EXT = new Set([...NATIVE_EXT, ...RAW_EXT, ...HEIC_EXT, ...TIFF_EXT]);

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', jpe: 'image/jpeg',
  png: 'image/png', apng: 'image/apng', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon',
};

const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);

async function readRange(fh, pos, len) {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const { bytesRead } = await fh.read(buf, off, len - off, pos + off);
    if (!bytesRead) break;
    off += bytesRead;
  }
  return buf.subarray(0, off);
}

async function readHead(filePath, len) {
  const fh = await fsp.open(filePath, 'r');
  try { return await readRange(fh, 0, len); } finally { await fh.close(); }
}

function indexOfBytes(u8, str, from = 0) {
  const b = [...str].map((c) => c.charCodeAt(0));
  outer: for (let i = from; i <= u8.length - b.length; i++) {
    for (let k = 0; k < b.length; k++) if (u8[i + k] !== b[k]) continue outer;
    return i;
  }
  return -1;
}

// ---------------- EXIF ----------------

function parseTiff(buf, start) {
  const u8 = new Uint8Array(buf);
  const v = new DataView(buf);
  const le = v.getUint16(start) === 0x4949;
  const u16 = (o) => v.getUint16(start + o, le);
  const u32 = (o) => v.getUint32(start + o, le);
  const i32 = (o) => v.getInt32(start + o, le);
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  const readValue = (type, count, entry) => {
    const size = (SIZE[type] || 1) * count;
    const off = size > 4 ? u32(entry + 8) : entry + 8;
    if (start + off + size > buf.byteLength) return undefined;
    const out = [];
    for (let i = 0; i < count; i++) {
      if (type === 2) return Buffer.from(u8.subarray(start + off, start + off + count)).toString('latin1').replace(/\0.*$/s, '').trim();
      if (type === 3) out.push(u16(off + i * 2));
      else if (type === 4) out.push(u32(off + i * 4));
      else if (type === 9) out.push(i32(off + i * 4));
      else if (type === 5) out.push(u32(off + i * 8) / (u32(off + i * 8 + 4) || 1));
      else if (type === 10) out.push(i32(off + i * 8) / (i32(off + i * 8 + 4) || 1));
      else return undefined;
    }
    return count === 1 ? out[0] : out;
  };
  const readIFD = (off) => {
    const tags = {};
    if (!off || start + off + 2 > buf.byteLength) return tags;
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (start + e + 12 > buf.byteLength) break;
      try { tags[u16(e)] = readValue(u16(e + 2), u32(e + 4), e); } catch { /* tag ilegible */ }
    }
    return tags;
  };

  const ifd0 = readIFD(u32(4));
  return {
    ifd0,
    ex: readIFD(ifd0[0x8769]),
    gps: ifd0[0x8825] ? readIFD(ifd0[0x8825]) : {},
  };
}

// Busca el bloque TIFF con la metadata: JPG/WebP/HEIC ("Exif\0\0"), RAW basados en TIFF
// (CR2, NEF, ARW, DNG, ORF, RW2, PEF…) y CR3 (cajas CMT1/CMT2/CMT4)
function exifFromBuffer(b) {
  try {
    const buf = toAB(b);
    const u8 = new Uint8Array(buf);
    const isTiff = (u8[0] === 0x49 && u8[1] === 0x49) || (u8[0] === 0x4D && u8[1] === 0x4D);
    const exifAt = () => { const i = indexOfBytes(u8, 'Exif\0\0'); return i >= 0 ? parseTiff(buf, i + 6) : null; };
    let t = null;
    if (isTiff) {
      t = parseTiff(buf, 0);
      // algunos RAW (p. ej. RW2) guardan la exposición en el JPG embebido
      if (!Object.keys(t.ex).length) { const e = exifAt(); if (e) t.ex = e.ex; }
    } else if (indexOfBytes(u8, 'CMT1') >= 0) {
      t = parseTiff(buf, indexOfBytes(u8, 'CMT1') + 4);
      const c2 = indexOfBytes(u8, 'CMT2'), c4 = indexOfBytes(u8, 'CMT4');
      if (c2 >= 0) t.ex = parseTiff(buf, c2 + 4).ifd0;
      if (c4 >= 0) t.gps = parseTiff(buf, c4 + 4).ifd0;
    } else {
      t = exifAt();
    }
    if (!t) return null;
    const { ifd0, ex, gps } = t;

    const toDate = (s) => {
      const m = typeof s === 'string' && s.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
      return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
    };
    const dms = (a, ref) => Array.isArray(a) ? (a[0] + a[1] / 60 + a[2] / 3600) * (ref === 'S' || ref === 'W' ? -1 : 1) : null;
    const lat = dms(gps[2], gps[1]);
    const lon = dms(gps[4], gps[3]);
    const str = (s) => (typeof s === 'string' && s ? s : undefined);

    return {
      make: str(ifd0[0x010F]), model: str(ifd0[0x0110]), software: str(ifd0[0x0131]),
      artist: str(ifd0[0x013B]), copyright: str(ifd0[0x8298]), orientation: ifd0[0x0112],
      date: toDate(ex[0x9003]) || toDate(ifd0[0x0132]),
      exposure: ex[0x829A], fnumber: ex[0x829D], program: ex[0x8822],
      iso: Array.isArray(ex[0x8827]) ? ex[0x8827][0] : ex[0x8827],
      ev: ex[0x9204], metering: ex[0x9207], flash: ex[0x9209],
      focal: ex[0x920A], focal35: ex[0xA405],
      colorSpace: ex[0xA001], wb: ex[0xA403],
      lensMake: str(ex[0xA433]), lens: str(ex[0xA434]) || str(ifd0[0xA434]), serial: str(ex[0xA431]),
      gps: lat != null && lon != null && !(lat === 0 && lon === 0) ? { lat, lon } : null,
    };
  } catch {
    return null;
  }
}

async function readExif(filePath) {
  return exifFromBuffer(await readHead(filePath, 1024 * 1024));
}

// ---------------- Vista previa de RAW ----------------

function parseJpegAt(u8, start) {
  let p = start + 2, w = 0, h = 0;
  while (p + 4 <= u8.length) {
    if (u8[p] !== 0xFF) return null;
    const m = u8[p + 1];
    if (m === 0xFF) { p++; continue; }
    if (m === 0xD9) return null;
    if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { p += 2; continue; }
    const len = (u8[p + 2] << 8) | u8[p + 3];
    if (len < 2) return null;
    if (m === 0xC0 || m === 0xC1 || m === 0xC2) {
      h = (u8[p + 5] << 8) | u8[p + 6];
      w = (u8[p + 7] << 8) | u8[p + 8];
    } else if (m >= 0xC3 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return null; // JPEG sin pérdida (datos RAW): el navegador no lo decodifica
    }
    if (m === 0xDA) {
      if (!w || !h) return null;
      for (let q = p + 2 + len; q < u8.length - 1; q++) {
        if (u8[q] === 0xFF && u8[q + 1] === 0xD9) return { start, end: q + 2, w, h };
      }
      return null;
    }
    p += 2 + len;
  }
  return null;
}

// ¿Empieza con un JPG que el navegador puede mostrar? (no el JPEG sin pérdida de los datos RAW)
function jpegHeaderOk(u8) {
  if (u8[0] !== 0xFF || u8[1] !== 0xD8) return false;
  let p = 2;
  while (p + 4 <= u8.length) {
    if (u8[p] !== 0xFF) return false;
    const m = u8[p + 1];
    if (m === 0xFF) { p++; continue; }
    if (m === 0xC0 || m === 0xC1 || m === 0xC2) return true;
    if (m >= 0xC3 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return false;
    if (m === 0xDA) return false;
    p += 2 + ((u8[p + 2] << 8) | u8[p + 3]);
  }
  return false;
}

function findLargestJpeg(u8) {
  let best = null;
  for (let i = 0; i < u8.length - 3; i++) {
    if (u8[i] !== 0xFF || u8[i + 1] !== 0xD8 || u8[i + 2] !== 0xFF) continue;
    const jpg = parseJpegAt(u8, i);
    if (!jpg) continue;
    if (!best || jpg.w * jpg.h > best.w * best.h) best = jpg;
    i = jpg.end - 1;
  }
  return best;
}

// Recorre IFD0, SubIFDs e IFDs encadenados buscando JPG embebidos (NEF, CR2, ARW, DNG, PEF, ORF, RW2…)
function tiffJpegCandidates(buf) {
  const v = new DataView(buf);
  const le = v.getUint16(0) === 0x4949;
  const u16 = (o) => v.getUint16(o, le);
  const u32 = (o) => v.getUint32(o, le);
  const out = [];
  const seen = new Set();
  const values = (e) => {
    const type = u16(e + 2), count = u32(e + 4), size = type === 3 ? 2 : 4;
    const off = count * size > 4 ? u32(e + 8) : e + 8;
    const vals = [];
    for (let i = 0; i < Math.min(count, 64); i++) vals.push(type === 3 ? u16(off + i * size) : u32(off + i * size));
    return vals;
  };
  const walk = (off, depth) => {
    if (!off || depth > 5 || seen.has(off) || off + 2 > buf.byteLength) return;
    seen.add(off);
    const n = u16(off);
    const t = {};
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > buf.byteLength) return;
      const tag = u16(e);
      try {
        if (tag === 0x002E) out.push({ off: u32(e + 8), len: u32(e + 4) }); // RW2: JpgFromRaw
        else if ([0x0103, 0x0111, 0x0117, 0x0201, 0x0202, 0x014A].includes(tag)) t[tag] = values(e);
      } catch { /* fuera del encabezado leído */ }
    }
    if (t[0x0201] && t[0x0202]) out.push({ off: t[0x0201][0], len: t[0x0202][0] });
    if (t[0x0103] && [6, 7].includes(t[0x0103][0]) && t[0x0111]?.length === 1 && t[0x0117]) {
      out.push({ off: t[0x0111][0], len: t[0x0117][0] });
    }
    (t[0x014A] || []).forEach((o) => walk(o, depth + 1));
    const nextAt = off + 2 + n * 12;
    if (nextAt + 4 <= buf.byteLength) walk(u32(nextAt), depth + 1);
  };
  try { walk(u32(4), 0); } catch { /* encabezado raro: se usa el camino lento */ }
  return out;
}

// Devuelve { buf, w, h, rotate } con el JPG más grande que trae el RAW.
// rotate: orientación EXIF a aplicar (la vista previa suele venir sin rotar).
async function rawPreview(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const head = await readRange(fh, 0, Math.min(size, 1024 * 1024));
    let cands = [];
    if (indexOfBytes(head.subarray(0, 16), 'FUJIFILM') === 0) {
      cands.push({ off: head.readUInt32BE(84), len: head.readUInt32BE(88) }); // RAF: posición y largo del JPG
    } else if ((head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4D && head[1] === 0x4D)) {
      cands = tiffJpegCandidates(toAB(head));
    }
    // la más grande primero; lo que ocupa más de la mitad del archivo son los datos RAW, no una vista previa
    cands = cands.filter((c) => c.len > 0 && c.off + c.len <= size && c.len < size * 0.6)
      .sort((a, b) => b.len - a.len);

    let jpeg = null;
    for (const c of cands) {
      const probe = await readRange(fh, c.off, Math.min(c.len, 65536));
      if (!jpegHeaderOk(probe)) continue;
      const bytes = await readRange(fh, c.off, c.len);
      const j = parseJpegAt(bytes, 0);
      if (j) { jpeg = { buf: bytes.subarray(0, j.end), w: j.w, h: j.h }; break; }
    }
    if (!jpeg) {
      // camino lento (CR3 y formatos raros): se lee todo y se busca el JPG más grande
      const all = await readRange(fh, 0, size);
      const j = findLargestJpeg(all);
      if (j) jpeg = { buf: all.subarray(j.start, j.end), w: j.w, h: j.h };
    }
    if (!jpeg) return null;

    const rawOrientation = exifFromBuffer(head)?.orientation;
    const own = exifFromBuffer(jpeg.buf.subarray(0, Math.min(jpeg.buf.length, 128 * 1024)));
    jpeg.rotate = [3, 6, 8].includes(rawOrientation) && !(own?.orientation > 1) ? rawOrientation : 0;
    return jpeg;
  } finally {
    await fh.close();
  }
}

module.exports = {
  NATIVE_EXT, RAW_EXT, HEIC_EXT, TIFF_EXT, IMAGE_EXT, MIME,
  readExif, rawPreview,
};
