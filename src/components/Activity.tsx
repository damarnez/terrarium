import type { Activity as Row } from '../lib/usePond';
import { short } from '../lib/format';

export function Activity({ rows }: { rows: Row[] }) {
  return (
    <section className="activity" aria-label="Recent activity">
      <h2>Activity</h2>
      {rows.length === 0 ? <p className="muted">No swaps yet. Be the first frog in the pond.</p> : (
        <ul data-testid="activity">
          {rows.map((r) => (
            <li key={r.id} className={`row ${r.kind} ${r.you ? 'you' : ''}`}>
              <span className="who" title={r.who}>{r.you ? 'You' : short(r.who)}</span>
              <span className="what">{r.text}</span>
              <span className="when" title={r.tx}>#{r.block}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
