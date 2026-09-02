import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Address } from 'viem';
import { App } from './App';
import './styles.css';

// An ordinary Aave frontend: configured with a chain id and addresses (.env), talking to whatever wallet announces itself.
const config = { pool: import.meta.env.VITE_AAVE_POOL as Address, weth: import.meta.env.VITE_WETH as Address, usdc: import.meta.env.VITE_USDC as Address, chainId: Number(import.meta.env.VITE_CHAIN_ID ?? 1) };
createRoot(document.getElementById('root')!).render(<StrictMode><App config={config} /></StrictMode>);
