// bridge.ts — postMessage RPC between the page (an EIP-1193 facade) and the Worker where the chain actually runs.
// Only JSON-RPC shaped data crosses: method names, hex strings, plain objects. Errors keep their `code` and `data`,
// so viem decodes reverts (code 3 + data) and rejections (4001) exactly as it would from a real wallet.
import { BaseError } from 'viem';

export type RpcArgs = { method: string; params?: unknown[] };
type Req = { id: number; method: string; params: unknown[] };
type Res = { id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } };
type Evt = { event: string; payload: unknown };

/** Extends viem's BaseError so viem treats it like an error from its own transports (no "unknown error" retries). */
export class ProviderRpcError extends BaseError {
  code: number; data: unknown;
  constructor(code: number, message: string, data?: unknown) { super(message, { name: 'ProviderRpcError', details: message }); this.code = code; this.data = data; }
}

/** Worker side: answer requests with the sim's provider and forward its events to the page. */
export function serveProvider(target: { request(a: RpcArgs): Promise<unknown>; on(ev: string, fn: (p: unknown) => void): unknown }) {
  const scope: any = globalThis;
  scope.onmessage = async (e: MessageEvent<Req>) => {
    const { id, method, params } = e.data;
    try { scope.postMessage({ id, result: await target.request({ method, params }) } satisfies Res); }
    catch (err: any) { scope.postMessage({ id, error: { code: err?.code ?? -32603, message: String(err?.message ?? err), data: err?.data } } satisfies Res); }
  };
  for (const ev of ['message', 'accountsChanged', 'chainChanged', 'disconnect']) target.on(ev, (payload) => scope.postMessage({ event: ev, payload } satisfies Evt));
  scope.postMessage({ event: 'ready', payload: null } satisfies Evt);
}

/** Page side: an EIP-1193 provider whose chain lives in a Worker. Requests made before the Worker is ready are queued. */
export function createWorkerProvider(worker: Worker) {
  let nextId = 1, ready = false;
  const pending = new Map<number, { res: (v: unknown) => void; rej: (e: unknown) => void }>();
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const queue: (() => void)[] = [];
  worker.onmessage = (e: MessageEvent<Res | Evt>) => {
    if ('event' in e.data) {
      const evt = e.data;
      if (evt.event === 'ready') { ready = true; queue.splice(0).forEach((f) => f()); return; }
      if (evt.event === 'error') { console.error('[terrarium] worker failed:', evt.payload); return; }
      listeners.get(evt.event)?.forEach((fn) => fn(evt.payload)); return;
    }
    const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id);
    if (e.data.error) p.rej(new ProviderRpcError(e.data.error.code, e.data.error.message, e.data.error.data)); else p.res(e.data.result);
  };
  const send = (method: string, params: unknown[]) => new Promise<unknown>((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); worker.postMessage({ id, method, params } satisfies Req); });
  const provider = {
    request: ({ method, params = [] }: RpcArgs) => (ready ? send(method, params) : new Promise<unknown>((res, rej) => queue.push(() => send(method, params).then(res, rej)))),
    on(ev: string, fn: (p: unknown) => void) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev)!.add(fn); return provider; },
    removeListener(ev: string, fn: (p: unknown) => void) { listeners.get(ev)?.delete(fn); return provider; },
  };
  return provider;
}
export type WorkerProvider = ReturnType<typeof createWorkerProvider>;
