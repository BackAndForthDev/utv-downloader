// HLS playlist parsing and variant selection. Pure functions, no browser APIs,
// so the same code runs in the extension and in the Node tests.

export function parseAttributes(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function lines(text) {
  return String(text).replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function tagValue(line) {
  const i = line.indexOf(':');
  return i === -1 ? '' : line.slice(i + 1);
}

const AUDIO_CODEC = /\b(mp4a|ac-3|ec-3|opus|flac|mp3|alac)\b/i;

export function isPlaylist(text) {
  return String(text).replace(/^﻿/, '').trimStart().startsWith('#EXTM3U');
}

// Returns { isMedia, variants: [{ url, bandwidth, width, height, codecs, audio, separateAudio }] }
export function parseMaster(text, baseUrl) {
  const ls = lines(text);
  if (ls.some((l) => l.startsWith('#EXTINF'))) {
    // Not a master playlist: the URL already points at a single rendition.
    return { isMedia: true, variants: [{ url: baseUrl, bandwidth: 0, width: 0, height: 0, codecs: '', audio: null, separateAudio: false }] };
  }
  const audioGroupsWithUri = new Set();
  for (const l of ls) {
    if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(tagValue(l));
      if (a.TYPE === 'AUDIO' && a.URI) audioGroupsWithUri.add(a['GROUP-ID']);
    }
  }
  const variants = [];
  for (let i = 0; i < ls.length; i++) {
    if (!ls[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = parseAttributes(tagValue(ls[i]));
    let uri = null;
    for (let j = i + 1; j < ls.length; j++) {
      if (!ls[j].startsWith('#')) { uri = ls[j]; i = j; break; }
      if (ls[j].startsWith('#EXT-X-STREAM-INF:')) break;
    }
    if (!uri) continue;
    const [w, h] = (a.RESOLUTION || '0x0').split('x').map((n) => parseInt(n, 10) || 0);
    // An AUDIO group only means alternate tracks exist. The variant still carries its
    // own sound when CODECS lists an audio codec (u-tv's "-v1-a1" streams do).
    const codecsKnown = !!a.CODECS;
    const muxedAudio = !codecsKnown || AUDIO_CODEC.test(a.CODECS);
    variants.push({
      url: new URL(uri, baseUrl).href,
      bandwidth: parseInt(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH || '0', 10) || 0,
      peakBandwidth: parseInt(a.BANDWIDTH || '0', 10) || 0,
      width: w,
      height: h,
      codecs: a.CODECS || '',
      audio: a.AUDIO || null,
      separateAudio: !!(a.AUDIO && audioGroupsWithUri.has(a.AUDIO) && !muxedAudio),
    });
  }
  return { isMedia: false, variants };
}

// Highest resolution wins, then highest bitrate. Variants that need a separate
// audio playlist are skipped because joining segments can't mux them.
export function pickBest(variants) {
  const usable = variants.filter((v) => !v.separateAudio);
  if (!usable.length) {
    throw new Error(variants.length ? 'Only streams with a separate audio track are available (not supported)' : 'The stream has no playable variants');
  }
  return [...usable].sort((a, b) => (b.height - a.height) || (b.peakBandwidth - a.peakBandwidth) || (b.bandwidth - a.bandwidth))[0];
}

export function qualityLabel(v) {
  if (!v) return '?';
  if (v.height >= 2160) return '4K';
  if (v.height > 0) return `${v.height}p`;
  if (v.bandwidth > 0) return `${Math.round(v.bandwidth / 1000)} kbps`;
  return 'source';
}

// Returns { segments: [{ url, duration }], init: { url } | null, totalDuration }
export function parseMedia(text, baseUrl) {
  if (!isPlaylist(text)) throw new Error('The video playlist could not be read');
  const ls = lines(text);
  let ended = false;
  let vod = false;
  let init = null;
  let pendingDuration = null;
  const segments = [];
  for (const l of ls) {
    if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(tagValue(l));
      if (a.METHOD && a.METHOD !== 'NONE') throw new Error('This video is encrypted (not supported)');
    } else if (l.startsWith('#EXT-X-BYTERANGE')) {
      throw new Error('Byte-range playlists are not supported');
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(tagValue(l));
      if (a.BYTERANGE) throw new Error('Byte-range playlists are not supported');
      if (init && segments.length) throw new Error('Playlists that change init segment mid-stream are not supported');
      init = { url: new URL(a.URI, baseUrl).href };
    } else if (l === '#EXT-X-ENDLIST') {
      ended = true;
    } else if (l.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      vod = tagValue(l).trim() === 'VOD';
    } else if (l.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(tagValue(l)) || 0;
    } else if (!l.startsWith('#')) {
      segments.push({ url: new URL(l, baseUrl).href, duration: pendingDuration ?? 0 });
      pendingDuration = null;
    }
  }
  if (!ended && !vod) throw new Error('This is a live stream, not a recorded episode');
  if (!segments.length) throw new Error('The video playlist is empty');
  const totalDuration = segments.reduce((s, x) => s + x.duration, 0);
  return { segments, init, totalDuration };
}

export function isTransportStream(bytes) {
  return bytes && bytes.length >= 188 && bytes[0] === 0x47;
}

const VIDEO_TYPES = new Set([0x01, 0x02, 0x10, 0x1b, 0x24]);
const AUDIO_TYPES = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87]);

// Reads the PAT/PMT of an MPEG-TS segment. Returns { video, audio, unknown }
// or null when no PMT is found in this chunk.
export function tsStreams(b) {
  let pmtPid = null;
  for (let i = 0; i + 188 <= b.length; i += 188) {
    if (b[i] !== 0x47) return null;
    const pid = ((b[i + 1] & 0x1f) << 8) | b[i + 2];
    const pusi = b[i + 1] & 0x40;
    const afc = (b[i + 3] >> 4) & 3;
    let p = i + 4;
    if (afc & 2) p += 1 + b[p];
    if (!(afc & 1) || !pusi || p >= i + 188) continue;
    p += 1 + b[p];
    if (pid === 0 && pmtPid === null) {
      pmtPid = ((b[p + 10] & 0x1f) << 8) | b[p + 11];
    } else if (pmtPid !== null && pid === pmtPid) {
      const secLen = ((b[p + 1] & 0x0f) << 8) | b[p + 2];
      const infoLen = ((b[p + 10] & 0x0f) << 8) | b[p + 11];
      const end = Math.min(p + 3 + secLen - 4, i + 188);
      const out = { video: false, audio: false, unknown: false };
      for (let q = p + 12 + infoLen; q + 5 <= end;) {
        const type = b[q];
        if (VIDEO_TYPES.has(type)) out.video = true;
        else if (AUDIO_TYPES.has(type)) out.audio = true;
        else if (type !== 0x15) out.unknown = true;
        q += 5 + (((b[q + 3] & 0x0f) << 8) | b[q + 4]);
      }
      return out;
    }
  }
  return null;
}
