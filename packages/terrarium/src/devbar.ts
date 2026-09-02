// devbar.ts — the dev overlay. Plain DOM, own styles, talks to the chain only through provider.request(), so it works
// on top of any dapp (React or not) and never touches the dapp's code.
type Provider = { request(a: { method: string; params?: unknown[] }): Promise<any> };

const CSS = `
#terrarium-devbar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 24px; background: #14231b; color: #dfe9e3; font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; font-variant-numeric: tabular-nums; }
#terrarium-devbar .tag { background: #e8c547; color: #14231b; font-weight: 700; padding: 2px 8px; border-radius: 6px; }
#terrarium-devbar .muted { color: rgba(223, 233, 227, 0.7); }
#terrarium-devbar .muted b { color: #fff; font-weight: 600; }
#terrarium-devbar .spacer { flex: 1; }
#terrarium-devbar button { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14); color: #fff; padding: 6px 10px; border-radius: 8px; font: inherit; cursor: pointer; }
#terrarium-devbar button:hover { background: rgba(255,255,255,0.16); }
#terrarium-devbar button.on { background: #1f6f5c; border-color: #1f6f5c; }
#terrarium-devbar button.armed { background: #7a3b2a; border-color: #b3452c; }
#terrarium-devbar button.danger { border-color: rgba(255,140,110,0.4); color: #ffb5a0; }
`;

export function mountDevBar(provider: Provider) {
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

  const controls = el('<span class="controls" style="display:contents"></span>'); let controlsKey = '';
  bar.append(el('<span class="tag">Terrarium</span>'), info, el('<span class="spacer"></span>'), controls,
    btn('Mine a block', 'mine', 'Mine one empty block', () => rpc('evm_mine')),
    btn('+1 hour', 'plus-hour', 'Move the chain clock forward one hour', async () => { await rpc('evm_increaseTime', [3600]); await rpc('evm_mine'); }),
    bMining, bSnap, bActors, bReject, bLatency, bLag, bReset);
  document.body.append(bar);
  document.body.style.paddingBottom = '64px';

  const refresh = async () => {
    const s = await rpc('terrarium_status').catch(() => null); if (!s) return;
    info.querySelector('[data-f=chain]')!.textContent = String(s.chainId);
    info.querySelector('[data-f=block]')!.textContent = String(parseInt(s.block, 16));
    info.querySelector('[data-f=engine]')!.textContent = (s.engine === 'revm' ? 'revm/wasm' : 'ethereumjs') + (s.fork ? ` · fork @${s.fork.blockNumber}${s.fork.offline ? ' offline' : ''}${s.fork.misses ? ` · ${s.fork.misses} MISSES` : ''}` : '')
      + (s.restoredFromPersistence ? ` · ${s.localBlocks} local block${s.localBlocks === 1 ? '' : 's'} restored from a previous session (Reset to start clean)` : '');
    const ck = JSON.stringify(s.controls ?? []);
    if (ck !== controlsKey) { controlsKey = ck; controls.replaceChildren(...(s.controls ?? []).map((c: any, i: number) => btn(c.label, `control-${i}`, c.title ?? c.method, () => rpc(c.method, c.params ?? [])))); }
    bActors.hidden = !s.hasActors; bActors.textContent = `${s.actorsLabel} ${s.actors ? 'on' : 'off'}`; bActors.classList.toggle('on', s.actors);
    bReject.textContent = s.wallet.rejectNext > 0 ? `Reject next tx · armed (${s.wallet.rejectNext})` : 'Reject next tx'; bReject.classList.toggle('armed', s.wallet.rejectNext > 0);
    bLatency.textContent = s.wallet.latencyMs ? `Wallet: ${s.wallet.latencyMs / 1000}s delay` : 'Wallet: instant'; bLatency.classList.toggle('on', !!s.wallet.latencyMs);
    bLag.textContent = s.wallet.receiptLagMs ? `Receipts: ${s.wallet.receiptLagMs / 1000}s late` : 'Receipts: instant'; bLag.classList.toggle('on', !!s.wallet.receiptLagMs);
  };
  refresh(); setInterval(refresh, 500);
}
