// devbar.ts — the dev overlay. Plain DOM, own styles, talks to the chain only through provider.request(), so it works
// on top of any dapp (React or not) and never touches the dapp's code. Two parts: the bar (controls) and the transaction
// explorer, a panel above it listing every transaction with its receipt, decoded call, events and revert reason
// (`terrarium_transactions`: the scenario runtime decodes with the scenario's `abis` and names addresses with `labels`).
type Provider = { request(a: { method: string; params?: unknown[] }): Promise<any> };

const HIDDEN_KEY = 'terrarium:devbar-hidden';
const CSS = `
#terrarium-devbar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 24px; background: #14231b; color: #dfe9e3; font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; font-variant-numeric: tabular-nums; }
#terrarium-devbar[hidden], #terrarium-explorer[hidden], #terrarium-devbar-show[hidden] { display: none; }
#terrarium-devbar .tag { background: #e8c547; color: #14231b; font-weight: 700; padding: 2px 8px; border-radius: 6px; }
#terrarium-devbar .muted { color: rgba(223, 233, 227, 0.7); }
#terrarium-devbar .muted b { color: #fff; font-weight: 600; }
#terrarium-devbar .spacer { flex: 1; }
#terrarium-devbar button { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14); color: #fff; padding: 6px 10px; border-radius: 8px; font: inherit; cursor: pointer; }
#terrarium-devbar button:hover { background: rgba(255,255,255,0.16); }
#terrarium-devbar button.on { background: #1f6f5c; border-color: #1f6f5c; }
#terrarium-devbar button.armed { background: #7a3b2a; border-color: #b3452c; }
#terrarium-devbar button.danger { border-color: rgba(255,140,110,0.4); color: #ffb5a0; }
#terrarium-devbar button.quiet { background: transparent; border-color: transparent; color: rgba(223,233,227,0.7); }
#terrarium-devbar-show { position: fixed; right: 12px; bottom: 12px; z-index: 2147483000; width: 36px; height: 36px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.2); background: #14231b; color: #e8c547; font: 16px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.35); }
#terrarium-explorer { position: fixed; left: 0; right: 0; z-index: 2147483000; max-height: 60vh; overflow: auto; background: #0f1a14; color: #dfe9e3; border-top: 1px solid rgba(255,255,255,0.12); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
#terrarium-explorer .head { display: flex; align-items: center; gap: 12px; padding: 8px 24px; font: 13px ui-sans-serif, system-ui, sans-serif; color: rgba(223,233,227,0.8); position: sticky; top: 0; background: #0f1a14; border-bottom: 1px solid rgba(255,255,255,0.08); }
#terrarium-explorer .head b { color: #fff; }
#terrarium-explorer .head select { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14); color: #fff; padding: 3px 6px; border-radius: 6px; font: inherit; }
#terrarium-explorer table { width: 100%; border-collapse: collapse; }
#terrarium-explorer th { text-align: left; font-weight: 600; color: rgba(223,233,227,0.6); padding: 6px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); white-space: nowrap; }
#terrarium-explorer th:first-child, #terrarium-explorer td:first-child { padding-left: 24px; }
#terrarium-explorer td { padding: 6px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); white-space: nowrap; vertical-align: top; }
#terrarium-explorer tr.tx { cursor: pointer; }
#terrarium-explorer tr.tx:hover td { background: rgba(255,255,255,0.04); }
#terrarium-explorer tr.tx.open td { background: rgba(255,255,255,0.06); border-bottom-color: transparent; }
#terrarium-explorer .ok { color: #7fd3a8; } #terrarium-explorer .bad { color: #ff9c80; } #terrarium-explorer .wait { color: #e8c547; }
#terrarium-explorer .hash, #terrarium-explorer .addr { color: #9ecbff; }
#terrarium-explorer .name { color: #e8c547; }
#terrarium-explorer .dim { color: rgba(223,233,227,0.55); }
#terrarium-explorer .detail td { padding: 10px 24px 14px 48px; white-space: normal; background: rgba(0,0,0,0.25); }
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

export interface DevBarOptions {
  /** start collapsed to the leaf (default false). A Hide/Show click is remembered in localStorage and overrides this */
  hidden?: boolean;
}

export function mountDevBar(provider: Provider, opts: DevBarOptions = {}) {
  if (document.getElementById('terrarium-devbar')) return;
  const rpc = (method: string, params: unknown[] = []) => provider.request({ method, params });
  const bar = document.createElement('footer');
  bar.id = 'terrarium-devbar'; bar.dataset.testid = 'devbar';
  const style = document.createElement('style'); style.textContent = CSS;
  bar.append(style);
  const el = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
  const btn = (label: string, testid: string, title: string, onClick: () => Promise<unknown> | void) => { const b = el(`<button data-testid="${testid}" title="${title}">${label}</button>`); b.onclick = () => Promise.resolve(onClick()).catch((e) => console.warn('[terrarium]', e)); return b; };

  const info = el(`<span class="muted">simulated chain <span data-f="chain">…</span> · block <b data-testid="block" data-f="block">…</b> · <span data-f="engine">…</span> · state persists in IndexedDB</span>`);
  let mining: 'auto' | 'interval' = 'auto', snap: string | null = null;
  const bMining = btn('Blocks: instant', 'mining', 'Auto: a block per transaction. Interval: a block every 3s, so you can watch pending states', async () => {
    mining = mining === 'auto' ? 'interval' : 'auto';
    await (mining === 'auto' ? rpc('evm_setAutomine', [true]) : rpc('evm_setIntervalMining', [3000]));
    bMining.textContent = mining === 'auto' ? 'Blocks: instant' : 'Blocks: every 3s';
  });
  const bSnap = btn('Snapshot', 'snapshot', 'Snapshot the chain; revert brings blocks, receipts, journal and the UI history back', async () => {
    if (snap) { await rpc('evm_revert', [snap]); snap = null; bSnap.textContent = 'Snapshot'; }
    else { snap = await rpc('evm_snapshot'); bSnap.textContent = 'Revert to snapshot'; }
  });
  const bActors = btn('Actors off', 'actors', 'Scripted actors: other users, keepers, arbitrageurs trading on their own', () => rpc('terrarium_actors'));
  const bReject = btn('Reject next tx', 'reject-next', 'The wallet rejects the next signature request (EIP-1193 error 4001), like a user hitting Cancel', () => rpc('terrarium_setWallet', [{ rejectNext: 1 }]));
  const bLatency = btn('Wallet: instant', 'wallet-latency', 'Make the wallet take 2 seconds to answer, like a real one', async () => { const w = await rpc('terrarium_getWallet'); await rpc('terrarium_setWallet', [{ latencyMs: w.latencyMs ? 0 : 2000 }]); });
  const bLag = btn('Receipts: instant', 'receipt-lag', 'Receipts appear 3 seconds after the block, like a node that has not caught up', async () => { const w = await rpc('terrarium_getWallet'); await rpc('terrarium_setWallet', [{ receiptLagMs: w.receiptLagMs ? 0 : 3000 }]); });
  const bReset = btn('Reset pond', 'reset', 'Wipe the chain and redeploy everything', async () => { await rpc('terrarium_reset'); location.reload(); });
  bReset.classList.add('danger');

  // ---- the transaction explorer -----------------------------------------------------------------------------------
  const panel = el(`<section id="terrarium-explorer" data-testid="explorer" hidden></section>`);
  const open = new Set<string>();   // expanded rows, by hash, kept across refreshes
  let lastRender = '', filter: 'all' | 'mine' | 'failed' = 'all', me: string | null = null;   // `me`: accounts[0] from terrarium_status
  const bTxs = btn('Transactions', 'txs', 'Every transaction on this chain, like a block explorer: receipt, decoded call, events, revert reason', async () => {
    panel.hidden = !panel.hidden; bTxs.classList.toggle('on', !panel.hidden); lastRender = '';
    if (!panel.hidden) await refreshTxs();
  });
  const place = () => { panel.style.bottom = `${bar.offsetHeight}px`; };
  const statusCell = (s: string) => s === 'success' ? '<span class="ok" title="success">✓</span>' : s === 'pending' ? '<span class="wait" title="pending">⏳</span>' : `<span class="bad" title="${s}">✗</span>`;
  const who = (labels: Record<string, string>, a: string | null) => a ? `<span class="addr" title="${a}">${esc(labels[a.toLowerCase()] ?? short(a))}</span>` : '<span class="dim">contract creation</span>';
  const render = (data: { total: number; labels: Record<string, string>; transactions: any[] }) => {
    const key = JSON.stringify([data.total, data.transactions.map((t) => [t.hash, t.status]), [...open], filter, me]);
    if (key === lastRender) return; lastRender = key;
    const L = data.labels ?? {};
    const shown = data.transactions.filter((t) => filter === 'all' ? true : filter === 'failed' ? t.status !== 'success' && t.status !== 'pending' : !!me && t.from?.toLowerCase() === me.toLowerCase());
    const rows = shown.map((t) => {
      const method = t.method ? (t.method.name ? `<span class="name">${esc(t.method.name)}</span>` : `<span class="dim">${esc(t.method.selector)}</span>`) : '<span class="dim">transfer</span>';
      const isOpen = open.has(t.hash);
      const detail = !isOpen ? '' : `<tr class="detail" data-testid="tx-detail"><td colspan="10"><dl>
        <dt>hash</dt><dd class="hash">${esc(t.hash)}</dd>
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
        <td class="hash" title="${t.hash}">${short(t.hash)}</td><td>${method}</td><td>${who(L, t.from)}</td><td>${who(L, t.to)}</td>
        <td>${formatEth(t.value)} ETH</td><td class="dim">${t.receipt ? num(t.receipt.gasUsed) : ''}</td><td class="dim">${t.logs?.length ? `${t.logs.length} event${t.logs.length === 1 ? '' : 's'}` : ''}</td></tr>${detail}`;
    }).join('');
    panel.innerHTML = `<div class="head"><b>Transactions</b> <span>${data.total} on this chain, newest first${data.total > data.transactions.length ? ` (showing ${data.transactions.length})` : ''}${filter !== 'all' ? `, ${shown.length} ${filter === 'mine' ? 'from you' : 'failed'}` : ''}</span>
      <select data-testid="tx-filter" title="Which transactions to list"><option value="all"${filter === 'all' ? ' selected' : ''}>all</option><option value="mine"${filter === 'mine' ? ' selected' : ''}>mine (account #0)</option><option value="failed"${filter === 'failed' ? ' selected' : ''}>failed</option></select>
      <span class="spacer" style="flex:1"></span><span class="dim">click a row for the receipt, the decoded call and the events</span></div>`
      + (rows ? `<table><thead><tr><th></th><th>block</th><th>time</th><th>hash</th><th>method</th><th>from</th><th>to</th><th>value</th><th>gas used</th><th>events</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">${data.total ? 'Nothing matches this filter.' : 'No transactions yet. Do something in the dapp and it appears here.'}</div>`);
    place();
  };
  panel.addEventListener('change', (e) => { const sel = e.target as HTMLSelectElement; if (sel.dataset.testid === 'tx-filter') { filter = sel.value as typeof filter; lastRender = ''; refreshTxs(); } });
  panel.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('tr.tx'); if (!row) return;
    const h = row.dataset.hash!; open.has(h) ? open.delete(h) : open.add(h); lastRender = ''; refreshTxs();
  });
  const refreshTxs = async () => { const data = await rpc('terrarium_transactions', [{ limit: 200 }]).catch(() => null); if (data) render(data); };

  // ---- hide / show --------------------------------------------------------------------------------------------------
  const pill = el(`<button id="terrarium-devbar-show" data-testid="show" title="Show the Terrarium dev bar" hidden>🌱</button>`);
  const remember = (hidden: boolean) => { try { localStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0'); } catch {} };
  const setHidden = (hidden: boolean) => {
    bar.hidden = hidden; pill.hidden = !hidden;
    if (hidden) { panel.hidden = true; bTxs.classList.remove('on'); }
    document.body.style.paddingBottom = hidden ? '' : '64px';
    remember(hidden);
  };
  const bHide = btn('Hide', 'hide', 'Hide the dev bar (the chain keeps running); the leaf at the bottom right brings it back', () => setHidden(true));
  bHide.classList.add('quiet');
  pill.onclick = () => setHidden(false);

  const controls = el('<span class="controls" style="display:contents"></span>'); let controlsKey = '';
  bar.append(el('<span class="tag">Terrarium</span>'), info, el('<span class="spacer"></span>'), controls,
    btn('Mine a block', 'mine', 'Mine one empty block', () => rpc('evm_mine')),
    btn('+1 hour', 'plus-hour', 'Move the chain clock forward one hour', async () => { await rpc('evm_increaseTime', [3600]); await rpc('evm_mine'); }),
    bMining, bSnap, bActors, bReject, bLatency, bLag, bTxs, bReset, bHide, panel);
  document.body.append(bar, pill);
  let startHidden = !!opts.hidden; try { const v = localStorage.getItem(HIDDEN_KEY); if (v !== null) startHidden = v === '1'; } catch {}
  bar.hidden = startHidden; pill.hidden = !startHidden; document.body.style.paddingBottom = startHidden ? '' : '64px';   // apply without remembering: the default is not a choice

  const refresh = async () => {
    if (!document.getElementById('terrarium-devbar')) return;   // unmounted: stop polling
    const s = await rpc('terrarium_status').catch(() => null); if (!s) return;
    me = s.accounts?.[0] ?? me;
    info.querySelector('[data-f=chain]')!.textContent = String(s.chainId);
    info.querySelector('[data-f=block]')!.textContent = String(parseInt(s.block, 16));
    info.querySelector('[data-f=engine]')!.textContent = 'revm/wasm' + (s.fork ? ` · fork @${s.fork.blockNumber}${s.fork.offline ? ' offline' : ''}${s.fork.misses ? ` · ${s.fork.misses} MISSES` : ''}` : '')
      + (s.http?.routes ? ` · ${s.http.routes} HTTP route${s.http.routes === 1 ? '' : 's'}, ${s.http.hits} answered` : '')
      + (s.restoredFromPersistence ? ` · ${s.localBlocks} local block${s.localBlocks === 1 ? '' : 's'} restored from a previous session (Reset to start clean)` : '');
    const ck = JSON.stringify(s.controls ?? []);
    if (ck !== controlsKey) { controlsKey = ck; controls.replaceChildren(...(s.controls ?? []).map((c: any, i: number) => btn(c.label, `control-${i}`, c.title ?? c.method, () => rpc(c.method, c.params ?? [])))); }
    bActors.hidden = !s.hasActors; bActors.textContent = `${s.actorsLabel} ${s.actors ? 'on' : 'off'}`; bActors.classList.toggle('on', s.actors);
    bReject.textContent = s.wallet.rejectNext > 0 ? `Reject next tx · armed (${s.wallet.rejectNext})` : 'Reject next tx'; bReject.classList.toggle('armed', s.wallet.rejectNext > 0);
    bLatency.textContent = s.wallet.latencyMs ? `Wallet: ${s.wallet.latencyMs / 1000}s delay` : 'Wallet: instant'; bLatency.classList.toggle('on', !!s.wallet.latencyMs);
    bLag.textContent = s.wallet.receiptLagMs ? `Receipts: ${s.wallet.receiptLagMs / 1000}s late` : 'Receipts: instant'; bLag.classList.toggle('on', !!s.wallet.receiptLagMs);
    if (!panel.hidden) await refreshTxs();
  };
  refresh(); const timer = setInterval(() => { if (document.getElementById('terrarium-devbar')) refresh(); else clearInterval(timer); }, 500);
}

/** Remove the dev bar, its explorer and the show pill; restore the page's bottom padding. Idempotent. */
export function unmountDevBar() {
  document.getElementById('terrarium-devbar')?.remove();
  document.getElementById('terrarium-devbar-show')?.remove();
  document.body?.style.removeProperty('padding-bottom');
}
