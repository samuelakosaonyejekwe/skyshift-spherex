// Safe expression engine: a whitelisted grammar parsed to an expression tree. No eval(),
// no Function(), no property access: only numbers, named variables, a fixed set of
// functions and operators. Three uses:
//   image arithmetic   (D5 + D6)/2 - epoch(1)        -> per-pixel image for each frame
//   selections         t > 2025-06-01 and det >= 4   -> filter exposures
//   assignments        pmra = -801.5; pmdec = 10362  -> set request fields

export class ExprError extends Error {
  constructor(msg, pos, input) {
    super(msg); this.pos = pos; this.input = input;
  }
  get pointer() { return `${this.input}\n${' '.repeat(Math.max(0, this.pos))}^`; }
}

const FUNCS = {
  abs: [1, 1], sqrt: [1, 1], log10: [1, 1], ln: [1, 1], exp: [1, 1], min: [2, 8], max: [2, 8], mean: [1, 8],
  epoch: [1, 1], wl: [2, 2], clip: [3, 3],
};
const KEYWORDS = new Set(['and', 'or', 'not', 'in']);

function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    const date = s.slice(i).match(/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/);
    if (date) { out.push({ t: 'date', v: date[0], pos: i }); i += date[0].length; continue; }
    const num = s.slice(i).match(/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i);
    if (num) { out.push({ t: 'num', v: Number(num[0]), pos: i }); i += num[0].length; continue; }
    const id = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (id) { const w = id[0]; out.push({ t: KEYWORDS.has(w.toLowerCase()) ? 'kw' : 'id', v: KEYWORDS.has(w.toLowerCase()) ? w.toLowerCase() : w, pos: i }); i += w.length; continue; }
    const str = s.slice(i).match(/^'([^']*)'|^"([^"]*)"/);
    if (str) { out.push({ t: 'str', v: str[1] ?? str[2], pos: i }); i += str[0].length; continue; }
    const op = s.slice(i).match(/^(==|!=|<=|>=|&&|\|\||[-+*/^()<>,=\[\];])/);
    if (op) { out.push({ t: 'op', v: op[0], pos: i }); i += op[0].length; continue; }
    throw new ExprError(`Unexpected character "${c}"`, i, s);
  }
  out.push({ t: 'end', pos: s.length });
  return out;
}

/** Parse to an AST. Grammar: or > and > not > comparison > additive > multiplicative > unary > power > primary. */
export function parse(input) {
  const s = String(input || '').slice(0, 2000);
  const toks = tokenize(s);
  let k = 0;
  const peek = () => toks[k];
  const eat = (v) => { const t = toks[k]; if (t.v === v || (v == null)) { k++; return t; } throw new ExprError(`Expected "${v}"`, t.pos, s); };
  const isOp = (...vs) => peek().t === 'op' && vs.includes(peek().v);
  const isKw = (v) => peek().t === 'kw' && peek().v === v;

  function or() { let a = and(); while (isKw('or') || isOp('||')) { k++; a = { type: 'bin', op: 'or', a, b: and() }; } return a; }
  function and() { let a = not(); while (isKw('and') || isOp('&&')) { k++; a = { type: 'bin', op: 'and', a, b: not() }; } return a; }
  function not() { if (isKw('not')) { k++; return { type: 'un', op: 'not', a: not() }; } return cmp(); }
  function cmp() {
    let a = add();
    if (isOp('==', '!=', '<', '>', '<=', '>=')) { const op = toks[k++].v; return { type: 'bin', op, a, b: add() }; }
    if (isKw('in')) { k++; eat('['); const items = [add()]; while (isOp(',')) { k++; items.push(add()); } eat(']'); return { type: 'in', a, items }; }
    return a;
  }
  function add() { let a = mul(); while (isOp('+', '-')) { const op = toks[k++].v; a = { type: 'bin', op, a, b: mul() }; } return a; }
  function mul() { let a = unary(); while (isOp('*', '/')) { const op = toks[k++].v; a = { type: 'bin', op, a, b: unary() }; } return a; }
  function unary() { if (isOp('-', '+')) { const op = toks[k++].v; return op === '-' ? { type: 'un', op: 'neg', a: unary() } : unary(); } return pow(); }
  function pow() { const a = primary(); if (isOp('^')) { k++; return { type: 'bin', op: '^', a, b: unary() }; } return a; }
  function primary() {
    const t = peek();
    if (t.t === 'num') { k++; return { type: 'num', v: t.v }; }
    if (t.t === 'str') { k++; return { type: 'str', v: t.v }; }
    if (t.t === 'date') {
      k++;
      const ms = Date.parse(t.v.length === 10 ? `${t.v}T00:00:00Z` : `${t.v.replace(' ', 'T')}Z`);
      if (!Number.isFinite(ms)) throw new ExprError(`Invalid date "${t.v}"`, t.pos, s);
      return { type: 'num', v: ms / 86400000 + 40587, date: t.v };
    }
    if (t.t === 'op' && t.v === '(') { k++; const e = or(); eat(')'); return e; }
    if (t.t === 'id') {
      k++;
      const name = t.v;
      if (isOp('(')) {
        const f = FUNCS[name.toLowerCase()];
        if (!f) throw new ExprError(`Unknown function "${name}". Allowed: ${Object.keys(FUNCS).join(', ')}`, t.pos, s);
        k++;
        const args = [];
        if (!isOp(')')) { args.push(or()); while (isOp(',')) { k++; args.push(or()); } }
        eat(')');
        if (args.length < f[0] || args.length > f[1]) throw new ExprError(`${name}() takes ${f[0] === f[1] ? f[0] : `${f[0]}–${f[1]}`} argument(s)`, t.pos, s);
        return { type: 'call', name: name.toLowerCase(), args, pos: t.pos };
      }
      return { type: 'var', name, pos: t.pos };
    }
    throw new ExprError(t.t === 'end' ? 'Expression ends too early' : `Unexpected "${t.v}"`, t.pos, s);
  }

  const e = or();
  if (peek().t !== 'end') throw new ExprError(`Unexpected "${peek().v}"`, peek().pos, s);
  return e;
}

/** Collect variable and function names (for validation and explanation). */
export function names(ast, acc = { vars: new Set(), funcs: new Set() }) {
  if (!ast) return acc;
  if (ast.type === 'var') acc.vars.add(ast.name);
  if (ast.type === 'call') { acc.funcs.add(ast.name); ast.args.forEach((a) => names(a, acc)); }
  for (const key of ['a', 'b']) if (ast[key]) names(ast[key], acc);
  if (ast.items) ast.items.forEach((a) => names(a, acc));
  return acc;
}

// ------------------------------------------------------------------ scalar evaluation (selections)
export function evalScalar(ast, env) {
  switch (ast.type) {
    case 'num': return ast.v;
    case 'str': return ast.v;
    case 'var': {
      const key = Object.keys(env).find((x) => x.toLowerCase() === ast.name.toLowerCase());
      if (key === undefined) throw new ExprError(`Unknown name "${ast.name}". Allowed: ${Object.keys(env).join(', ')}`, ast.pos, '');
      return env[key];
    }
    case 'un': { const a = evalScalar(ast.a, env); return ast.op === 'not' ? !a : -a; }
    case 'in': { const a = evalScalar(ast.a, env); return ast.items.some((it) => evalScalar(it, env) === a); }
    case 'bin': {
      const a = evalScalar(ast.a, env), b = evalScalar(ast.b, env);
      switch (ast.op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '^': return a ** b;
        case '==': return a === b; case '!=': return a !== b; case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b;
        case 'and': return !!a && !!b; case 'or': return !!a || !!b;
      }
      break;
    }
    case 'call': {
      const v = ast.args.map((x) => evalScalar(x, env));
      const F = { abs: Math.abs, sqrt: Math.sqrt, log10: Math.log10, ln: Math.log, exp: Math.exp, min: Math.min, max: Math.max, mean: (...x) => x.reduce((p, q) => p + q, 0) / x.length, clip: (x, a, b) => Math.min(b, Math.max(a, x)) }[ast.name];
      if (!F) throw new ExprError(`${ast.name}() cannot be used here`, ast.pos, '');
      return F(...v);
    }
  }
  throw new ExprError('Cannot evaluate expression', 0, '');
}

// ------------------------------------------------------------------ image evaluation (arithmetic)
/**
 * Evaluate per pixel. ctx = { n, D: (d) => Float32Array|null for the current frame's detector co-add,
 *   epoch: (k) => Float32Array|null (1-based), wl: (a, b) => Float32Array|null, vars: {name: number} }
 */
export function evalImage(ast, ctx) {
  const N = ctx.n * ctx.n;
  const constant = (v) => ({ c: v });
  const isC = (x) => x && x.c !== undefined;
  const nanArr = () => new Float32Array(N).fill(NaN);
  function ev(node) {
    switch (node.type) {
      case 'num': return constant(node.v);
      case 'var': {
        const m = node.name.match(/^D([1-6])$/i);
        if (m) { const a = ctx.D(Number(m[1])); return { a: a || nanArr(), missing: !a ? `D${m[1]}` : null }; }
        const key = Object.keys(ctx.vars || {}).find((x) => x.toLowerCase() === node.name.toLowerCase());
        if (key) return constant(ctx.vars[key]);
        if (/^(img|frame|all)$/i.test(node.name)) return { a: ctx.all() };
        throw new ExprError(`Unknown name "${node.name}". Use D1–D6, frame, epoch(k), wl(a,b), or numbers`, node.pos, '');
      }
      case 'un': { const x = ev(node.a); if (node.op === 'not') throw new ExprError('"not" is for selections, not images', 0, ''); return map1(x, (v) => -v); }
      case 'bin': {
        const x = ev(node.a), y = ev(node.b);
        const f = { '+': (p, q) => p + q, '-': (p, q) => p - q, '*': (p, q) => p * q, '/': (p, q) => p / q, '^': (p, q) => p ** q }[node.op];
        if (!f) throw new ExprError(`Operator "${node.op}" is for selections, not images`, 0, '');
        return map2(x, y, f);
      }
      case 'call': {
        if (node.name === 'epoch') { const k = ev(node.args[0]); if (!isC(k)) throw new ExprError('epoch(k) needs a number', node.pos, ''); const a = ctx.epoch(Math.round(k.c)); return { a: a || nanArr(), missing: a ? null : `epoch ${k.c}` }; }
        if (node.name === 'wl') { const a1 = ev(node.args[0]), b1 = ev(node.args[1]); if (!isC(a1) || !isC(b1)) throw new ExprError('wl(from, to) needs numbers in µm', node.pos, ''); const a = ctx.wl(a1.c, b1.c); return { a: a || nanArr(), missing: a ? null : `wl(${a1.c},${b1.c})` }; }
        const args = node.args.map(ev);
        const F = { abs: Math.abs, sqrt: Math.sqrt, log10: Math.log10, ln: Math.log, exp: Math.exp }[node.name];
        if (F) return map1(args[0], F);
        if (node.name === 'min' || node.name === 'max' || node.name === 'mean') {
          let acc = args[0];
          for (let i = 1; i < args.length; i++) acc = map2(acc, args[i], node.name === 'min' ? Math.min : node.name === 'max' ? Math.max : (p, q) => p + q);
          return node.name === 'mean' ? map2(acc, constant(args.length), (p, q) => p / q) : acc;
        }
        if (node.name === 'clip') { const lo = args[1], hi = args[2]; return map2(map2(args[0], lo, Math.max), hi, Math.min); }
        throw new ExprError(`${node.name}() cannot be used on images`, node.pos, '');
      }
    }
    throw new ExprError('Cannot evaluate expression', 0, '');
  }
  function map1(x, f) { if (isC(x)) return constant(f(x.c)); const o = new Float32Array(N); for (let i = 0; i < N; i++) o[i] = f(x.a[i]); return { a: o, missing: x.missing }; }
  function map2(x, y, f) {
    if (isC(x) && isC(y)) return constant(f(x.c, y.c));
    const o = new Float32Array(N);
    for (let i = 0; i < N; i++) o[i] = f(isC(x) ? x.c : x.a[i], isC(y) ? y.c : y.a[i]);
    return { a: o, missing: x.missing || y.missing };
  }
  const r = ev(ast);
  if (isC(r)) return { data: new Float32Array(N).fill(r.c), missing: null };
  return { data: r.a, missing: r.missing };
}

/** Split typed equations into assignments (name = expr), a selection (where …) and an image expression. */
export function splitStatements(text) {
  const out = { assign: {}, where: null, image: null, errors: [] };
  for (const raw of String(text || '').split(/[;\n]+/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const w = line.match(/^(?:epochs?|frames?|exposures?)?\s*where\s+(.+)$/i);
      if (w) { parse(w[1]); out.where = w[1].trim(); continue; }
      const a = line.match(/^([A-Za-z_]\w*)\s*(\(\s*t\s*\))?\s*=(?!=)\s*(.+)$/);
      if (a && a[2]) throw new ExprError('Motion models are written as numbers: pmra = <mas/yr>; pmdec = <mas/yr>; epoch = <year of the position>', 0, line);
      if (a) a.splice(2, 1);
      if (a) {
        const name = a[1].toLowerCase();
        if (name === 'img' || name === 'image' || name === 'frame') { parse(a[2]); out.image = a[2].trim(); continue; }
        const v = evalScalar(parse(a[2]), {});
        if (!Number.isFinite(v)) throw new ExprError('Assignments need a number', 0, line);
        out.assign[name] = v;
        continue;
      }
      parse(line); out.image = line;
    } catch (e) {
      out.errors.push({ line, message: e.message, pointer: e instanceof ExprError ? `${line}\n${' '.repeat(Math.max(0, e.pos))}^` : line });
    }
  }
  return out;
}
