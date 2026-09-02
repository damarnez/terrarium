import { useState } from 'react';
import type { Address } from 'viem';
import { useWallets, type WalletDetail } from '../lib/wallet';
import { short } from '../lib/format';

export function WalletButton({ connected, accounts, account, onConnect, onSelect, onDisconnect }: {
  connected: WalletDetail | null; accounts: Address[]; account: Address | null;
  onConnect: (w: WalletDetail) => void; onSelect: (a: Address) => void; onDisconnect: () => void;
}) {
  const wallets = useWallets();
  const [open, setOpen] = useState(false);
  if (!connected) {
    return (
      <div className="wallet">
        <button className="btn primary" onClick={() => setOpen((o) => !o)} data-testid="connect">Connect wallet</button>
        {open && (
          <div className="menu" role="menu">
            {wallets.length === 0 && <p className="muted">No wallet found in this browser.</p>}
            {wallets.map((w) => <button key={w.info.uuid} role="menuitem" onClick={() => { onConnect(w); setOpen(false); }} data-testid={`wallet-${w.info.rdns}`}><img src={w.info.icon} alt="" width={20} height={20} /> {w.info.name}</button>)}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="wallet">
      <button className="btn" onClick={() => setOpen((o) => !o)} data-testid="account"><img src={connected.info.icon} alt="" width={18} height={18} /> {account ? short(account) : connected.info.name}</button>
      {open && (
        <div className="menu" role="menu">
          <p className="muted">{connected.info.name}{accounts.length > 1 ? ' · pick an account' : ''}</p>
          {accounts.map((a, i) => <button key={a} role="menuitem" className={a === account ? 'active' : ''} onClick={() => { onSelect(a); setOpen(false); }}>Account {i + 1} <small>{short(a)}</small></button>)}
          <button role="menuitem" onClick={() => { onDisconnect(); setOpen(false); }}>Disconnect</button>
        </div>
      )}
    </div>
  );
}
