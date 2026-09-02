import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Address } from 'viem';
import { App } from './App';
import './styles.css';

// An ordinary dapp: it is configured with a chain id, two contract addresses and (optionally) a read RPC — see .env.
// Which wallet it talks to is decided by EIP-6963 discovery at runtime. Nothing here knows whether that wallet is
// MetaMask on mainnet or the Terrarium's simulated chain injected into the page.
const addresses = { router: import.meta.env.VITE_ROUTER_ADDRESS as Address, token: import.meta.env.VITE_TOKEN_ADDRESS as Address };
const root = createRoot(document.getElementById('root')!);
if (!addresses.router || !addresses.token) root.render(<p style={{ padding: 24 }}>Set VITE_ROUTER_ADDRESS and VITE_TOKEN_ADDRESS (see .env).</p>);
else root.render(<StrictMode><App addresses={addresses} /></StrictMode>);
