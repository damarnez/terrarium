// http.ts — answer the dapp's HTTP calls (REST APIs, subgraphs, indexers) from the chain in the Worker.
//
// A dapp rarely reads the chain alone: it asks a subgraph for the last swaps, a price API for USD values, its own
// backend for a leaderboard. Inside the Terrarium there is no indexer, so those calls would go to the real internet and
// describe a chain that is not the one in the page. A scenario declares `http` routes: which URLs to intercept and how
// to answer them with data computed from the chain (ctx.pub, ctx.sim, logs). The page side patches `fetch` (like a
// wallet extension or a Service Worker would; the dapp's code is untouched), matching requests are posted to the
// Worker, the route's handler runs with the scenario context, and the page builds a real `Response` from the answer.
// Everything else passes through to the network untouched.
import type { ScenarioContext } from './scenario.ts';

/** what a handler receives: a plain, serialisable view of the request */
export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** the raw body (null for GET / HEAD) */
  body: string | null;
  /** the body parsed as JSON, or null */
  json: any;
  /** the query string as an object */
  query: Record<string, string>;
}
/** what a handler may return explicitly (see `reply`); anything else is serialised as JSON with status 200 */
export interface HttpReply { __terrariumReply: true; status: number; headers: Record<string, string>; body: string }
/** one top-level field of a GraphQL operation, as the `graphql` resolvers receive it */
export interface GraphqlQuery {
  /** the field name (`swaps`) and the alias the client wants it under (defaults to the name) */
  field: string; alias: string;
  /** the field's arguments with variables substituted: `{ first: 5, orderBy: 'timestamp', where: { pair: '0x…' } }` */
  args: Record<string, unknown>;
  /** the names of the sub-fields the client selected (one level): `['id', 'timestamp', 'amount0In']` */
  selection: string[];
  variables: Record<string, unknown>;
  operationName: string | null;
  /** the whole operation text, if you need more than this parser gives */
  query: string;
}
export type GraphqlResolver = (ctx: ScenarioContext, q: GraphqlQuery) => unknown;

export interface HttpRoute {
  name?: string;
  /** which requests: a URL prefix (`'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2'`), a glob with `*`
   *  (`'https://api.coingecko.com/api/v3/simple/price*'`), or a RegExp. Matched against the full URL. */
  match: string | RegExp;
  /** restrict to one HTTP method (default: any) */
  method?: string;
  /** answer the request: return JSON-serialisable data (→ 200 application/json; bigints become strings), a string
   *  (→ 200 text/plain), or `reply(body, { status, headers })` for anything else */
  handler?(ctx: ScenarioContext, req: HttpRequest): unknown;
  /** ...or, for a GraphQL endpoint, one resolver per top-level query field. The runtime parses the operation, calls each
   *  selected field's resolver with its arguments (variables substituted) and answers `{ data: { field: result } }`;
   *  a missing resolver or a throwing one becomes a GraphQL `errors` entry, as a real server would answer.
   *  With both `handler` and `graphql`, the handler runs first as a gate: return `undefined` to let the resolvers
   *  answer, or a `reply(…, { status: 503 })` to take the whole endpoint down. */
  graphql?: Record<string, GraphqlResolver>;
}

const JSON_HEADERS = { 'content-type': 'application/json' };
export const toJson = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

/** an explicit HTTP answer: `reply({ error: 'indexer down' }, { status: 503 })`, `reply('<xml/>', { headers: { 'content-type': 'text/xml' } })` */
export function reply(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): HttpReply {
  const text = typeof body === 'string';
  return { __terrariumReply: true, status: init.status ?? 200, headers: { ...(text ? { 'content-type': 'text/plain' } : JSON_HEADERS), ...init.headers }, body: text ? body : toJson(body) };
}
const isReply = (v: any): v is HttpReply => !!v && typeof v === 'object' && v.__terrariumReply === true;

// ---- matching: the page needs to know what to intercept without asking the Worker for every fetch -----------------
export type WireRoute = { index: number; name?: string; match: string | { regex: string; flags: string }; method?: string };
export const toWire = (routes: HttpRoute[]): WireRoute[] => routes.map((r, index) => ({ index, name: r.name, method: r.method?.toUpperCase(), match: r.match instanceof RegExp ? { regex: r.match.source, flags: r.match.flags } : r.match }));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** a string is a prefix (`https://api.example.com/v1/` matches every URL under it); `*` is a wildcard; a RegExp is itself */
export function compileMatcher(w: WireRoute): (url: string, method: string) => boolean {
  const re = typeof w.match === 'string'
    ? (w.match.includes('*') ? new RegExp('^' + w.match.split('*').map(escapeRe).join('.*') + '$') : null)
    : new RegExp(w.match.regex, w.match.flags);
  const prefix = typeof w.match === 'string' && !re ? w.match : null;
  return (url, method) => (!w.method || w.method === method.toUpperCase()) && (prefix !== null ? url.startsWith(prefix) : re!.test(url));
}

// ---- the Worker side: run a route ---------------------------------------------------------------------------------
export async function runRoute(ctx: ScenarioContext, route: HttpRoute, raw: { url: string; method: string; headers?: Record<string, string>; body?: string | null }): Promise<Omit<HttpReply, '__terrariumReply'>> {
  let json: any = null; try { json = raw.body ? JSON.parse(raw.body) : null; } catch { json = null; }
  const query: Record<string, string> = {}; try { for (const [k, v] of new URL(raw.url).searchParams) query[k] = v; } catch { /* relative or odd URL: no query */ }
  const req: HttpRequest = { url: raw.url, method: raw.method.toUpperCase(), headers: raw.headers ?? {}, body: raw.body ?? null, json, query };
  let result: unknown;
  if (route.graphql && route.handler) result = await route.handler(ctx, req);   // the gate
  if (route.graphql && result === undefined) {
    const source = req.json?.query ?? req.query.query ?? '';
    let variables = req.json?.variables ?? {}; if (typeof variables === 'string') { try { variables = JSON.parse(variables); } catch { variables = {}; } }
    if (!req.json?.variables && req.query.variables) { try { variables = JSON.parse(req.query.variables); } catch { variables = {}; } }
    const operationName = req.json?.operationName ?? req.query.operationName ?? null;
    const data: Record<string, unknown> = {}, errors: { message: string; path?: string[] }[] = [];
    let ops: GraphqlQuery[] = [];
    try { ops = parseGraphql(source, variables, operationName); }
    catch (e: any) { const r = reply({ errors: [{ message: `Syntax Error: ${e?.message ?? e}` }] }, { status: 400 }); return { status: r.status, headers: r.headers, body: r.body }; }
    for (const q of ops) {
      const resolver = route.graphql[q.field];
      if (!resolver) { data[q.alias] = null; errors.push({ message: `Type "Query" has no field "${q.field}"`, path: [q.alias] }); continue; }
      try { data[q.alias] = await resolver(ctx, q); } catch (e: any) { data[q.alias] = null; errors.push({ message: String(e?.message ?? e), path: [q.alias] }); }
    }
    result = errors.length ? { data, errors } : { data };
  } else if (!route.graphql && route.handler) result = await route.handler(ctx, req);
  else if (!route.graphql) throw new Error(`http route ${route.name ?? route.match} has neither handler nor graphql`);
  const r = isReply(result) ? result : reply(result === undefined ? null : result);
  return { status: r.status, headers: r.headers, body: r.body };
}

// ---- a small GraphQL parser: the top-level fields of one operation, their arguments and selections ----------------
type Tok = { t: 'punct' | 'name' | 'num' | 'str' | 'var'; v: string };
function tokenize(src: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s|,/.test(c)) { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (src.startsWith('"""', i)) { const end = src.indexOf('"""', i + 3); if (end < 0) throw new Error('unterminated block string'); out.push({ t: 'str', v: src.slice(i + 3, end) }); i = end + 3; continue; }
    if (c === '"') { let j = i + 1, s = ''; while (j < src.length && src[j] !== '"') { if (src[j] === '\\') { s += JSON.parse(`"${src.slice(j, j + (src[j + 1] === 'u' ? 6 : 2))}"`); j += src[j + 1] === 'u' ? 6 : 2; } else s += src[j++]; } if (j >= src.length) throw new Error('unterminated string'); out.push({ t: 'str', v: s }); i = j + 1; continue; }
    if (c === '$') { const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i + 1)); if (!m) throw new Error('bad variable'); out.push({ t: 'var', v: m[0] }); i += 1 + m[0].length; continue; }
    if (src.startsWith('...', i)) { out.push({ t: 'punct', v: '...' }); i += 3; continue; }
    if ('{}()[]:!=@|&'.includes(c)) { out.push({ t: 'punct', v: c }); i++; continue; }
    let m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i)); if (m) { out.push({ t: 'num', v: m[0] }); i += m[0].length; continue; }
    m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i)); if (m) { out.push({ t: 'name', v: m[0] }); i += m[0].length; continue; }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  return out;
}
/** Parse a GraphQL document and return the top-level fields of the selected operation (the first one, or `operationName`).
 *  Arguments become plain values with variables substituted (and variable defaults applied); fragments are not expanded. */
export function parseGraphql(source: string, variables: Record<string, unknown> = {}, operationName: string | null = null): GraphqlQuery[] {
  const toks = tokenize(source); let p = 0;
  const peek = () => toks[p], next = () => { if (p >= toks.length) throw new Error('unexpected end of query'); return toks[p++]; };
  const expect = (v: string) => { const t = next(); if (t.t !== 'punct' || t.v !== v) throw new Error(`expected ${v}, got ${t.v}`); };
  const skipBalanced = (open: string, close: string) => { expect(open); let depth = 1; while (depth) { const t = next(); if (t.t === 'punct' && t.v === open) depth++; else if (t.t === 'punct' && t.v === close) depth--; } };
  const skipDirectives = () => { while (peek()?.t === 'punct' && peek().v === '@') { next(); next(); if (peek()?.t === 'punct' && peek().v === '(') skipBalanced('(', ')'); } };
  const value = (vars: Record<string, unknown>): unknown => {
    const t = next();
    if (t.t === 'var') return vars[t.v];
    if (t.t === 'num') return Number(t.v);
    if (t.t === 'str') return t.v;
    if (t.t === 'name') return t.v === 'true' ? true : t.v === 'false' ? false : t.v === 'null' ? null : t.v;   // enums stay strings
    if (t.v === '[') { const a: unknown[] = []; while (!(peek().t === 'punct' && peek().v === ']')) a.push(value(vars)); next(); return a; }
    if (t.v === '{') { const o: Record<string, unknown> = {}; while (!(peek().t === 'punct' && peek().v === '}')) { const k = next().v; expect(':'); o[k] = value(vars); } next(); return o; }
    throw new Error(`unexpected ${t.v}`);
  };
  const args = (vars: Record<string, unknown>) => { const o: Record<string, unknown> = {}; if (!(peek()?.t === 'punct' && peek().v === '(')) return o; next(); while (!(peek().t === 'punct' && peek().v === ')')) { const k = next().v; expect(':'); o[k] = value(vars); } next(); return o; };
  /** one level of field names inside { … }, skipping each field's own args, directives and nested selection */
  const selectionNames = (): string[] => { const names: string[] = []; expect('{'); while (!(peek().t === 'punct' && peek().v === '}')) { const t = next(); if (t.t === 'punct' && t.v === '...') { if (peek().t === 'name' && peek().v === 'on') { next(); next(); } else if (peek().t === 'name') { next(); continue; } skipDirectives(); selectionNames(); continue; } let name = t.v; if (peek().t === 'punct' && peek().v === ':') { next(); name = next().v; } names.push(name); if (peek().t === 'punct' && peek().v === '(') skipBalanced('(', ')'); skipDirectives(); if (peek().t === 'punct' && peek().v === '{') selectionNames(); } next(); return names; };

  // ---- definitions: pick the operation ----
  type Op = { name: string | null; start: number; vars: Record<string, unknown> };
  const ops: Op[] = [];
  while (p < toks.length) {
    const t = peek();
    if (t.t === 'name' && t.v === 'fragment') { next(); next(); next(); next(); skipDirectives(); skipBalanced('{', '}'); continue; }
    const vars: Record<string, unknown> = { ...variables }; let name: string | null = null;
    if (t.t === 'name' && ['query', 'mutation', 'subscription'].includes(t.v)) {
      next(); if (peek().t === 'name') name = next().v;
      if (peek().t === 'punct' && peek().v === '(') {   // variable definitions: $x: Type! = default
        next();
        while (!(peek().t === 'punct' && peek().v === ')')) {
          const v = next(); if (v.t !== 'var') throw new Error('expected a variable definition'); expect(':');
          if (peek().t === 'punct' && peek().v === '[') skipBalanced('[', ']'); else next(); if (peek().t === 'punct' && peek().v === '!') next();
          if (peek().t === 'punct' && peek().v === '=') { next(); const d = value({}); if (vars[v.v] === undefined) vars[v.v] = d; }
          skipDirectives();
        }
        next();
      }
      skipDirectives();
    } else if (!(t.t === 'punct' && t.v === '{')) throw new Error(`unexpected ${t.v}`);
    ops.push({ name, start: p, vars }); skipBalanced('{', '}');
  }
  if (!ops.length) throw new Error('no operation in query');
  const op = operationName ? ops.find((o) => o.name === operationName) : ops[0];
  if (!op) throw new Error(`unknown operation "${operationName}"`);
  // ---- its top-level fields ----
  p = op.start; expect('{');
  const fields: GraphqlQuery[] = [];
  while (!(peek().t === 'punct' && peek().v === '}')) {
    const t = next();
    if (t.t === 'punct' && t.v === '...') { if (peek().t === 'name' && peek().v === 'on') { next(); next(); } else if (peek().t === 'name') { next(); continue; } skipDirectives(); skipBalanced('{', '}'); continue; }   // top-level fragments are not expanded
    let field = t.v, alias = t.v;
    if (peek().t === 'punct' && peek().v === ':') { next(); field = next().v; }
    const a = args(op.vars); skipDirectives();
    const selection = peek()?.t === 'punct' && peek().v === '{' ? selectionNames() : [];
    fields.push({ field, alias, args: a, selection, variables: op.vars, operationName: op.name, query: source });
  }
  return fields;
}

// ---- the page side: patch fetch, forward matching requests to the Worker --------------------------------------------
type Provider = { request(a: { method: string; params?: unknown[] }): Promise<any> };
/** Replace `globalThis.fetch` with one that answers the scenario's routes from the Worker and passes everything else
 *  through. `routes` resolves to the Worker's route list (it can take a moment: the first fetches wait for it).
 *  Returns a function that restores the original fetch. */
export function installHttpInterceptor(provider: Provider, routes: Promise<WireRoute[]>, scope: any = globalThis): () => void {
  const realFetch: typeof fetch = scope.fetch.bind(scope);
  const compiled = routes.then((rs) => rs.map((w) => ({ ...w, test: compileMatcher(w) })), () => []);
  scope.fetch = async (input: any, init?: RequestInit) => {
    const list = await compiled;
    if (!list.length) return realFetch(input, init);
    const req = input instanceof Request ? input.clone() : new Request(input, init);
    const route = list.find((r) => r.test(req.url, req.method));
    if (!route) return realFetch(input, init);
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.text();
    const headers: Record<string, string> = {}; req.headers.forEach((v, k) => { headers[k] = v; });
    try {
      const r = await provider.request({ method: 'terrarium_http', params: [route.index, { url: req.url, method: req.method, headers, body }] });
      return new Response(r.body, { status: r.status, headers: r.headers });
    } catch (e: any) {   // a bug in the scenario's handler: surface it as the failed API call it would be, and say so
      console.warn(`[terrarium] http route ${route.name ?? route.index} failed:`, e?.message ?? e);
      return new Response(toJson({ error: String(e?.message ?? e) }), { status: 500, headers: JSON_HEADERS });
    }
  };
  return () => { scope.fetch = realFetch; };
}
