// devbar.ts — the dev overlay. Plain DOM, own styles, talks to the chain only through provider.request(), so it works
// on top of any dapp (React or not) and never touches the dapp's code. Parts: the bar (grouped controls: scenario, chain,
// wallet, the scenario's own buttons, explorer / reset / hide), the transaction explorer (a panel above it listing every
// transaction with its receipt, decoded call, events and revert reason, fed by `terrarium_transactions`), the scenario
// selector (`terrarium_scenarios` / `terrarium_selectScenario`) when the Worker runs a list, toasts for every action, and
// two keyboard shortcuts (Alt+Shift+T: the bar, Alt+Shift+X: the explorer).
type Provider = { request(a: { method: string; params?: unknown[] }): Promise<any> };

const HIDDEN_KEY = 'terrarium:devbar-hidden';
const CSS = `
#terrarium-devbar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000; display: flex; align-items: center; gap: 6px 14px; flex-wrap: wrap; padding: 8px 16px; background: #14231b; color: #dfe9e3; font: 12.5px/1.4 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; font-variant-numeric: tabular-nums; box-shadow: 0 -1px 0 rgba(255,255,255,0.08); }
#terrarium-devbar[hidden], #terrarium-explorer[hidden], #terrarium-devbar-show[hidden], #terrarium-devbar-menu[hidden] { display: none; }
#terrarium-devbar *:focus-visible, #terrarium-explorer *:focus-visible, #terrarium-devbar-show:focus-visible { outline: 2px solid #e8c547; outline-offset: 1px; }
#terrarium-devbar .brand { display: flex; align-items: center; gap: 8px; }
#terrarium-devbar .tag { background: #e8c547; color: #14231b; font-weight: 700; padding: 2px 8px; border-radius: 6px; letter-spacing: 0.01em; }
#terrarium-devbar .name { color: #fff; font-weight: 600; }
#terrarium-devbar select { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14); color: #fff; padding: 5px 8px; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer; max-width: 260px; }
#terrarium-devbar .status { display: flex; align-items: center; gap: 10px; color: rgba(223,233,227,0.72); white-space: nowrap; }
#terrarium-devbar .status b { color: #fff; font-weight: 600; }
#terrarium-devbar .status .warn { color: #e8c547; }
#terrarium-devbar .status .shift { color: #e8c547; font-weight: 600; }
#terrarium-devbar .spacer { flex: 1; min-width: 8px; }
#terrarium-devbar .group { display: flex; align-items: center; gap: 4px; padding-left: 10px; border-left: 1px solid rgba(255,255,255,0.12); position: relative; }
#terrarium-devbar .group[hidden] { display: none; }
#terrarium-devbar .glabel { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(223,233,227,0.45); margin-right: 4px; user-select: none; }
#terrarium-devbar .glabel:empty { display: none; }
@media (max-width: 1280px) { #terrarium-devbar .glabel { display: none; } #terrarium-devbar { gap: 6px 10px; padding: 6px 12px; } }
#terrarium-devbar button, #terrarium-devbar-menu button { background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); color: #fff; padding: 5px 9px; border-radius: 8px; font: inherit; cursor: pointer; white-space: nowrap; }
#terrarium-devbar button:hover { background: rgba(255,255,255,0.15); }
#terrarium-devbar button.on { background: #1f6f5c; border-color: #2b8a73; }
#terrarium-devbar button.armed { background: #7a3b2a; border-color: #b3452c; }
#terrarium-devbar button.danger { border-color: rgba(255,140,110,0.4); color: #ffb5a0; }
#terrarium-devbar button.danger.armed { background: #b3452c; border-color: #ff8c6e; color: #fff; }
#terrarium-devbar button.quiet { background: transparent; border-color: transparent; color: rgba(223,233,227,0.6); }
#terrarium-devbar button.quiet:hover { color: #fff; background: rgba(255,255,255,0.08); }
#terrarium-devbar button .badge { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 999px; background: rgba(255,255,255,0.14); font-size: 11px; line-height: 16px; }
#terrarium-devbar button .badge.bad { background: #b3452c; }
#terrarium-devbar-menu { position: fixed; z-index: 2147483001; display: flex; flex-direction: column; gap: 2px; padding: 4px; background: #1b2e24; color: #dfe9e3; border: 1px solid rgba(255,255,255,0.14); border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,0.4); font: 12.5px/1.4 ui-sans-serif, system-ui, sans-serif; }
#terrarium-devbar-menu button { text-align: left; background: transparent; border-color: transparent; }
#terrarium-devbar-menu button:hover { background: rgba(255,255,255,0.1); }
#terrarium-devbar-show { position: fixed; right: 12px; bottom: 12px; z-index: 2147483000; width: 36px; height: 36px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.2); background: #14231b; color: #e8c547; font: 16px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.35); }
#terrarium-toast { position: fixed; right: 16px; z-index: 2147483001; display: flex; flex-direction: column; gap: 6px; align-items: flex-end; pointer-events: none; font: 12.5px/1.4 ui-sans-serif, system-ui, sans-serif; }
#terrarium-toast div { background: #1b2e24; color: #dfe9e3; border: 1px solid rgba(255,255,255,0.14); border-left: 3px solid #e8c547; border-radius: 8px; padding: 6px 10px; box-shadow: 0 4px 16px rgba(0,0,0,0.35); opacity: 1; transition: opacity 0.3s; max-width: 420px; }
#terrarium-toast div.bad { border-left-color: #ff8c6e; }
#terrarium-toast div.fade { opacity: 0; }
#terrarium-explorer { position: fixed; left: 0; right: 0; z-index: 2147483000; max-height: 60vh; overflow: auto; background: #0f1a14; color: #dfe9e3; border-top: 1px solid rgba(255,255,255,0.12); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
#terrarium-explorer.tall { max-height: 90vh; }
#terrarium-explorer .head { display: flex; align-items: center; gap: 10px; padding: 8px 16px; font: 13px ui-sans-serif, system-ui, sans-serif; color: rgba(223,233,227,0.8); position: sticky; top: 0; background: #0f1a14; border-bottom: 1px solid rgba(255,255,255,0.08); }
#terrarium-explorer .head b { color: #fff; }
#terrarium-explorer .head select, #terrarium-explorer .head input, #terrarium-explorer .head button { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14); color: #fff; padding: 3px 8px; border-radius: 6px; font: inherit; }
#terrarium-explorer .head input { width: 220px; } #terrarium-explorer .head input::placeholder { color: rgba(223,233,227,0.45); }
#terrarium-explorer .head button { cursor: pointer; } #terrarium-explorer .head button:hover { background: rgba(255,255,255,0.15); }
#terrarium-explorer table { width: 100%; border-collapse: collapse; }
#terrarium-explorer th { text-align: left; font-weight: 600; color: rgba(223,233,227,0.6); padding: 6px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); white-space: nowrap; }
#terrarium-explorer th:first-child, #terrarium-explorer td:first-child { padding-left: 16px; }
#terrarium-explorer td { padding: 6px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); white-space: nowrap; vertical-align: top; }
#terrarium-explorer tr.tx { cursor: pointer; }
#terrarium-explorer tr.tx:hover td { background: rgba(255,255,255,0.04); }
#terrarium-explorer tr.tx.open td { background: rgba(255,255,255,0.06); border-bottom-color: transparent; }
#terrarium-explorer .ok { color: #7fd3a8; } #terrarium-explorer .bad { color: #ff9c80; } #terrarium-explorer .wait { color: #e8c547; }
#terrarium-explorer .hash, #terrarium-explorer .addr { color: #9ecbff; }
#terrarium-explorer .hash { cursor: copy; } #terrarium-explorer .hash:hover { text-decoration: underline dotted; }
#terrarium-explorer .name { color: #e8c547; }
#terrarium-explorer .dim { color: rgba(223,233,227,0.55); }
#terrarium-explorer .detail td { padding: 10px 16px 14px 40px; white-space: normal; background: rgba(0,0,0,0.25); }
#terrarium-explorer dl { display: grid; grid-template-columns: max-content 1fr; gap: 3px 16px; margin: 0; }
#terrarium-explorer dt { color: rgba(223,233,227,0.6); } #terrarium-explorer dd { margin: 0; word-break: break-all; }
#terrarium-explorer .events { margin: 10px 0 0; padding: 0; list-style: none; }
#terrarium-explorer .events li { padding: 6px 0 6px 10px; border-left: 2px solid rgba(232,197,71,0.5); margin-bottom: 4px; word-break: break-all; }
#terrarium-explorer .args { color: #dfe9e3; }
#terrarium-explorer .empty { padding: 24px; text-align: center; color: rgba(223,233,227,0.55); font: 13px ui-sans-serif, system-ui, sans-serif; }
`;

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const short = (h: string) => (h && h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h);
const num = (hex: string | null | undefined) => (hex ? BigInt(hex).toString() : '');
/** wei (hex) as ETH with up to 6 decimals, trailing zeros trimmed */
export const formatEth = (hex: string | null | undefined) => {
  if (!hex) return '0';
  const wei = BigInt(hex), whole = wei / 10n ** 18n, frac = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
};
/** wei (hex) as gwei with up to 3 decimals */
const formatGwei = (hex: string | null | undefined) => { if (!hex) return '0'; const wei = BigInt(hex), whole = wei / 10n ** 9n, frac = (wei % 10n ** 9n).toString().padStart(9, '0').slice(0, 3).replace(/0+$/, ''); return frac ? `${whole}.${frac}` : whole.toString(); };
const fmtArgs = (args: any): string => Array.isArray(args) ? args.map(fmtArgs).join(', ') : args && typeof args === 'object' ? Object.entries(args).map(([k, v]) => `${k}: ${fmtArgs(v)}`).join(', ') : String(args);
const time = (hex: string | null) => (hex ? new Date(Number(BigInt(hex)) * 1000).toLocaleTimeString() : '');
/** a duration in seconds as "+1h 30m" / "-2d" */
const span = (s: number) => { const a = Math.abs(s), sign = s < 0 ? '-' : '+'; if (a < 3600) return `${sign}${Math.round(a / 60)}m`; if (a < 86400) { const h = Math.floor(a / 3600), m = Math.round((a % 3600) / 60); return `${sign}${h}h${m ? ` ${m}m` : ''}`; } const d = Math.floor(a / 86400), h = Math.round((a % 86400) / 3600); return `${sign}${d}d${h ? ` ${h}h` : ''}`; };

export interface DevBarOptions {
  /** start collapsed to the leaf (default false). A Hide/Show click is remembered in localStorage and overrides this */
  hidden?: boolean;
}

export function mountDevBar(provider: Provider, opts: DevBarOptions = {}) {
  if (document.getElementById('terrarium-devbar')) return;
  const rpc = (method: string, params: unknown[] = []) => provider.request({ method, params });
  const bar = document.createElement('footer');
  bar.id = 'terrarium-devbar'; bar.dataset.testid = 'devbar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Terrarium dev bar');
  const style = document.createElement('style'); style.textContent = CSS;
  bar.append(style);
  const el = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
  const btn = (label: string, testid: string, title: string, onClick: () => Promise<unknown> | void) => { const b = el(`<button data-testid="${testid}" title="${esc(title)}" aria-label="${esc(title)}">${label}</button>`); b.onclick = () => Promise.resolve(onClick()).catch((e) => { console.warn('[terrarium]', e); toast(e?.message ?? String(e), true); }); return b; };
  const group = (label: string, testid: string, ...children: HTMLElement[]) => { const g = el(`<div class="group" data-testid="${testid}" role="group" aria-label="${esc(label || 'tools')}"><span class="glabel">${label}</span></div>`); g.append(...children); return g; };

  // ---- toasts: every action says what it did --------------------------------------------------------------------------------
  const toasts = el('<div id="terrarium-toast" data-testid="toast" aria-live="polite"></div>');
  const toast = (msg: string, bad = false) => {
    const t = el(`<div${bad ? ' class="bad"' : ''}>${esc(msg)}</div>`); toasts.append(t);
    setTimeout(() => { t.classList.add('fade'); setTimeout(() => t.remove(), 350); }, bad ? 5000 : 2200);
  };

  // ---- brand + scenario selector + status ---------------------------------------------------------------------------
  const brand = el(`<span class="brand"><span class="tag">Terrarium</span><span class="name" data-testid="scenario-name" hidden></span></span>`);
  const scenarioSelect = el(`<select data-testid="scenario" aria-label="Scenario" title="Which scenario the chain runs: switching stores the choice and reloads the page; each scenario keeps its own chain" hidden></select>`) as HTMLSelectElement;
  brand.append(scenarioSelect);
  let scenariosKey = '';
  scenarioSelect.onchange = () => { toast(`Switching to “${scenarioSelect.value}”…`); rpc('terrarium_selectScenario', [scenarioSelect.value]).catch((e) => { console.warn('[terrarium]', e); toast(e?.message ?? String(e), true); }); };
  const status = el(`<span class="status"><span>block <b data-testid="block" data-f="block">…</b></span><span>chain <span data-f="chain">…</span></span><span data-testid="clock" data-f="clock" title="The chain's clock: the timestamp the next block gets. Yellow when it has been shifted away from wall time (deadlines and oracles see this clock, not yours)"></span><span data-f="engine"></span></span>`);

  // ---- chain ------------------------------------------------------------------------------------------------------------
  let mining: 'auto' | 'interval' = 'auto', snap: { id: string; block: number } | null = null, head = 0;
  const bMining = btn('Blocks: instant', 'mining', 'Auto: a block per transaction. Interval: a block every 3s, so you can watch pending states', async () => {
    mining = mining === 'auto' ? 'interval' : 'auto';
    await (mining === 'auto' ? rpc('evm_setAutomine', [true]) : rpc('evm_setIntervalMining', [3000]));
    bMining.textContent = mining === 'auto' ? 'Blocks: instant' : 'Blocks: every 3s'; bMining.classList.toggle('on', mining === 'interval');
    toast(mining === 'auto' ? 'A block per transaction again' : 'A block every 3 seconds: transactions stay pending in between');
  });
  const bSnap = btn('Snapshot', 'snapshot', 'Snapshot the chain; revert brings blocks, receipts, journal and the UI history back', async () => {
    if (snap) { await rpc('evm_revert', [snap.id]); toast(`Reverted to block ${snap.block}`); snap = null; bSnap.textContent = 'Snapshot'; bSnap.classList.remove('on'); }
    else { const id = await rpc('evm_snapshot'); snap = { id, block: head }; bSnap.textContent = `Revert to block ${head}`; bSnap.classList.add('on'); toast(`Snapshot at block ${head}: the next click reverts to it`); }
  });
  const timeMenu = el('<div id="terrarium-devbar-menu" data-testid="time-menu" role="menu" aria-label="Move the chain clock" hidden></div>');   // on the body: a menu inside the bar was clipped by its layout
  const shift = (seconds: number, label: string, testid: string) => btn(label, testid, `Move the chain clock forward ${label.slice(1)} and mine a block`, async () => { timeMenu.hidden = true; await rpc('evm_increaseTime', [seconds]); await rpc('evm_mine'); toast(`Chain clock moved ${label}; a block sealed at the new time`); });
  timeMenu.append(shift(60, '+1 minute', 'plus-minute'), shift(3600, '+1 hour', 'plus-hour'), shift(86400, '+1 day', 'plus-day'), shift(7 * 86400, '+1 week', 'plus-week'));
  const bTime = btn('Time ▾', 'time', 'Move the chain clock forward: deadlines expire, oracles go stale, interest accrues', () => {
    timeMenu.hidden = !timeMenu.hidden;
    if (!timeMenu.hidden) { const r = bTime.getBoundingClientRect(); timeMenu.style.left = `${r.left}px`; timeMenu.style.bottom = `${window.innerHeight - r.top + 6}px`; }
  });
  bTime.setAttribute('aria-haspopup', 'menu');
  const gChain = group('chain', 'group-chain',
    btn('Mine a block', 'mine', 'Mine one empty block', async () => { await rpc('evm_mine'); toast(`Mined block ${head + 1}`); }),
    bTime, bMining, bSnap);
  document.addEventListener('click', (e) => { if (!timeMenu.hidden && !bTime.contains(e.target as Node) && !timeMenu.contains(e.target as Node)) timeMenu.hidden = true; });

  // ---- wallet -----------------------------------------------------------------------------------------------------------
  const bReject = btn('Reject next tx', 'reject-next', 'The wallet rejects the next signature request (EIP-1193 error 4001), like a user hitting Cancel', async () => { await rpc('terrarium_setWallet', [{ rejectNext: 1 }]); toast('The wallet will reject the next signature request'); });
  const bLatency = btn('Wallet: instant', 'wallet-latency', 'Make the wallet take 2 seconds to answer, like a real one', async () => { const w = await rpc('terrarium_getWallet'); await rpc('terrarium_setWallet', [{ latencyMs: w.latencyMs ? 0 : 2000 }]); toast(w.latencyMs ? 'The wallet answers instantly again' : 'The wallet now takes 2 seconds to answer'); });
  const bLag = btn('Receipts: instant', 'receipt-lag', 'Receipts appear 3 seconds after the block, like a node that has not caught up', async () => { const w = await rpc('terrarium_getWallet'); await rpc('terrarium_setWallet', [{ receiptLagMs: w.receiptLagMs ? 0 : 3000 }]); toast(w.receiptLagMs ? 'Receipts are immediate again' : 'Receipts now arrive 3 seconds after the block'); });
  const gWallet = group('wallet', 'group-wallet', bReject, bLatency, bLag);

  // ---- the scenario's own knobs: actors + controls ------------------------------------------------------------------------
  const bActors = btn('Actors off', 'actors', 'Scripted actors: other users, keepers, arbitrageurs trading on their own', async () => { const on = await rpc('terrarium_actors'); toast(on ? `${actorsLabel} on: other actors are trading now` : `${actorsLabel} off`); });
  let actorsLabel = 'Actors';
  const controls = el('<span class="controls" style="display:contents"></span>'); let controlsKey = '';
  const gScenario = group('scenario', 'group-scenario', bActors, controls);

  // ---- the transaction explorer -----------------------------------------------------------------------------------------
  const panel = el(`<section id="terrarium-explorer" data-testid="explorer" role="region" aria-label="Transactions" hidden></section>`);
  const open = new Set<string>();   // expanded rows, by hash, kept across refreshes
  let lastRender = '', filter: 'all' | 'mine' | 'failed' = 'all', search = '', me: string | null = null;   // `me`: accounts[0] from terrarium_status
  const bTxs = btn('Transactions', 'txs', 'Every transaction on this chain, like a block explorer: receipt, decoded call, events, revert reason (Alt+Shift+X)', () => togglePanel());
  const togglePanel = async (show: boolean = !!panel.hidden) => { panel.hidden = !show; bTxs.classList.toggle('on', show); lastRender = ''; if (show) { await refreshTxs(); panel.querySelector<HTMLInputElement>('[data-testid=tx-search]')?.focus(); } place(); };
  const place = () => { panel.style.bottom = `${bar.offsetHeight}px`; toasts.style.bottom = `${bar.offsetHeight + (panel.hidden ? 0 : panel.offsetHeight) + 12}px`; };   // toasts sit above whatever is open
  const statusCell = (s: string) => s === 'success' ? '<span class="ok" title="success">✓</span>' : s === 'pending' ? '<span class="wait" title="pending">⏳</span>' : `<span class="bad" title="${s}">✗</span>`;
  const who = (labels: Record<string, string>, a: string | null) => a ? `<span class="addr" title="${a}">${esc(labels[a.toLowerCase()] ?? short(a))}</span>` : '<span class="dim">contract creation</span>';
  const matches = (t: any, L: Record<string, string>) => {
    if (!search) return true;
    const q = search.toLowerCase();
    const hay = [t.hash, t.from, t.to, L[t.from?.toLowerCase()], L[t.to?.toLowerCase()], t.method?.name, t.method?.selector, t.revert?.name, t.status, ...(t.logs ?? []).flatMap((l: any) => [l.decoded?.name, L[l.address?.toLowerCase()], l.address])].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  };
  const render = (data: { total: number; labels: Record<string, string>; transactions: any[] }) => {
    const key = JSON.stringify([data.total, data.transactions.map((t) => [t.hash, t.status]), [...open], filter, search, me]);
    if (key === lastRender) return; lastRender = key;
    const L = data.labels ?? {};
    const shown = data.transactions.filter((t) => (filter === 'all' ? true : filter === 'failed' ? t.status !== 'success' && t.status !== 'pending' : !!me && t.from?.toLowerCase() === me.toLowerCase()) && matches(t, L));
    const rows = shown.map((t) => {
      const method = t.method ? (t.method.name ? `<span class="name">${esc(t.method.name)}</span>` : `<span class="dim">${esc(t.method.selector)}</span>`) : '<span class="dim">transfer</span>';
      const isOpen = open.has(t.hash);
      const detail = !isOpen ? '' : `<tr class="detail" data-testid="tx-detail"><td colspan="10"><dl>
        <dt>hash</dt><dd class="hash" data-copy="${t.hash}" title="click to copy">${esc(t.hash)}</dd>
        <dt>status</dt><dd>${esc(t.status)}${t.status === 'reverted' || t.status === 'dropped' ? ` <span class="bad">· ${t.revert ? esc(t.revert.name) + '(' + esc(fmtArgs(t.revert.args)) + ')' : esc(t.error ?? '')}</span>` : ''}</dd>
        <dt>block</dt><dd>${t.receipt ? `${num(t.receipt.blockNumber)} · ${esc(time(t.timestamp))} · index ${num(t.receipt.transactionIndex)}` : 'pending'}</dd>
        <dt>from</dt><dd>${who(L, t.from)} <span class="dim">${esc(t.from)}</span></dd>
        <dt>to</dt><dd>${t.to ? `${who(L, t.to)} <span class="dim">${esc(t.to)}</span>` : `<span class="dim">created</span> ${esc(t.receipt?.contractAddress ?? '')}`}</dd>
        <dt>value</dt><dd>${formatEth(t.value)} ETH</dd>
        <dt>nonce</dt><dd>${num(t.nonce)}</dd>
        <dt>gas</dt><dd>${t.receipt ? `${num(t.receipt.gasUsed)} used` : ''} of ${num(t.gas)} limit${t.receipt ? ` · ${esc(formatGwei(t.receipt.effectiveGasPrice))} gwei/gas · fee ${esc(formatEth('0x' + (BigInt(t.receipt.gasUsed) * BigInt(t.receipt.effectiveGasPrice)).toString(16)))} ETH` : ''}</dd>
        <dt>input</dt><dd>${t.method?.name ? `<span class="name">${esc(t.method.name)}</span>(<span class="args">${esc(fmtArgs(t.method.args))}</span>)<br>` : ''}<span class="dim">${esc(t.input === '0x' ? '0x (no data)' : t.input)}</span></dd>
        ${t.revertData && t.revertData !== '0x' ? `<dt>revert data</dt><dd class="dim">${esc(t.revertData)}</dd>` : ''}
      </dl>
      ${t.logs?.length ? `<ul class="events" data-testid="tx-events">${t.logs.map((l: any) => `<li><span class="dim">#${num(l.logIndex)}</span> ${who(L, l.address)} ${l.decoded ? `<span class="name">${esc(l.decoded.name)}</span>(<span class="args">${esc(fmtArgs(l.decoded.args))}</span>)` : `<span class="dim">topics ${l.topics.map(esc).join(' ')}<br>data ${esc(l.data)}</span>`}</li>`).join('')}</ul>` : `<div class="dim" style="margin-top:8px">no events</div>`}
      </td></tr>`;
      return `<tr class="tx${isOpen ? ' open' : ''}" data-testid="tx-row" data-hash="${t.hash}" data-status="${t.status}">
        <td>${statusCell(t.status)}</td><td>${t.receipt ? num(t.receipt.blockNumber) : '<span class="dim">pending</span>'}</td><td class="dim">${esc(time(t.timestamp))}</td>
        <td class="hash" data-copy="${t.hash}" title="${t.hash} (click to copy)">${short(t.hash)}</td><td>${method}</td><td>${who(L, t.from)}</td><td>${who(L, t.to)}</td>
        <td>${formatEth(t.value)} ETH</td><td class="dim">${t.receipt ? num(t.receipt.gasUsed) : ''}</td><td class="dim">${t.logs?.length ? `${t.logs.length} event${t.logs.length === 1 ? '' : 's'}` : ''}</td></tr>${detail}`;
    }).join('');
    const headEl = panel.querySelector('.head');
    const headHtml = `<b>Transactions</b> <span data-testid="explorer-count">${data.total} on this chain${data.total > data.transactions.length ? ` (showing ${data.transactions.length})` : ''}${filter !== 'all' || search ? `, ${shown.length} shown` : ''}</span>
      <input data-testid="tx-search" type="search" placeholder="filter: hash, address, name, method, event…" aria-label="Filter transactions" value="${esc(search)}">
      <select data-testid="tx-filter" aria-label="Which transactions" title="Which transactions to list"><option value="all"${filter === 'all' ? ' selected' : ''}>all</option><option value="mine"${filter === 'mine' ? ' selected' : ''}>mine (account #0)</option><option value="failed"${filter === 'failed' ? ' selected' : ''}>failed</option></select>
      <span class="spacer" style="flex:1"></span><span class="dim">click a row for the receipt, the decoded call and the events · Esc closes</span>
      <button data-testid="explorer-size" title="Taller / shorter panel">${panel.classList.contains('tall') ? '⇩ shorter' : '⇧ taller'}</button>`;
    const body = rows ? `<table><thead><tr><th></th><th>block</th><th>time</th><th>hash</th><th>method</th><th>from</th><th>to</th><th>value</th><th>gas used</th><th>events</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">${data.total ? 'Nothing matches.' : 'No transactions yet. Do something in the dapp and it appears here.'}</div>`;
    if (headEl && document.activeElement === headEl.querySelector('[data-testid=tx-search]')) {
      // keep the focused search box: update its neighbours only
      headEl.querySelector('[data-testid=explorer-count]')!.textContent = `${data.total} on this chain${filter !== 'all' || search ? `, ${shown.length} shown` : ''}`;
      panel.querySelector('table, .empty')?.remove(); panel.insertAdjacentHTML('beforeend', body);
    } else panel.innerHTML = `<div class="head">${headHtml}</div>${body}`;
    place();
  };
  panel.addEventListener('change', (e) => { const sel = e.target as HTMLSelectElement; if (sel.dataset.testid === 'tx-filter') { filter = sel.value as typeof filter; lastRender = ''; refreshTxs(); } });
  panel.addEventListener('input', (e) => { const inp = e.target as HTMLInputElement; if (inp.dataset.testid === 'tx-search') { search = inp.value.trim(); lastRender = ''; refreshTxs(); } });
  panel.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const copy = target.closest<HTMLElement>('[data-copy]');
    if (copy) { e.stopPropagation(); navigator.clipboard?.writeText(copy.dataset.copy!).then(() => toast(`Copied ${short(copy.dataset.copy!)}`), () => toast('Clipboard unavailable', true)); return; }
    if (target.closest('[data-testid=explorer-size]')) { panel.classList.toggle('tall'); lastRender = ''; refreshTxs(); return; }
    const row = target.closest<HTMLElement>('tr.tx'); if (!row) return;
    const h = row.dataset.hash!; open.has(h) ? open.delete(h) : open.add(h); lastRender = ''; refreshTxs();
  });
  const refreshTxs = async () => { const data = await rpc('terrarium_transactions', [{ limit: 200 }]).catch(() => null); if (data) render(data); };

  // ---- reset (two clicks), hide / show ------------------------------------------------------------------------------------
  let resetArmed: ReturnType<typeof setTimeout> | null = null;
  const bReset = btn('Reset', 'reset', 'Wipe this scenario\'s chain and boot it again from scratch (click twice)', async () => {
    if (!resetArmed) { bReset.textContent = 'Really reset?'; bReset.classList.add('armed'); toast('Click Reset again within 3 seconds to wipe this scenario\'s chain'); resetArmed = setTimeout(() => { resetArmed = null; bReset.textContent = 'Reset'; bReset.classList.remove('armed'); }, 3000); return; }
    clearTimeout(resetArmed); resetArmed = null; bReset.textContent = 'Resetting…';
    await rpc('terrarium_reset'); location.reload();
  });
  bReset.classList.add('danger');
  const pill = el(`<button id="terrarium-devbar-show" data-testid="show" title="Show the Terrarium dev bar (Alt+Shift+T)" aria-label="Show the Terrarium dev bar" hidden>🌱</button>`);
  const remember = (hidden: boolean) => { try { localStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0'); } catch {} };
  const apply = (hidden: boolean) => { bar.hidden = hidden; pill.hidden = !hidden; if (hidden) { panel.hidden = true; bTxs.classList.remove('on'); } document.body.style.paddingBottom = hidden ? '' : '56px'; toasts.style.bottom = hidden ? '60px' : `${(bar.offsetHeight || 48) + 12}px`; };
  const setHidden = (hidden: boolean) => { apply(hidden); remember(hidden); };
  const bHide = btn('Hide', 'hide', 'Hide the dev bar (the chain keeps running); the leaf at the bottom right or Alt+Shift+T brings it back', () => setHidden(true));
  bHide.classList.add('quiet');
  pill.onclick = () => setHidden(false);
  const gTools = group('', 'group-tools', bTxs, bReset, bHide);

  bar.append(brand, status, el('<span class="spacer"></span>'), gChain, gWallet, gScenario, gTools, panel);
  document.body.append(bar, pill, toasts, timeMenu);
  let startHidden = !!opts.hidden; try { const v = localStorage.getItem(HIDDEN_KEY); if (v !== null) startHidden = v === '1'; } catch {}
  apply(startHidden);   // without remembering: the default is not a choice

  // ---- keyboard: Alt+Shift+T the bar, Alt+Shift+X the explorer, Esc closes the explorer / the time menu -----------------------------
  const onKey = (e: KeyboardEvent) => {
    if (!document.getElementById('terrarium-devbar')) { document.removeEventListener('keydown', onKey); return; }
    if (e.altKey && e.shiftKey && (e.code === 'KeyT')) { e.preventDefault(); setHidden(!bar.hidden); }
    else if (e.altKey && e.shiftKey && (e.code === 'KeyX')) { e.preventDefault(); if (bar.hidden) setHidden(false); togglePanel(); }
    else if (e.key === 'Escape') { if (!panel.hidden) togglePanel(false); timeMenu.hidden = true; }
  };
  document.addEventListener('keydown', onKey);

  // ---- polling: status every 500 ms, the explorer while open, the scenario list now and then -----------------------------------
  const refreshScenarios = async () => {
    const s = await rpc('terrarium_scenarios').catch(() => null); if (!s) return;
    const k = JSON.stringify(s); if (k === scenariosKey) return; scenariosKey = k;
    const many = s.scenarios.length > 1;
    scenarioSelect.hidden = !many;
    const name = brand.querySelector<HTMLElement>('[data-testid=scenario-name]')!;
    name.hidden = many || !s.active || /^Scenario \d+$/.test(s.active); name.textContent = s.active ?? '';
    if (many) {
      scenarioSelect.replaceChildren(...s.scenarios.map((sc: any) => { const o = document.createElement('option'); o.value = sc.name; o.textContent = sc.name; if (sc.description) o.title = sc.description; o.selected = sc.name === s.active; return o; }));
      const active = s.scenarios.find((sc: any) => sc.name === s.active); if (active?.description) scenarioSelect.title = `${active.description}\n\nSwitching stores the choice and reloads the page; each scenario keeps its own chain.`;
    }
  };
  const refresh = async () => {
    const s = await rpc('terrarium_status').catch(() => null); if (!s) return;
    me = s.accounts?.[0] ?? me; head = parseInt(s.block, 16); actorsLabel = s.actorsLabel ?? actorsLabel;
    status.querySelector('[data-f=chain]')!.textContent = String(s.chainId);
    status.querySelector('[data-f=block]')!.textContent = String(head);
    if (s.now) {
      const chainNow = Number(BigInt(s.now)), drift = chainNow - Math.floor(Date.now() / 1000);
      const clock = status.querySelector<HTMLElement>('[data-f=clock]')!;
      clock.innerHTML = Math.abs(drift) > 90 ? `clock ${esc(new Date(chainNow * 1000).toLocaleString())} <span class="shift">${esc(span(drift))}</span>` : `clock ${esc(new Date(chainNow * 1000).toLocaleTimeString())}`;
    }
    const notes: string[] = [];
    if (s.fork) notes.push(`fork @${s.fork.blockNumber}${s.fork.offline ? ' offline' : ''}${s.fork.misses ? ` · <span class="warn">${s.fork.misses} MISSES</span>` : ''}`);
    if (s.http?.routes) notes.push(`${s.http.routes} HTTP route${s.http.routes === 1 ? '' : 's'}, ${s.http.hits} answered`);
    if (s.restoredFromPersistence) notes.push(`${s.localBlocks} block${s.localBlocks === 1 ? '' : 's'} restored`);
    status.querySelector('[data-f=engine]')!.innerHTML = notes.map((n) => `<span>${n}</span>`).join('');
    status.title = `revm/wasm · the chain persists in IndexedDB${s.restoredFromPersistence ? ' (Reset to start clean)' : ''}`;
    if (s.txs) { const bad = s.txs.failed ? `<span class="badge bad" title="${s.txs.failed} failed">${s.txs.failed} ✗</span>` : ''; const pend = s.txs.pending ? `<span class="badge" title="${s.txs.pending} pending">${s.txs.pending} ⏳</span>` : ''; bTxs.innerHTML = `Transactions<span class="badge">${s.txs.total}</span>${pend}${bad}`; }
    const ck = JSON.stringify(s.controls ?? []);
    if (ck !== controlsKey) { controlsKey = ck; controls.replaceChildren(...(s.controls ?? []).map((c: any, i: number) => btn(c.label, `control-${i}`, c.title ?? c.method, async () => { const r = await rpc(c.method, c.params ?? []); toast(`${c.label}${r !== undefined && r !== null && typeof r !== 'object' ? ` → ${r}` : ''}`); }))); }
    bActors.hidden = !s.hasActors; bActors.textContent = `${s.actorsLabel} ${s.actors ? 'on' : 'off'}`; bActors.classList.toggle('on', s.actors);
    gScenario.hidden = !s.hasActors && !(s.controls?.length);
    bReject.textContent = s.wallet.rejectNext > 0 ? `Reject next tx · armed (${s.wallet.rejectNext})` : 'Reject next tx'; bReject.classList.toggle('armed', s.wallet.rejectNext > 0);
    bLatency.textContent = s.wallet.latencyMs ? `Wallet: ${s.wallet.latencyMs / 1000}s delay` : 'Wallet: instant'; bLatency.classList.toggle('on', !!s.wallet.latencyMs);
    bLag.textContent = s.wallet.receiptLagMs ? `Receipts: ${s.wallet.receiptLagMs / 1000}s late` : 'Receipts: instant'; bLag.classList.toggle('on', !!s.wallet.receiptLagMs);
    if (!bar.hidden) place();
    if (!panel.hidden) await refreshTxs();
  };
  refresh(); refreshScenarios();
  let ticks = 0;
  const timer = setInterval(() => { if (!document.getElementById('terrarium-devbar')) return clearInterval(timer); refresh(); if (++ticks % 10 === 0) refreshScenarios(); }, 500);
}

/** Remove the dev bar, its explorer, the toasts and the show pill; restore the page's bottom padding. Idempotent. */
export function unmountDevBar() {
  document.getElementById('terrarium-devbar')?.remove();
  document.getElementById('terrarium-devbar-show')?.remove();
  document.getElementById('terrarium-toast')?.remove();
  document.getElementById('terrarium-devbar-menu')?.remove();
  document.body?.style.removeProperty('padding-bottom');
}
