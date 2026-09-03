// The dapp's off-chain data source: the Uniswap V2 subgraph, configured by VITE_SUBGRAPH_URL like it would be on mainnet.
// Plain fetch + GraphQL, re-queried on every new block and every few seconds. Nothing here knows what answers.
import { useEffect, useState } from 'react';
import type { Address } from 'viem';

const SUBGRAPH = import.meta.env.VITE_SUBGRAPH_URL;
const QUERY = `query PondIndexer($pair: String!) {
  pair(id: $pair) { txCount reserve0 reserve1 volumeToken0 volumeToken1 }
  swaps(first: 5, orderBy: timestamp, orderDirection: desc, where: { pair: $pair }) {
    id timestamp amount0In amount1In amount0Out amount1Out to transaction { id blockNumber }
  }
}`;

export interface IndexedPair { txCount: string; reserve0: string; reserve1: string; volumeToken0: string; volumeToken1: string }
export interface IndexedSwap { id: string; timestamp: string; amount0In: string; amount1In: string; amount0Out: string; amount1Out: string; to: Address; transaction: { id: string; blockNumber: string } }
export interface IndexerState {
  /** false when no VITE_SUBGRAPH_URL is configured: the UI hides the panel */
  configured: boolean;
  pair: IndexedPair | null;
  swaps: IndexedSwap[];
  /** the newest block the indexer has seen (from the swaps it returned); compare with the chain head to detect lag */
  indexedBlock: number | null;
  error: string | null;
}

export function useIndexer(pair: Address | null, head: bigint | null): IndexerState {
  const [state, setState] = useState<IndexerState>({ configured: !!SUBGRAPH, pair: null, swaps: [], indexedBlock: null, error: null });
  useEffect(() => {
    if (!SUBGRAPH || !pair) return;
    const ctrl = new AbortController();
    const load = async () => {
      try {
        const res = await fetch(SUBGRAPH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: QUERY, variables: { pair: pair.toLowerCase() } }), signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { data, errors } = (await res.json()) as { data?: { pair: IndexedPair | null; swaps: IndexedSwap[] }; errors?: { message: string }[] };
        if (errors?.length) throw new Error(errors.map((e) => e.message).join('; '));
        const swaps = data?.swaps ?? [];
        setState({ configured: true, pair: data?.pair ?? null, swaps, indexedBlock: swaps.length ? Math.max(...swaps.map((s) => Number(s.transaction.blockNumber))) : null, error: null });
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { ctrl.abort(); clearInterval(timer); };
  }, [pair, head]);   // a new head: ask the indexer again
  return state;
}
