import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Address } from 'viem';
import { App } from './App';
import './styles.css';

const config = { evc: import.meta.env.VITE_EULER_EVC as Address, collateralVault: import.meta.env.VITE_EULER_COLLATERAL_VAULT as Address, borrowVault: import.meta.env.VITE_EULER_BORROW_VAULT as Address, weth: import.meta.env.VITE_WETH as Address, usdc: import.meta.env.VITE_USDC as Address, chainId: Number(import.meta.env.VITE_CHAIN_ID ?? 1) };
createRoot(document.getElementById('root')!).render(<StrictMode><App config={config} /></StrictMode>);
