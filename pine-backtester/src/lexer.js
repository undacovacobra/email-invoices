// Pine Script tokenizer.
//
// Pine is indentation-sensitive (4 spaces or a tab per block level) and lets a
// statement wrap onto following lines when they are indented by an amount that
// is NOT a multiple of 4, or while a bracket is still open. This lexer first
// joins wrapped lines into logical lines, then tokenizes each one and emits
// Python-style INDENT / DEDENT / NEWLINE tokens.

export class PineSyntaxError extends Error {
  constructor(message, line, col) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'PineSyntaxError';
    this.line = line;
    this.col = col;
  }
}

const KEYWORDS = new Set([
  'if', 'else', 'for', 'to', 'by', 'in', 'while', 'var', 'varip', 'and', 'or', 'not',
  'true', 'false', 'break', 'continue', 'switch', 'import', 'export', 'method', 'type',
]);

const OPERATORS = [
  ':=', '=>', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=',
  '+', '-', '*', '/', '%', '<', '>', '=', '?', ':', ',', '(', ')', '[', ']', '.',
];

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '/' && line[i + 1] === '/') {
      return line.slice(0, i);
    }
  }
  return line;
}

function indentWidth(line) {
  let w = 0;
  for (const c of line) {
    if (c === ' ') w += 1;
    else if (c === '\t') w += 4;
    else break;
  }
  return w;
}

function bracketDelta(text) {
  let d = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') d++;
    else if (c === ')' || c === ']') d--;
  }
  return d;
}

// Returns [{ text, line, indent }] where wrapped lines are joined.
function logicalLines(source) {
  const raw = source.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const text = stripComment(raw[i]).replace(/\s+$/, '');
    if (!text.trim()) continue;
    const indent = indentWidth(text);
    const prev = out[out.length - 1];
    const isContinuation = prev && (depth > 0 || indent % 4 !== 0);
    if (isContinuation) {
      prev.text += ' ' + text.trim();
    } else {
      out.push({ text: text.trim(), line: i + 1, indent });
    }
    depth += bracketDelta(text);
    if (depth < 0) depth = 0;
  }
  return out;
}

function tokenizeLine(text, line, tokens) {
  let i = 0;
  const push = (type, value, col) => tokens.push({ type, value, line, col: col + 1 });
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    const start = i;
    // number
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] || ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      push('number', parseFloat(m[0]), start);
      i += m[0].length;
      continue;
    }
    // string
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\' && j + 1 < text.length) {
          const n = text[j + 1];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          j += 2;
        } else s += text[j++];
      }
      if (j >= text.length) throw new PineSyntaxError('unterminated string', line, start);
      push('string', s, start);
      i = j + 1;
      continue;
    }
    // color literal
    if (c === '#') {
      const m = /^#([0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/.exec(text.slice(i));
      if (!m) throw new PineSyntaxError('bad color literal', line, start);
      push('color', m[0], start);
      i += m[0].length;
      continue;
    }
    // identifier / keyword
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      push(KEYWORDS.has(m[0]) ? 'kw' : 'ident', m[0], start);
      i += m[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => text.startsWith(o, i));
    if (op) {
      push('op', op, start);
      i += op.length;
      continue;
    }
    throw new PineSyntaxError(`unexpected character '${c}'`, line, start);
  }
}

export function tokenize(source) {
  const tokens = [];
  const stack = [0];
  for (const ll of logicalLines(source)) {
    const level = ll.indent;
    if (level > stack[stack.length - 1]) {
      stack.push(level);
      tokens.push({ type: 'indent', line: ll.line, col: 1 });
    } else {
      while (level < stack[stack.length - 1]) {
        stack.pop();
        tokens.push({ type: 'dedent', line: ll.line, col: 1 });
      }
      if (level !== stack[stack.length - 1]) {
        throw new PineSyntaxError('inconsistent indentation', ll.line, 1);
      }
    }
    tokenizeLine(ll.text, ll.line, tokens);
    tokens.push({ type: 'newline', line: ll.line, col: ll.text.length + 1 });
  }
  while (stack.length > 1) {
    stack.pop();
    tokens.push({ type: 'dedent', line: 0, col: 0 });
  }
  tokens.push({ type: 'eof', line: 0, col: 0 });
  return tokens;
}
