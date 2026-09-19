// Browser network helpers. Extension pages with host_permissions are not
// subject to CORS, so these plain fetch() calls reach u-tv.ru and the CDN.

const IDLE_TIMEOUT_MS = 30000; // give up on a request that stops sending data

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${new URL(url).host}`);
    this.status = status;
  }
}

const isSite = (url) => /^https:\/\/(www\.)?u-tv\.ru\//i.test(url);

// fetch + read the body, aborting if no bytes arrive for IDLE_TIMEOUT_MS.
// A stalled connection then fails with a TimeoutError, which the caller retries.
async function fetchBody(url, init, signal, read) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) throw signal.reason;
    signal.addEventListener('abort', onAbort, { once: true });
  }
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctl.abort(new DOMException(`No data from ${new URL(url).host} for ${IDLE_TIMEOUT_MS / 1000}s`, 'TimeoutError')), IDLE_TIMEOUT_MS);
  };
  try {
    arm();
    const r = await fetch(url, { ...init, signal: ctl.signal });
    if (!r.ok) throw new HttpError(r.status, url);
    const reader = r.body.getReader();
    const chunks = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
      arm();
    }
    const buf = new Uint8Array(length);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    return read(buf, r);
  } catch (e) {
    // Surface the timeout itself rather than a generic AbortError.
    if (ctl.signal.aborted && !(signal && signal.aborted) && ctl.signal.reason) throw ctl.signal.reason;
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// Over https:// the video CDN negotiates HTTP/3 (QUIC over UDP), which measured about 6-10x slower
// than plain HTTP/1.1 on a real home connection, since Chrome then sends everything down one connection.
// Over http:// Chrome opens up to 6 ordinary TCP connections, like a download manager. Segments are
// public video and are checked on arrival, so they go over http:// unless that turns out to be blocked.
const CDN = /^https:\/\/([a-z0-9-]+\.)*media1\.ru\//i;
let plainHttpWorks = true;

export const net = {
  text(url, signal) {
    return fetchBody(url, { credentials: isSite(url) ? 'include' : 'omit', cache: 'no-store' }, signal,
      (buf) => new TextDecoder().decode(buf));
  },

  async bytes(url, signal) {
    // no-store: segments are read once, so don't push gigabytes through Chrome's HTTP cache.
    const init = { credentials: 'omit', cache: 'no-store' };
    const check = (buf, r) => {
      const len = r.headers.get('content-length');
      if (len && !r.headers.get('content-encoding') && Number(len) !== buf.byteLength) {
        throw new Error(`incomplete response (${buf.byteLength} of ${len} bytes)`);
      }
      return buf;
    };
    if (plainHttpWorks && CDN.test(url)) {
      try {
        return await fetchBody(url.replace(/^https:/i, 'http:'), init, signal, check);
      } catch (e) {
        if (signal && signal.aborted) throw e;
        // Plain http failed: if https works right away, this network blocks http, so stay on https.
        const buf = await fetchBody(url, init, signal, check);
        plainHttpWorks = false;
        return buf;
      }
    }
    return fetchBody(url, init, signal, check);
  },
};
