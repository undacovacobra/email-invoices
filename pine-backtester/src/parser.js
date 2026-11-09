// Pine Script parser: tokens -> AST.
import { tokenize, PineSyntaxError } from './lexer.js';

const TYPE_NAMES = new Set([
  'int', 'float', 'bool', 'string', 'color', 'line', 'label', 'box', 'table',
  'linefill', 'polyline', 'array', 'matrix', 'map', 'series', 'simple', 'const',
]);

export function parse(source) {
  return new Parser(tokenize(source)).parseProgram();
}

class Parser {
  constructor(tokens) {
    this.t = tokens;
    this.i = 0;
    this.nextId = 1;
  }

  // ---- helpers ----------------------------------------------------------
  peek(o = 0) { return this.t[this.i + o]; }
  at(type, value, o = 0) {
    const tk = this.t[this.i + o];
    return tk && tk.type === type && (value === undefined || tk.value === value);
  }
  atOp(v, o = 0) { return this.at('op', v, o); }
  atKw(v, o = 0) { return this.at('kw', v, o); }
  next() { return this.t[this.i++]; }
  fail(msg, tk = this.peek()) {
    throw new PineSyntaxError(msg, tk && tk.line, tk && tk.col);
  }
  expect(type, value) {
    if (!this.at(type, value)) {
      const tk = this.peek();
      const got = tk.type === 'newline' ? 'end of line' : tk.value ?? tk.type;
      this.fail(`expected '${value ?? type}' but found '${got}'`);
    }
    return this.next();
  }
  node(type, tk, props) {
    return { type, id: this.nextId++, line: tk ? tk.line : 0, ...props };
  }

  // ---- program / blocks -------------------------------------------------
  parseProgram() {
    const body = [];
    while (!this.at('eof')) {
      if (this.at('newline')) { this.next(); continue; }
      body.push(this.parseStatement());
    }
    return { type: 'Program', body, nodeCount: this.nextId };
  }

  parseBlock() {
    const tk = this.peek();
    this.expect('newline');
    if (!this.at('indent')) this.fail('expected an indented block');
    this.next();
    const body = [];
    while (!this.at('dedent') && !this.at('eof')) {
      if (this.at('newline')) { this.next(); continue; }
      body.push(this.parseStatement());
    }
    if (this.at('dedent')) this.next();
    return this.node('Block', tk, { body });
  }

  endStatement() {
    if (this.at('newline')) this.next();
    else if (!this.at('dedent') && !this.at('eof')) {
      const tk = this.peek();
      this.fail(`unexpected '${tk.value ?? tk.type}'`);
    }
  }

  // ---- statements -------------------------------------------------------
  parseStatement() {
    const tk = this.peek();
    if (tk.type === 'kw') {
      switch (tk.value) {
        case 'if': { const n = this.parseIf(); return n; }
        case 'for': return this.parseFor();
        case 'while': return this.parseWhile();
        case 'switch': return this.parseSwitch();
        case 'break': this.next(); this.endStatement(); return this.node('Break', tk, {});
        case 'continue': this.next(); this.endStatement(); return this.node('Continue', tk, {});
        case 'var': case 'varip': return this.parseDecl();
        case 'export': this.next(); return this.parseStatement();
        case 'method': this.next(); return this.parseStatement();
        case 'import': this.fail('import of libraries is not supported');
        // eslint-disable-next-line no-fallthrough
        case 'type': this.fail('user-defined types are not supported yet');
        default: break;
      }
    }
    if (this.atOp('[') && this.isTupleDecl()) return this.parseTupleDecl();
    if (tk.type === 'ident') {
      if (this.atOp('(', 1) && this.isFuncDef()) return this.parseFuncDef();
      if (this.isTypedDecl() || this.atOp('=', 1)) return this.parseDecl();
      if (this.at('op', undefined, 1) && [':=', '+=', '-=', '*=', '/=', '%='].includes(this.peek(1).value)) {
        const name = this.next().value;
        const op = this.next().value;
        const value = this.parseRhs();
        return this.node('Assign', tk, { name, op, value });
      }
    }
    const expr = this.parseExpression();
    this.endStatement();
    return this.node('ExprStmt', tk, { expr });
  }

  // Right-hand side of a declaration/assignment: expression, or if/switch expression.
  parseRhs() {
    if (this.atKw('if')) return this.parseIf();
    if (this.atKw('switch')) return this.parseSwitch();
    const e = this.parseExpression();
    this.endStatement();
    return e;
  }

  // Lookahead helpers
  matchingClose(openIdx) {
    let depth = 0;
    for (let j = openIdx; j < this.t.length; j++) {
      const tk = this.t[j];
      if (tk.type === 'op' && (tk.value === '(' || tk.value === '[')) depth++;
      else if (tk.type === 'op' && (tk.value === ')' || tk.value === ']')) {
        depth--;
        if (depth === 0) return j;
      } else if (tk.type === 'newline' || tk.type === 'eof') return -1;
    }
    return -1;
  }
  isTupleDecl() {
    const close = this.matchingClose(this.i);
    const after = close >= 0 && this.t[close + 1];
    return !!after && after.type === 'op' && (after.value === '=' || after.value === ':=');
  }
  isFuncDef() {
    const close = this.matchingClose(this.i + 1);
    const after = close >= 0 && this.t[close + 1];
    return !!after && after.type === 'op' && after.value === '=>';
  }
  // [series|simple|const] type[<...>] name =
  isTypedDecl() {
    let j = this.i;
    const tk = () => this.t[j];
    if (tk().type !== 'ident' || !TYPE_NAMES.has(tk().value)) return false;
    if (['series', 'simple', 'const'].includes(tk().value) && this.t[j + 1].type === 'ident') j++;
    j++;
    if (this.t[j].type === 'op' && this.t[j].value === '<') {
      while (this.t[j] && !(this.t[j].type === 'op' && this.t[j].value === '>')) j++;
      j++;
    }
    if (this.t[j].type === 'op' && this.t[j].value === '[' && this.t[j + 1].value === ']') j += 2;
    return this.t[j].type === 'ident' && this.t[j + 1].type === 'op' && this.t[j + 1].value === '=';
  }
  skipType() {
    let type = null;
    if (this.isTypeStart()) {
      if (['series', 'simple', 'const'].includes(this.peek().value) && this.at('ident', undefined, 1)) this.next();
      type = this.next().value;
      if (this.atOp('<')) {
        while (!this.atOp('>')) this.next();
        this.next();
      }
      if (this.atOp('[') && this.atOp(']', 1)) { this.next(); this.next(); }
    }
    return type;
  }
  isTypeStart() {
    return this.at('ident') && TYPE_NAMES.has(this.peek().value) &&
      (this.at('ident', undefined, 1) || this.atOp('<', 1) || (this.atOp('[', 1) && this.atOp(']', 2)));
  }

  parseDecl() {
    const tk = this.peek();
    let mode = null;
    if (this.atKw('var') || this.atKw('varip')) mode = this.next().value;
    const varType = this.skipType();
    const name = this.expect('ident').value;
    this.expect('op', '=');
    const init = this.parseRhs();
    return this.node('VarDecl', tk, { name, mode, varType, init });
  }

  parseTupleDecl() {
    const tk = this.next(); // [
    const names = [];
    while (!this.atOp(']')) {
      names.push(this.expect('ident').value);
      if (this.atOp(',')) this.next();
    }
    this.next();
    const op = this.next().value; // = or :=
    const init = this.parseRhs();
    return this.node('TupleDecl', tk, { names, init, reassign: op === ':=' });
  }

  parseFuncDef() {
    const tk = this.peek();
    const name = this.next().value;
    this.expect('op', '(');
    const params = [];
    while (!this.atOp(')')) {
      this.skipType();
      const pname = this.expect('ident').value;
      let def = null;
      if (this.atOp('=')) { this.next(); def = this.parseExpression(); }
      params.push({ name: pname, def });
      if (this.atOp(',')) this.next();
    }
    this.next();
    this.expect('op', '=>');
    let body;
    if (this.at('newline')) body = this.parseBlock();
    else {
      const e = this.parseExpression();
      this.endStatement();
      body = this.node('Block', tk, { body: [this.node('ExprStmt', tk, { expr: e })] });
    }
    return this.node('FuncDef', tk, { name, params, body });
  }

  parseIf() {
    const tk = this.expect('kw', 'if');
    const test = this.parseExpression();
    const consequent = this.parseBlock();
    let alternate = null;
    if (this.atKw('else')) {
      this.next();
      if (this.atKw('if')) alternate = this.parseIf();
      else alternate = this.parseBlock();
    }
    return this.node('If', tk, { test, consequent, alternate });
  }

  parseFor() {
    const tk = this.expect('kw', 'for');
    if (this.atOp('[')) {
      this.next();
      const a = this.expect('ident').value;
      this.expect('op', ',');
      const b = this.expect('ident').value;
      this.expect('op', ']');
      this.expect('kw', 'in');
      const iterable = this.parseExpression();
      const body = this.parseBlock();
      return this.node('ForIn', tk, { index: a, item: b, iterable, body });
    }
    const v = this.expect('ident').value;
    if (this.atKw('in')) {
      this.next();
      const iterable = this.parseExpression();
      const body = this.parseBlock();
      return this.node('ForIn', tk, { index: null, item: v, iterable, body });
    }
    this.expect('op', '=');
    const from = this.parseExpression();
    this.expect('kw', 'to');
    const to = this.parseExpression();
    let step = null;
    if (this.atKw('by')) { this.next(); step = this.parseExpression(); }
    const body = this.parseBlock();
    return this.node('For', tk, { var: v, from, to, step, body });
  }

  parseWhile() {
    const tk = this.expect('kw', 'while');
    const test = this.parseExpression();
    const body = this.parseBlock();
    return this.node('While', tk, { test, body });
  }

  parseSwitch() {
    const tk = this.expect('kw', 'switch');
    let discriminant = null;
    if (!this.at('newline')) discriminant = this.parseExpression();
    this.expect('newline');
    this.expect('indent');
    const cases = [];
    while (!this.at('dedent') && !this.at('eof')) {
      if (this.at('newline')) { this.next(); continue; }
      const ctk = this.peek();
      let test = null;
      if (!this.atOp('=>')) test = this.parseExpression();
      this.expect('op', '=>');
      let body;
      if (this.at('newline')) body = this.parseBlock();
      else {
        const stmtTk = this.peek();
        const stmt = this.parseStatement();
        body = this.node('Block', stmtTk, { body: [stmt] });
      }
      cases.push({ test, body, line: ctk.line });
    }
    if (this.at('dedent')) this.next();
    return this.node('Switch', tk, { discriminant, cases });
  }

  // ---- expressions ------------------------------------------------------
  parseExpression() { return this.parseTernary(); }

  parseTernary() {
    const test = this.parseOr();
    if (this.atOp('?')) {
      const tk = this.next();
      const cons = this.parseTernary();
      this.expect('op', ':');
      const alt = this.parseTernary();
      return this.node('Ternary', tk, { test, cons, alt });
    }
    return test;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.atKw('or')) {
      const tk = this.next();
      left = this.node('Logical', tk, { op: 'or', left, right: this.parseAnd() });
    }
    return left;
  }

  parseAnd() {
    let left = this.parseEquality();
    while (this.atKw('and')) {
      const tk = this.next();
      left = this.node('Logical', tk, { op: 'and', left, right: this.parseEquality() });
    }
    return left;
  }

  parseEquality() {
    let left = this.parseComparison();
    while (this.atOp('==') || this.atOp('!=')) {
      const tk = this.next();
      left = this.node('Binary', tk, { op: tk.value, left, right: this.parseComparison() });
    }
    return left;
  }

  parseComparison() {
    let left = this.parseAdditive();
    while (['<', '>', '<=', '>='].some((o) => this.atOp(o))) {
      const tk = this.next();
      left = this.node('Binary', tk, { op: tk.value, left, right: this.parseAdditive() });
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.atOp('+') || this.atOp('-')) {
      const tk = this.next();
      left = this.node('Binary', tk, { op: tk.value, left, right: this.parseMultiplicative() });
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.atOp('*') || this.atOp('/') || this.atOp('%')) {
      const tk = this.next();
      left = this.node('Binary', tk, { op: tk.value, left, right: this.parseUnary() });
    }
    return left;
  }

  parseUnary() {
    if (this.atOp('-') || this.atOp('+') || this.atKw('not')) {
      const tk = this.next();
      return this.node('Unary', tk, { op: tk.value, arg: this.parseUnary() });
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.atOp('[')) {
        const tk = this.next();
        const offset = this.parseExpression();
        this.expect('op', ']');
        expr = this.node('History', tk, { target: expr, offset });
      } else if (this.atOp('.') && (this.at('ident', undefined, 1) || this.at('kw', undefined, 1))) {
        // member/method on an expression result, e.g. array.get(a, 0).abs() — treat as method call
        const tk = this.next();
        const name = this.next().value;
        if (!this.atOp('(')) this.fail(`field access '.${name}' is not supported`, tk);
        const call = this.parseCallArgs(name, tk);
        call.args.unshift(expr);
        call.method = true;
        expr = call;
      } else break;
    }
    return expr;
  }

  parseCallArgs(callee, tk) {
    this.expect('op', '(');
    const args = [];
    const named = {};
    while (!this.atOp(')')) {
      if (this.at('ident') && this.atOp('=', 1)) {
        const name = this.next().value;
        this.next();
        named[name] = this.parseExpression();
      } else {
        args.push(this.parseExpression());
      }
      if (this.atOp(',')) this.next();
      else if (!this.atOp(')')) this.fail("expected ',' or ')' in argument list");
    }
    this.next();
    return this.node('Call', tk, { callee, args, named });
  }

  parsePrimary() {
    const tk = this.peek();
    switch (tk.type) {
      case 'number': this.next(); return this.node('Num', tk, { value: tk.value });
      case 'string': this.next(); return this.node('Str', tk, { value: tk.value });
      case 'color': this.next(); return this.node('Color', tk, { value: tk.value });
      case 'kw':
        if (tk.value === 'true' || tk.value === 'false') {
          this.next();
          return this.node('Bool', tk, { value: tk.value === 'true' });
        }
        if (tk.value === 'if') return this.parseIf();
        if (tk.value === 'switch') return this.parseSwitch();
        break;
      case 'op':
        if (tk.value === '(') {
          this.next();
          const e = this.parseExpression();
          this.expect('op', ')');
          return e;
        }
        if (tk.value === '[') {
          this.next();
          const items = [];
          while (!this.atOp(']')) {
            items.push(this.parseExpression());
            if (this.atOp(',')) this.next();
          }
          this.next();
          return this.node('Tuple', tk, { items });
        }
        break;
      case 'ident': {
        this.next();
        let name = tk.value;
        while (this.atOp('.') && (this.at('ident', undefined, 1) || this.at('kw', undefined, 1))) {
          this.next();
          name += '.' + this.next().value;
        }
        // generic call: array.new<float>(...)
        if (this.atOp('<') && this.at('ident', undefined, 1) && this.atOp('>', 2) && this.atOp('(', 3)) {
          this.next(); this.next(); this.next();
        }
        if (this.atOp('(')) return this.parseCallArgs(name, tk);
        return this.node('Ident', tk, { name });
      }
      default: break;
    }
    const got = tk.type === 'newline' ? 'end of line' : tk.value ?? tk.type;
    this.fail(`unexpected '${got}'`);
  }
}
