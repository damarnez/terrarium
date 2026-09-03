import type { IndexerState } from '../lib/useIndexer';
import { short } from '../lib/format';

const dec = (s: string, digits = 3) => Number(s).toLocaleString(undefined, { maximumFractionDigits: digits });

/** What the indexer says about the pond, next to what the chain says: a frontend must survive the two disagreeing. */
export function Indexer({ state, head, tokenIsToken0 }: { state: IndexerState; head: bigint | null; tokenIsToken0: boolean }) {
  if (!state.configured) return null;
  const ethOf = (s: { amount0In: string; amount1In: string; amount0Out: string; amount1Out: string }) => (tokenIsToken0 ? [s.amount1In, s.amount1Out] : [s.amount0In, s.amount0Out]);
  const lag = state.indexedBlock !== null && head !== null && Number(head) - state.indexedBlock > 1 ? Number(head) - state.indexedBlock : 0;
  return (
    <section className="activity indexer" aria-label="From the indexer" data-testid="indexer" data-swaps={state.swaps.length} data-block={state.indexedBlock ?? ''}>
      <h2>From the indexer <span className="muted">(subgraph)</span></h2>
      {state.error ? <p className="warn" data-testid="indexer-error">Indexer unavailable: {state.error}. Showing on-chain data only.</p> : null}
      {state.pair ? (
        <p className="muted" data-testid="indexer-count">
          {state.pair.txCount} swaps indexed · volume {dec(tokenIsToken0 ? state.pair.volumeToken1 : state.pair.volumeToken0)} ETH
          {lag ? <span className="warn" data-testid="indexer-lag"> · indexer is {lag} blocks behind the chain</span> : null}
        </p>
      ) : null}
      {state.swaps.length > 0 ? (
        <ul>
          {state.swaps.map((s) => { const [ethIn, ethOut] = ethOf(s); const bought = Number(ethIn) > 0; return (
            <li key={s.id} className="row swap">
              <span className="who" title={s.to}>{short(s.to)}</span>
              <span className="what">{bought ? `bought PEPE for ${dec(ethIn)} ETH` : `sold PEPE for ${dec(ethOut)} ETH`}</span>
              <span className="when" title={s.transaction.id}>#{s.transaction.blockNumber}</span>
            </li>
          ); })}
        </ul>
      ) : null}
    </section>
  );
}
