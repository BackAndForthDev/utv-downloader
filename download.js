// Parallel segment fetcher with strictly ordered writes.
// Up to `concurrency` requests run at once, but no more than `lookahead`
// segments are held in memory, so a 4K episode never needs more than a few
// hundred MB of RAM no matter how long it is.

const RETRIES = 6;                       // for server errors / bad data
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const NETWORK_PATIENCE_MS = 5 * 60000;   // keep waiting this long for a dropped connection
const NETWORK_BACKOFF_MS = [2000, 5000, 10000, 20000, 30000];

function abortError() {
  return new DOMException('Download canceled', 'AbortError');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Connection-level failures (offline, reset, stalled) as opposed to the server
// answering with an error. These don't use up the normal retry budget.
export function isNetworkError(e) {
  if (!e) return false;
  if (e.name === 'TimeoutError') return true;
  if (e.name === 'TypeError') return true;
  return /Failed to fetch|NetworkError|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket/i.test(e.message || '');
}

/**
 * Runs fn() with retries: up to RETRIES for server errors, and for network
 * errors keeps trying for NETWORK_PATIENCE_MS. onWait({ network, delayMs, error })
 * is called before each pause so the UI can say what's happening.
 */
export async function withRetry(fn, { signal, onWait = () => {}, retries = RETRIES } = {}) {
  const sig = signal || new AbortController().signal;
  let attempts = 0;
  let netAttempts = 0;
  let netSince = 0;
  for (;;) {
    if (sig.aborted) throw abortError();
    try {
      return await fn();
    } catch (e) {
      if (sig.aborted) throw abortError();
      if (e && e.fatal) throw e;
      let delayMs;
      if (isNetworkError(e)) {
        if (!netSince) netSince = Date.now();
        if (Date.now() - netSince > NETWORK_PATIENCE_MS) throw e;
        delayMs = NETWORK_BACKOFF_MS[Math.min(netAttempts++, NETWORK_BACKOFF_MS.length - 1)];
        onWait({ network: true, delayMs, error: e });
      } else {
        netSince = 0;
        netAttempts = 0;
        if (++attempts >= retries) throw e;
        delayMs = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
        onWait({ network: false, delayMs, error: e });
      }
      await sleep(delayMs, sig);
    }
  }
}

function makeWaker() {
  let waiters = [];
  return {
    wait: () => new Promise((r) => waiters.push(r)),
    notify: () => { const w = waiters; waiters = []; w.forEach((r) => r()); },
  };
}

/**
 * @param {object} o
 * @param {{url: string, duration: number}[]} o.segments
 * @param {{url: string} | null} [o.init]         fMP4 init segment, written first
 * @param {(url: string, signal: AbortSignal) => Promise<Uint8Array>} o.fetchSegment
 * @param {(bytes: Uint8Array) => Promise<void>} o.write
 * @param {(bytes: Uint8Array) => boolean} [o.validate]    false = bad response, retry it
 * @param {(bytes: Uint8Array) => void} [o.checkFirst]     may throw to stop for good (no retry)
 * @param {number} [o.startAt]      resume: segments [0, startAt) are already written
 * @param {number} [o.startBytes]   resume: bytes already written
 * @param {AbortSignal} [o.signal]
 * @param {(p: object) => void} [o.onProgress]
 * @param {(w: object) => void} [o.onWait]           a request failed and is being retried
 */
export async function downloadHls({
  segments, init = null, fetchSegment, write, validate = null, checkFirst = null,
  startAt = 0, startBytes = 0,
  signal, onProgress = () => {}, onWait = () => {}, concurrency = 6, lookahead = 16,
}) {
  const n = segments.length;
  const totalSeconds = segments.reduce((s, x) => s + x.duration, 0);
  const ctl = new AbortController();
  const onOuterAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) throw abortError();
    signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const wake = makeWaker();
  ctl.signal.addEventListener('abort', () => wake.notify(), { once: true });

  const buffered = new Map();
  let nextFetch = startAt;
  let written = startAt;
  let fetched = startAt;
  let bytesWritten = startBytes;
  let secondsWritten = segments.slice(0, startAt).reduce((s, x) => s + x.duration, 0);
  let failure = null;

  const report = () => onProgress({
    segmentsDone: written, segmentsFetched: fetched, segmentsTotal: n,
    bytes: bytesWritten, seconds: secondsWritten, totalSeconds,
  });

  const fail = (e) => {
    if (!failure) failure = e;
    ctl.abort();
    wake.notify();
  };

  const fetchChecked = (url, label) => withRetry(async () => {
    const data = await fetchSegment(url, ctl.signal);
    if (validate && !validate(data)) throw new Error(`${label}: response was not video data`);
    return data;
  }, { signal: ctl.signal, onWait: (w) => onWait({ ...w, label }) }).catch((e) => {
    if (ctl.signal.aborted) throw failure || abortError();
    throw new Error(`${label} failed: ${e && e.message}`, { cause: e });
  });

  async function worker() {
    while (!ctl.signal.aborted && nextFetch < n) {
      if (nextFetch >= written + lookahead) { await wake.wait(); continue; }
      const i = nextFetch++;
      const data = await fetchChecked(segments[i].url, `Segment ${i + 1}/${n}`);
      buffered.set(i, data);
      fetched++;
      wake.notify();
      report();
    }
  }

  async function writer() {
    if (init && startAt === 0) {
      const data = await fetchChecked(init.url, 'Init segment');
      await write(data);
      bytesWritten += data.byteLength;
    }
    while (written < n) {
      if (failure) throw failure;
      if (ctl.signal.aborted) throw abortError();
      if (!buffered.has(written)) { await wake.wait(); continue; }
      const data = buffered.get(written);
      buffered.delete(written);
      if (written === 0 && checkFirst) checkFirst(data);
      await write(data);
      bytesWritten += data.byteLength;
      secondsWritten += segments[written].duration;
      written++;
      wake.notify();
      report();
    }
  }

  report();
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, n - startAt)) }, () => worker().catch(fail));
  try {
    await writer();
  } catch (e) {
    fail(e);
  } finally {
    if (signal) signal.removeEventListener('abort', onOuterAbort);
    if (failure) ctl.abort();
    await Promise.allSettled(workers);
    buffered.clear();
  }
  if (failure) throw failure;
  report();
  return { bytes: bytesWritten, seconds: secondsWritten, segments: n };
}
