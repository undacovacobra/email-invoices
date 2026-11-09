#!/usr/bin/env node
// Bundles the app into one self-contained HTML file: dist/pine-backtester.html
//   node build.mjs            -> standalone page (open the file directly in a browser)
//   node build.mjs --hosted   -> body-only page for hosts that add their own <html>/<head>
//                                 (also drops the exchange feed, which such hosts block)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const hosted = process.argv.includes('--hosted');
const read = (p) => readFileSync(join(root, p), 'utf8');

const ENGINE = ['src/lexer.js', 'src/parser.js', 'src/ta.js', 'src/broker.js', 'src/metrics.js', 'src/runtime.js'];
const MODULES = [...ENGINE, 'src/data.js', 'src/examples.js', 'app/app.js'];
const modVar = (p) => `__m_${basename(p, '.js')}`;

function wrap(path) {
  let src = read(path);
  const exported = [];
  src = src.replace(/^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?\s*$/gm, (_, names, from) => {
    const target = [...MODULES, 'app/worker.js'].find((m) => basename(m) === basename(from));
    if (!target) throw new Error(`${path}: cannot resolve import ${from}`);
    const binds = names.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s+as\s+/, ': '));
    return `const { ${binds.join(', ')} } = ${modVar(target)};`;
  });
  src = src.replace(/^export\s+(async\s+function|function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, name) => {
    exported.push(name);
    return `${kind} ${name}`;
  });
  if (/^export\s/m.test(src)) throw new Error(`${path}: unsupported export form`);
  return `const ${modVar(path)} = (() => {\n${src}\nreturn { ${exported.join(', ')} };\n})();\n`;
}

// The page bundle, plus the engine + worker entry as a string the page turns into a Web Worker.
const workerSrc = [...ENGINE, 'app/worker.js'].map(wrap).join('\n');
const bundle = `window.__PBT_ENGINE__ = ${JSON.stringify(workerSrc)};\n${MODULES.map(wrap).join('\n')}`;
const html = read('app/index.html');
let body = html.slice(html.indexOf('<!-- APP:BEGIN -->') + 18, html.indexOf('<!-- APP:END -->'));
if (hosted) body = body.replace(/\s*<option value="(binance|market)">[^<]*<\/option>/g, '');
const css = read('app/style.css');
const fonts = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">';
const lw = '<script src="https://cdn.jsdelivr.net/npm/lightweight-charts@5.0.9/dist/lightweight-charts.standalone.production.js"></script>';
const script = `<script type="module">\n${bundle.replace(/<\/script/gi, '<\\/script')}\n</script>`;

const out = hosted
  ? `<title>Pine Backtester</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n${fonts}\n<style>\n${css}\n</style>\n${body}\n${lw}\n${script}\n`
  : `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<title>Pine Backtester</title>\n${fonts}\n<style>\n${css}\n</style>\n</head>\n<body>\n${body}\n${lw}\n${script}\n</body>\n</html>\n`;

mkdirSync(join(root, 'dist'), { recursive: true });
const file = join(root, 'dist', hosted ? 'pine-backtester.hosted.html' : 'pine-backtester.html');
writeFileSync(file, out);
console.log(`wrote ${file} (${(out.length / 1024).toFixed(0)} KB)`);
