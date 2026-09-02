import { useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';
import { useWallets, type WalletDetail } from './lib/wallet';
import { usePond, type PoolAddresses } from './lib/usePond';
import { Chart } from './components/Chart';
import { VaultStats } from './components/VaultStats';
import { Activity } from './components/Activity';
import { Panel } from './components/Panel';
import { WalletButton } from './components/WalletButton';

export function App({ addresses }: { addresses: PoolAddresses }) {
  const wallets = useWallets();
  const [wallet, setWallet] = useState<WalletDetail | null>(null);
  const [accounts, setAccounts] = useState<Address[]>([]);
  const [account, setAccount] = useState<Address | null>(null);
  // reads: VITE_RPC_URL if configured, else the connected wallet, else the first wallet found (eth_call needs no permission)
  const readProvider = wallet?.provider ?? wallets[0]?.provider ?? null;
  const walletCtx = useMemo(() => (wallet && account ? { provider: wallet.provider, account } : null), [wallet, account]);
  const pond = usePond(readProvider, walletCtx, addresses);

  useEffect(() => {
    if (!wallet) return;
    const onAccounts = (a: Address[]) => { setAccounts(a); setAccount(a[0] ?? null); };
    wallet.provider.on('accountsChanged', onAccounts as any);
    return () => { wallet.provider.removeListener('accountsChanged', onAccounts as any); };
  }, [wallet]);

  const connect = async (w: WalletDetail) => {
    const a = (await w.provider.request({ method: 'eth_requestAccounts' })) as Address[];
    setWallet(w); setAccounts(a); setAccount(a[0] ?? null);
  };

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <img src="/frog.svg" alt="" width={28} height={28} />
          <div><h1>Frogpond</h1><p>ETH / PEPE on Uniswap V2</p></div>
        </div>
        <div className="chainline" data-testid="chain">
          {pond.block ? <><span className="dot-live" /> chain {pond.chainId} · block #{pond.block.number.toString()} · {new Date(Number(pond.block.timestamp) * 1000).toLocaleTimeString()}</>
            : pond.poolError ? <span className="warn">{pond.poolError}</span> : readProvider ? 'connecting to the chain…' : 'no wallet or RPC found to read the chain'}
        </div>
        <WalletButton connected={wallet} accounts={accounts} account={account} onConnect={connect} onSelect={setAccount} onDisconnect={() => { setWallet(null); setAccounts([]); setAccount(null); }} />
      </header>

      <main className="grid">
        <section className="pond">
          <Chart points={pond.prices} />
          <VaultStats stats={pond.stats} connected={!!account} />
          <Activity rows={pond.activity} />
        </section>
        <Panel stats={pond.stats} tx={pond.tx} actions={pond.actions} connected={!!account} />
      </main>
    </div>
  );
}
