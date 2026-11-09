// Runs a backtest off the main thread so the page stays responsive.
import { runScript } from '../src/runtime.js';

self.onmessage = (e) => {
  const { id, source, data, options } = e.data;
  try {
    const res = runScript(source, data, {
      ...options,
      onProgress: (bar, n) => self.postMessage({ id, type: 'progress', bar, n }),
    });
    self.postMessage({ id, type: 'done', res });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err && err.message ? err.message : err), line: err && err.line });
  }
};
