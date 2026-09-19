// MPEG-TS (H.264 + AAC) -> MP4, without re-encoding: the very same video and audio
// frames are repackaged, so the quality is identical to the .ts.
//
// Streams through the input once. Frames go straight into 'mdat'; the per-frame tables
// (a few MB even for a long episode) stay in memory and the 'moov' index is written at the
// end, like ffmpeg's default output. Offsets are always 64-bit so >4 GB (4K) files work.

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const WRAP = 2 ** 33; // MPEG-TS timestamps are 33-bit (90 kHz)

class Grow {
  constructor(Type, size = 1 << 14) { this.a = new Type(size); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) { const b = new this.a.constructor(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  get(i) { return this.a[i]; }
}

// ---------- tiny byte writer for boxes ----------

class W {
  constructor() { this.buf = new Uint8Array(1024); this.n = 0; }
  need(k) {
    if (this.n + k <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.n + k) size *= 2;
    const b = new Uint8Array(size); b.set(this.buf.subarray(0, this.n)); this.buf = b;
  }
  u8(v) { this.need(1); this.buf[this.n++] = v & 0xff; return this; }
  u16(v) { return this.u8(v >>> 8).u8(v); }
  u24(v) { return this.u8(v >>> 16).u8(v >>> 8).u8(v); }
  u32(v) { return this.u8(v >>> 24).u8(v >>> 16).u8(v >>> 8).u8(v); }
  i32(v) { return this.u32(v >>> 0); }
  u64(v) { const hi = Math.floor(v / 2 ** 32); return this.u32(hi).u32(v - hi * 2 ** 32); }
  str(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); return this; }
  bytes(b) { this.need(b.length); this.buf.set(b, this.n); this.n += b.length; return this; }
  zeros(k) { this.need(k); this.buf.fill(0, this.n, this.n + k); this.n += k; return this; }
  out() { return this.buf.subarray(0, this.n); }
}

function box(type, ...parts) {
  let len = 8;
  for (const p of parts) len += p.length;
  const w = new W();
  w.u32(len).str(type);
  for (const p of parts) w.bytes(p);
  return w.out();
}
const full = (type, version, flags, body) => box(type, new W().u8(version).u24(flags).bytes(body).out());

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

// ---------- H.264 SPS: picture size and pixel aspect ----------

function unescapeRbsp(nal) {
  const out = new Uint8Array(nal.length);
  let n = 0;
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0 && i + 1 < nal.length && nal[i + 1] <= 3) continue;
    out[n++] = nal[i];
  }
  return out.subarray(0, n);
}

class Bits {
  constructor(b) { this.b = b; this.p = 0; }
  u(k) { let v = 0; for (let i = 0; i < k; i++) { v = v * 2 + ((this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1); this.p++; } return v; }
  ue() { let z = 0; while (this.u(1) === 0 && z < 32) z++; return 2 ** z - 1 + this.u(z); }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; }
}

export function parseSps(nal) {
  const r = new Bits(unescapeRbsp(nal));
  r.u(8); // NAL header
  const profile = r.u(8); r.u(8); r.u(8); r.ue();
  let chroma = 1, depthY = 0, depthC = 0;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = r.ue();
    if (chroma === 3) r.u(1);
    depthY = r.ue(); depthC = r.ue(); r.u(1);
    if (r.u(1)) {
      for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
        if (!r.u(1)) continue;
        let last = 8, next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (next !== 0) next = (last + r.se() + 256) % 256;
          last = next === 0 ? last : next;
        }
      }
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) { r.u(1); r.se(); r.se(); const k = r.ue(); for (let i = 0; i < k; i++) r.se(); }
  r.ue(); r.u(1);
  const wMbs = r.ue() + 1;
  const hMap = r.ue() + 1;
  const frameMbsOnly = r.u(1);
  if (!frameMbsOnly) r.u(1);
  r.u(1);
  let cl = 0, cr = 0, ct = 0, cb = 0;
  if (r.u(1)) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
  let sarW = 1, sarH = 1;
  if (r.u(1) && r.u(1)) {
    const idc = r.u(8);
    const table = [[1, 1], [1, 1], [12, 11], [10, 11], [16, 11], [40, 33], [24, 11], [20, 11], [32, 11], [80, 33], [18, 11], [15, 11], [64, 33], [160, 99], [4, 3], [3, 2], [2, 1]];
    if (idc === 255) { sarW = r.u(16); sarH = r.u(16); } else if (table[idc]) [sarW, sarH] = table[idc];
    if (!sarW || !sarH) { sarW = 1; sarH = 1; }
  }
  const subW = chroma === 1 || chroma === 2 ? 2 : 1;
  const subH = chroma === 1 ? 2 : 1;
  const cropX = chroma === 0 ? 1 : subW;
  const cropY = (chroma === 0 ? 1 : subH) * (2 - frameMbsOnly);
  return {
    profile, chroma, depthY, depthC, sarW, sarH,
    width: wMbs * 16 - cropX * (cl + cr),
    height: (2 - frameMbsOnly) * hMap * 16 - cropY * (ct + cb),
  };
}

// Splits an Annex B byte stream into NAL units (without start codes).
function nalUnits(data) {
  const out = [];
  const n = data.length;
  let i = 0;
  let start = -1;
  while (i + 2 < n) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && data[end - 1] === 0) end--; // trailing zero of a 4-byte start code
        if (end > start) out.push(data.subarray(start, end));
      }
      i += 3;
      start = i;
    } else i++;
  }
  if (start >= 0 && start < n) out.push(data.subarray(start, n));
  return out;
}

function concat(chunks, total) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const readPts = (b, p) => ((b[p] >> 1) & 7) * 2 ** 30 + (b[p + 1] << 22) + ((b[p + 2] >> 1) << 15) + (b[p + 3] << 7) + (b[p + 4] >> 1);

/**
 * sink.write(bytes)            append at the current end
 * sink.writeAt(position, bytes) overwrite (used once, to fill in the mdat size)
 */
export class TsToMp4 {
  constructor(sink) {
    this.sink = sink;
    this.carry = new Uint8Array(0);
    this.pmtPid = null;
    this.videoPid = null;
    this.audioPid = null;
    this.pes = new Map(); // pid -> { chunks, len, pts, dts }
    this.out = new Uint8Array(8 << 20);
    this.outN = 0;
    this.pos = 0;
    this.lastTrack = null;
    this.v = {
      sizes: new Grow(Uint32Array), dts: new Grow(Float64Array), cts: new Grow(Int32Array), sync: new Grow(Uint32Array),
      chunkOff: new Grow(Float64Array), chunkCount: new Grow(Uint32Array),
      sps: null, pps: null, info: null, dts0: null, lastDts: null, lastPts: null, minPts: Infinity,
    };
    this.a = {
      sizes: new Grow(Uint32Array), chunkOff: new Grow(Float64Array), chunkCount: new Grow(Uint32Array),
      rate: 0, sfIndex: 0, channels: 0, objectType: 2, firstPts: null, lastPts: null, carry: null,
    };
    // ftyp + 64-bit mdat header (size filled in at the end)
    const ftyp = box('ftyp', new W().str('isom').u32(512).str('isom').str('iso2').str('avc1').str('mp41').out());
    this.mdatStart = ftyp.length;
    this.emitSync(ftyp);
    this.emitSync(new W().u32(1).str('mdat').u64(0).out());
  }

  // Output is batched into big writes. Once the batch is full, everything after it waits in
  // `overflow` (in order) until the next flush, so bytes can never be written out of order.
  // Callers only pass freshly allocated arrays, so keeping references is safe.
  emitSync(bytes) {
    this.pos += bytes.length;
    if (this.overflow || this.outN + bytes.length > this.out.length) {
      (this.overflow || (this.overflow = [])).push(bytes);
      this.pendingFlush = true;
      return;
    }
    this.out.set(bytes, this.outN);
    this.outN += bytes.length;
  }

  async flush() {
    if (this.outN) {
      await this.sink.write(this.out.slice(0, this.outN));
      this.outN = 0;
    }
    if (this.overflow) {
      const list = this.overflow;
      this.overflow = null;
      for (const b of list) await this.sink.write(b);
    }
    this.pendingFlush = false;
  }

  /** Feed any amount of TS bytes. */
  async push(chunk) {
    let data = chunk;
    if (this.carry.length) {
      data = new Uint8Array(this.carry.length + chunk.length);
      data.set(this.carry);
      data.set(chunk, this.carry.length);
    }
    let i = 0;
    for (; i + 188 <= data.length; i += 188) {
      if (data[i] !== 0x47) throw new Error('The video file is damaged (lost MPEG-TS sync)');
      this.packet(data, i);
      if (this.pendingFlush) await this.flush();
    }
    this.carry = data.slice(i);
    // Frames still being collected point into `data`, which the caller may reuse: copy them out.
    for (const pes of this.pes.values()) {
      if (pes.chunks.length) pes.chunks = [concat(pes.chunks, pes.len).slice()];
    }
    if (this.outN > (6 << 20) || this.overflow) await this.flush();
  }

  packet(b, i) {
    const pid = ((b[i + 1] & 0x1f) << 8) | b[i + 2];
    const pusi = b[i + 1] & 0x40;
    const afc = (b[i + 3] >> 4) & 3;
    let p = i + 4;
    if (afc & 2) p += 1 + b[p];
    if (!(afc & 1) || p >= i + 188) return;
    const end = i + 188;

    if (pid === 0 && this.pmtPid === null) {
      if (!pusi) return;
      const q = p + 1 + b[p];
      this.pmtPid = ((b[q + 10] & 0x1f) << 8) | b[q + 11];
      return;
    }
    if (pid === this.pmtPid && this.videoPid === null) {
      if (!pusi) return;
      const q = p + 1 + b[p];
      const secLen = ((b[q + 1] & 0x0f) << 8) | b[q + 2];
      const infoLen = ((b[q + 10] & 0x0f) << 8) | b[q + 11];
      const stop = Math.min(q + 3 + secLen - 4, end);
      for (let r = q + 12 + infoLen; r + 5 <= stop;) {
        const type = b[r];
        const epid = ((b[r + 1] & 0x1f) << 8) | b[r + 2];
        if (type === 0x1b && this.videoPid === null) this.videoPid = epid;
        if (type === 0x0f && this.audioPid === null) this.audioPid = epid;
        r += 5 + (((b[r + 3] & 0x0f) << 8) | b[r + 4]);
      }
      if (this.videoPid === null) throw new Error('No H.264 video in this stream (MP4 conversion supports H.264 only)');
      return;
    }
    if (pid !== this.videoPid && pid !== this.audioPid) return;

    if (pusi) {
      this.finishPes(pid);
      if (b[p] !== 0 || b[p + 1] !== 0 || b[p + 2] !== 1) return;
      const flags = b[p + 7] >> 6;
      const hdrLen = b[p + 8];
      const pts = flags & 2 ? readPts(b, p + 9) : null;
      const dts = flags === 3 ? readPts(b, p + 14) : pts;
      const start = p + 9 + hdrLen;
      const pes = { chunks: [], len: 0, pts, dts };
      if (start < end) { pes.chunks.push(b.subarray(start, end)); pes.len += end - start; }
      this.pes.set(pid, pes);
    } else {
      const pes = this.pes.get(pid);
      if (!pes) return;
      pes.chunks.push(b.subarray(p, end));
      pes.len += end - p;
    }
  }

  finishPes(pid) {
    const pes = this.pes.get(pid);
    if (!pes) return;
    this.pes.delete(pid);
    if (!pes.len) return;
    // Processed right away (samples are copied out), so no copy of the input is needed here.
    const data = concat(pes.chunks, pes.len);
    if (pid === this.videoPid) this.video(data, pes.pts, pes.dts);
    else this.audio(data, pes.pts);
  }

  static unwrap(ts, last) {
    if (ts === null || last === null) return ts;
    while (ts < last - WRAP / 2) ts += WRAP;
    while (ts > last + WRAP / 2) ts -= WRAP;
    return ts;
  }

  writeSample(track, bytes) {
    if (this.lastTrack !== track || track.chunkOff.n === 0) {
      track.chunkOff.push(this.pos);
      track.chunkCount.push(1);
    } else {
      track.chunkCount.a[track.chunkCount.n - 1]++;
    }
    this.lastTrack = track;
    track.sizes.push(bytes.length);
    this.emitSync(bytes);
  }

  video(data, pts, dts) {
    const v = this.v;
    if (pts === null) return;
    pts = TsToMp4.unwrap(pts, v.lastPts ?? pts);
    dts = TsToMp4.unwrap(dts, v.lastDts ?? pts);
    const keep = [];
    let key = false;
    let vcl = false;
    for (const nal of nalUnits(data)) {
      const type = nal[0] & 0x1f;
      if (type === 9) continue;                         // access unit delimiter
      if (type === 7) { if (!v.sps) { v.sps = nal.slice(); v.info = parseSps(v.sps); } continue; }
      if (type === 8) { if (!v.pps) v.pps = nal.slice(); continue; }
      if (type === 5) key = true;
      if (type >= 1 && type <= 5) vcl = true;
      keep.push(nal);
    }
    if (!vcl) return;
    if (v.dts0 === null) {
      if (!key || !v.sps || !v.pps) return;               // start on a clean keyframe
      v.dts0 = dts;
    }
    if (v.lastDts !== null && dts <= v.lastDts) dts = v.lastDts + 1; // keep decode order strictly increasing
    if (pts < dts) pts = dts;
    let size = 0;
    for (const nal of keep) size += 4 + nal.length;
    const sample = new Uint8Array(size);
    let o = 0;
    for (const nal of keep) {
      const n = nal.length;
      sample[o] = n >>> 24; sample[o + 1] = (n >>> 16) & 0xff; sample[o + 2] = (n >>> 8) & 0xff; sample[o + 3] = n & 0xff;
      sample.set(nal, o + 4);
      o += 4 + n;
    }
    if (key) v.sync.push(v.sizes.n + 1);
    v.dts.push(dts - v.dts0);
    v.cts.push(pts - dts);
    v.minPts = Math.min(v.minPts, pts);
    v.lastDts = dts;
    v.lastPts = pts;
    this.writeSample(v, sample);
  }

  audio(data, pesPts) {
    const a = this.a;
    let carried = 0;
    if (a.carry) {
      const merged = new Uint8Array(a.carry.length + data.length);
      merged.set(a.carry); merged.set(data, a.carry.length);
      data = merged;
      carried = a.carry.length;
      a.carry = null;
    }
    if (pesPts !== null) pesPts = TsToMp4.unwrap(pesPts, a.lastPts ?? pesPts);
    // A PES timestamp belongs to the first frame that STARTS in that PES. A frame carried over
    // from the previous PES keeps the running time from there (a.lastPts), not this PES's PTS.
    let pts = carried && a.lastPts !== null ? a.lastPts : pesPts;
    let synced = !carried;
    let i = 0;
    while (i + 7 <= data.length) {
      if (!synced && i >= carried) { if (pesPts !== null) pts = pesPts; synced = true; }
      if (data[i] !== 0xff || (data[i + 1] & 0xf6) !== 0xf0) { i++; continue; } // resync on ADTS header
      const protectionAbsent = data[i + 1] & 1;
      const frameLen = ((data[i + 3] & 3) << 11) | (data[i + 4] << 3) | (data[i + 5] >> 5);
      const hdr = protectionAbsent ? 7 : 9;
      if (frameLen < hdr) { i++; continue; }
      if (i + frameLen > data.length) break;              // frame continues in the next PES
      if (!a.rate) {
        a.objectType = ((data[i + 2] >> 6) & 3) + 1;
        a.sfIndex = (data[i + 2] >> 2) & 0xf;
        a.rate = SAMPLE_RATES[a.sfIndex] || 48000;
        a.channels = ((data[i + 2] & 1) << 2) | (data[i + 3] >> 6) || 2;
      }
      if (this.v.dts0 !== null) {                           // start with the video
        if (a.firstPts === null) {
          // Same 33-bit epoch as the video, even if the clock wrapped between the two.
          a.firstPts = pts !== null ? TsToMp4.unwrap(pts, this.v.lastPts) : this.v.minPts;
        }
        this.writeSample(a, data.slice(i + hdr, i + frameLen));
      }
      if (pts !== null) pts += Math.round((1024 * 90000) / a.rate);
      i += frameLen;
    }
    if (pts !== null) a.lastPts = pts;
    if (i < data.length) a.carry = data.slice(i);
  }

  /** Writes the index and fills in sizes. Returns a short summary. */
  async finish() {
    for (const pid of [...this.pes.keys()]) this.finishPes(pid);
    const v = this.v;
    const a = this.a;
    if (!v.sizes.n) throw new Error('No video frames found to convert');
    await this.flush();

    // Durations (90 kHz): from decode timestamps; the last frame repeats the typical one.
    const nV = v.sizes.n;
    const vDur = new Uint32Array(nV);
    for (let i = 0; i + 1 < nV; i++) vDur[i] = Math.max(1, v.dts.get(i + 1) - v.dts.get(i));
    vDur[nV - 1] = nV > 1 ? vDur[nV - 2] : 3600;
    let vMedia = 0;
    let vEnd = 0; // presentation end: with B-frames the last frame shown is not the last one decoded
    for (let i = 0; i < nV; i++) {
      vMedia += vDur[i];
      vEnd = Math.max(vEnd, v.dts.get(i) + v.cts.get(i) + vDur[i]);
    }
    const aMedia = a.sizes.n * 1024;

    // Line the tracks up: whichever starts first defines time zero.
    const vStart = v.minPts;
    const aStart = a.sizes.n ? a.firstPts : Infinity;
    const t0 = Math.min(vStart, aStart);
    const toMs = (t90) => Math.round(t90 / 90);
    const vDelayMs = toMs(vStart - t0);
    const aDelayMs = a.sizes.n ? toMs(aStart - t0) : 0;
    const vMediaTime = vStart - v.dts0; // first presented frame on the media timeline
    const vShownMs = toMs(vEnd - vMediaTime);
    const aShownMs = a.rate ? Math.round((aMedia * 1000) / a.rate) : 0;
    const totalMs = Math.max(vDelayMs + vShownMs, a.sizes.n ? aDelayMs + aShownMs : 0);

    const info = v.info || { width: 1920, height: 1080, sarW: 1, sarH: 1, profile: 100, chroma: 1, depthY: 0, depthC: 0 };
    const displayW = Math.round((info.width * info.sarW) / info.sarH);

    const elst = (delayMs, shownMs, mediaTime) => {
      const w = new W();
      const entries = [];
      if (delayMs > 0) entries.push([delayMs, -1]);
      entries.push([shownMs, mediaTime]);
      w.u32(entries.length);
      for (const [dur, mt] of entries) w.u32(dur).i32(mt).u16(1).u16(0);
      return box('edts', full('elst', 0, 0, w.out()));
    };
    const tkhd = (id, durMs, audio, w, h) => {
      const x = new W().u32(0).u32(0).u32(id).u32(0).u32(durMs).zeros(8).u16(0).u16(0).u16(audio ? 0x0100 : 0).u16(0);
      for (const m of MATRIX) x.u32(m);
      x.u32(w * 65536).u32(h * 65536);
      return full('tkhd', 0, 3, x.out());
    };
    const mdhd = (scale, dur) => full('mdhd', 0, 0, new W().u32(0).u32(0).u32(scale).u32(dur).u16(0x55c4).u16(0).out());
    const hdlr = (type, name) => full('hdlr', 0, 0, new W().u32(0).str(type).zeros(12).str(name).u8(0).out());
    const dinf = box('dinf', full('dref', 0, 0, new W().u32(1).bytes(full('url ', 0, 1, new Uint8Array(0))).out()));
    const rle = (n, get) => {
      const runs = [];
      for (let i = 0; i < n; i++) {
        const val = get(i);
        if (runs.length && runs[runs.length - 1][1] === val) runs[runs.length - 1][0]++;
        else runs.push([1, val]);
      }
      return runs;
    };
    const tables = (track, n, stts) => {
      const w1 = new W().u32(stts.length);
      for (const [c, d] of stts) w1.u32(c).u32(d);
      const chunkRuns = [];
      for (let c = 0; c < track.chunkCount.n; c++) {
        const k = track.chunkCount.get(c);
        if (!chunkRuns.length || chunkRuns[chunkRuns.length - 1][1] !== k) chunkRuns.push([c + 1, k]);
      }
      const w2 = new W().u32(chunkRuns.length);
      for (const [first, k] of chunkRuns) w2.u32(first).u32(k).u32(1);
      const w3 = new W().u32(0).u32(n);
      for (let i = 0; i < n; i++) w3.u32(track.sizes.get(i));
      const w4 = new W().u32(track.chunkOff.n);
      for (let c = 0; c < track.chunkOff.n; c++) w4.u64(track.chunkOff.get(c));
      return [full('stts', 0, 0, w1.out()), full('stsc', 0, 0, w2.out()), full('stsz', 0, 0, w3.out()), full('co64', 0, 0, w4.out())];
    };

    // ---- video track ----
    const high = [100, 110, 122, 144].includes(info.profile);
    const avcC = new W().u8(1).u8(v.sps[1]).u8(v.sps[2]).u8(v.sps[3]).u8(0xff).u8(0xe1)
      .u16(v.sps.length).bytes(v.sps).u8(1).u16(v.pps.length).bytes(v.pps);
    if (high) avcC.u8(0xfc | info.chroma).u8(0xf8 | info.depthY).u8(0xf8 | info.depthC).u8(0);
    const avc1Body = new W().zeros(6).u16(1).zeros(16).u16(info.width).u16(info.height)
      .u32(0x00480000).u32(0x00480000).u32(0).u16(1).zeros(32).u16(0x0018).u16(0xffff)
      .bytes(box('avcC', avcC.out()));
    if (info.sarW !== info.sarH) avc1Body.bytes(box('pasp', new W().u32(info.sarW).u32(info.sarH).out()));
    const vStts = rle(nV, (i) => vDur[i]);
    const ctsRuns = rle(nV, (i) => v.cts.get(i));
    const vBoxes = [box('stsd', new W().u32(0).u32(1).bytes(box('avc1', avc1Body.out())).out())];
    const [stts, stsc, stsz, co64] = tables(v, nV, vStts);
    vBoxes.push(stts);
    if (ctsRuns.some(([, off]) => off !== 0)) {
      const w = new W().u32(0).u32(ctsRuns.length);
      for (const [c, off] of ctsRuns) w.u32(c).u32(off);
      vBoxes.push(box('ctts', w.out()));
    }
    const ss = new W().u32(0).u32(v.sync.n);
    for (let i = 0; i < v.sync.n; i++) ss.u32(v.sync.get(i));
    vBoxes.push(box('stss', ss.out()), stsc, stsz, co64);
    const videoTrak = box('trak',
      tkhd(1, vDelayMs + vShownMs, false, displayW, info.height),
      elst(vDelayMs, vShownMs, vMediaTime),
      box('mdia', mdhd(90000, vMedia), hdlr('vide', 'VideoHandler'),
        box('minf', full('vmhd', 0, 1, new W().zeros(8).out()), dinf, box('stbl', ...vBoxes))));

    // ---- audio track ----
    const traks = [videoTrak];
    if (a.sizes.n) {
      const asc = ((a.objectType & 0x1f) << 11) | ((a.sfIndex & 0xf) << 7) | ((a.channels & 0xf) << 3);
      const dsi = new W().u8(0x05).u8(2).u16(asc).out();
      const dcd = new W().u8(0x04).u8(13 + dsi.length).u8(0x40).u8(0x15).u24(0).u32(0).u32(0).bytes(dsi).out();
      const sl = new W().u8(0x06).u8(1).u8(0x02).out();
      const es = new W().u8(0x03).u8(3 + dcd.length + sl.length).u16(0).u8(0).bytes(dcd).bytes(sl).out();
      const mp4a = box('mp4a', new W().zeros(6).u16(1).zeros(8).u16(a.channels).u16(16).u16(0).u16(0)
        .u32(Math.min(a.rate, 65535) * 65536).bytes(full('esds', 0, 0, es)).out());
      const [s1, s2, s3, s4] = tables(a, a.sizes.n, [[a.sizes.n, 1024]]);
      traks.push(box('trak',
        tkhd(2, aDelayMs + aShownMs, true, 0, 0),
        elst(aDelayMs, aShownMs, 0),
        box('mdia', mdhd(a.rate, aMedia), hdlr('soun', 'SoundHandler'),
          box('minf', full('smhd', 0, 0, new W().u32(0).out()), dinf,
            box('stbl', box('stsd', new W().u32(0).u32(1).bytes(mp4a).out()), s1, s2, s3, s4)))));
    }

    const mv = new W().u32(0).u32(0).u32(1000).u32(totalMs).u32(0x00010000).u16(0x0100).zeros(10);
    for (const m of MATRIX) mv.u32(m);
    mv.zeros(24).u32(traks.length + 1);
    const moov = box('moov', full('mvhd', 0, 0, mv.out()), ...traks);

    const mdatSize = this.pos - this.mdatStart;
    await this.sink.write(moov);
    const size = new W().u64(mdatSize).out();
    await this.sink.writeAt(this.mdatStart + 8, size);
    return {
      width: info.width, height: info.height, durationMs: totalMs,
      videoFrames: nV, audioFrames: a.sizes.n, audioRate: a.rate, channels: a.channels, bytes: this.pos + moov.length,
    };
  }
}
