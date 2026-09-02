// All chain access of the dapp: viem + EIP-1193 providers, nothing else. The pool is a real Uniswap V2 pair reached
// through Router02; the dapp is configured with a chain id, the router address and the token address (see .env).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, custom, decodeErrorResult, defineChain, formatEther, http, parseEventLogs, zeroAddress, type Address, type EIP1193Provider, type Hex } from 'viem';
import { PEPE } from '../generated/contracts';
import { factoryAbi, pairAbi, routerAbi } from './uniswap';
import { gweiPerPepe } from './format';

export interface PoolAddresses { router: Address; token: Address }
export interface PoolInfo { weth: Address; factory: Address; pair: Address; tokenIsToken0: boolean }
export interface PricePoint { i: number; block: number; tx: Hex; gwei: number; reserveETH: bigint; reserveToken: bigint; kind: 'swap' | 'mint' | 'burn' | 'open' }
export interface Activity { id: string; block: number; tx: Hex; kind: 'swap' | 'mint' | 'burn'; who: Address; text: string; you: boolean }
export interface PondStats { reserveETH: bigint; reserveToken: bigint; totalShares: bigint; feesETH: bigint; feesToken: bigint; swapCount: bigint; yourShares: bigint; ethBalance: bigint; pepeBalance: bigint; allowance: bigint; lpAllowance: bigint }
export type TxState = { status: 'idle' } | { status: 'pending'; label: string } | { status: 'confirmed'; label: string; hash: Hex; block: bigint } | { status: 'failed'; label: string; error: string };
export interface WalletCtx { provider: EIP1193Provider; account: Address }

const env = import.meta.env;
export const chain = defineChain({ id: Number(env.VITE_CHAIN_ID ?? 31337), name: 'Frogpond chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: env.VITE_RPC_URL ? [env.VITE_RPC_URL] : [] } } });

/** Every error this dapp can surface: PEPE's custom errors, plus Error(string) reasons from the Uniswap contracts.
 *  viem only decodes against the ABI of the contract that was called, so a token revert bubbling through the router
 *  needs the token's ABI too. */
const REVERT_ABI = [...PEPE.abi, ...routerAbi, ...pairAbi].filter((x): x is Extract<typeof x, { type: 'error' }> => x.type === 'error');
const decodeRevert = (raw: Hex | undefined) => { if (!raw || raw === '0x') return undefined; try { return decodeErrorResult({ abi: REVERT_ABI, data: raw }); } catch { return undefined; } };

/** Turn any viem error into the message a user should read: the revert reason, or the custom error with named args. */
export function explain(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (revert) {
      if (revert.reason && revert.reason !== 'execution reverted') return revert.reason;
      const decoded = revert.data ?? decodeRevert(revert.raw);
      if (decoded) {
        if (decoded.errorName === 'Error') return String(decoded.args?.[0] ?? 'reverted');
        const inputs = decoded.abiItem && 'inputs' in decoded.abiItem ? decoded.abiItem.inputs : [];
        return `${decoded.errorName}(${(decoded.args ?? []).map((a, i) => (inputs[i]?.name ? `${inputs[i].name}: ${String(a)}` : String(a))).join(', ')})`;
      }
    }
    if (/rejected/i.test(e.shortMessage) || e.walk((err: any) => err?.code === 4001)) return 'You rejected the request in your wallet';
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

const zeroVolume = () => ({ ethIn: 0n, tokenIn: 0n, swaps: 0 });

export function usePond(readProvider: EIP1193Provider | null, wallet: WalletCtx | null, addresses: PoolAddresses) {
  // reads: a configured RPC if there is one, else the provider we were handed (eth_call needs no permission)
  const pub = useMemo(() => { const transport = env.VITE_RPC_URL ? http(env.VITE_RPC_URL) : readProvider ? custom(readProvider) : null; return transport ? createPublicClient({ chain, transport, pollingInterval: 400 }) : null; }, [readProvider]);
  const walletClient = useMemo(() => (wallet ? createWalletClient({ chain, transport: custom(wallet.provider), account: wallet.account }) : null), [wallet]);
  const account = wallet?.account ?? null;

  const [chainId, setChainId] = useState<number | null>(null);
  const [pool, setPool] = useState<PoolInfo | null>(null);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [block, setBlock] = useState<{ number: bigint; timestamp: bigint } | null>(null);
  const [stats, setStats] = useState<PondStats | null>(null);
  const [prices, setPrices] = useState<PricePoint[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [tx, setTx] = useState<TxState>({ status: 'idle' });
  const seen = useRef(new Set<string>());
  const volume = useRef(zeroVolume());   // Uniswap keeps no fee stats; we derive them from the Swap events we have seen
  const statsRef = useRef<PondStats | null>(null);
  const head = useRef<{ number: bigint; hash: Hex } | null>(null);   // the newest block we know of, from ANY source (poll, receipts)

  // discover the pool from the two configured addresses (WETH and the factory come from the router, the pair from the factory)
  useEffect(() => {
    if (!pub) return; let stop = false;
    (async () => {
      const [weth, factory] = await Promise.all([pub.readContract({ address: addresses.router, abi: routerAbi, functionName: 'WETH' }), pub.readContract({ address: addresses.router, abi: routerAbi, functionName: 'factory' })]);
      const pair = await pub.readContract({ address: factory, abi: factoryAbi, functionName: 'getPair', args: [addresses.token, weth] });
      if (stop) return;
      if (pair === zeroAddress) { setPoolError('No pool exists yet for this token'); return; }
      setPool({ weth, factory, pair, tokenIsToken0: addresses.token.toLowerCase() < weth.toLowerCase() }); setPoolError(null);
    })().catch((e) => !stop && setPoolError(`Cannot read the pool: ${explain(e)}`));
    return () => { stop = true; };
  }, [pub, addresses]);

  const split = useCallback((a0: bigint, a1: bigint) => (pool?.tokenIsToken0 ? { token: a0, eth: a1 } : { token: a1, eth: a0 }), [pool]);

  const refresh = useCallback(async () => {
    if (!pub || !pool) return;
    const me = account ?? zeroAddress;
    const [b, reserves, totalShares, yourShares, ethBalance, pepeBalance, allowance, lpAllowance] = await Promise.all([
      pub.getBlock(),
      pub.readContract({ address: pool.pair, abi: pairAbi, functionName: 'getReserves' }),
      pub.readContract({ address: pool.pair, abi: pairAbi, functionName: 'totalSupply' }),
      pub.readContract({ address: pool.pair, abi: pairAbi, functionName: 'balanceOf', args: [me] }),
      account ? pub.getBalance({ address: account }) : Promise.resolve(0n),
      pub.readContract({ address: addresses.token, abi: PEPE.abi, functionName: 'balanceOf', args: [me] }),
      pub.readContract({ address: addresses.token, abi: PEPE.abi, functionName: 'allowance', args: [me, addresses.router] }),
      pub.readContract({ address: pool.pair, abi: pairAbi, functionName: 'allowance', args: [me, addresses.router] }),
    ]);
    const r = split(reserves[0], reserves[1]);
    const v = volume.current;
    const next: PondStats = { reserveETH: r.eth, reserveToken: r.token, totalShares, feesETH: (v.ethIn * 3n) / 1000n, feesToken: (v.tokenIn * 3n) / 1000n, swapCount: BigInt(v.swaps), yourShares, ethBalance, pepeBalance, allowance, lpAllowance };
    statsRef.current = next;
    setBlock({ number: b.number!, timestamp: b.timestamp }); setStats(next);
  }, [pub, pool, account, addresses, split]);

  /** A PEPE -> ETH swap's `to` is the router itself (it unwraps the WETH for you); the human is the tx sender. */
  const resolveSenders = useCallback(async (logs: any[]) => {
    const hashes = [...new Set(logs.filter((l) => l.eventName === 'Swap' && l.args.to.toLowerCase() === addresses.router.toLowerCase()).map((l) => l.transactionHash as Hex))];
    return new Map(await Promise.all(hashes.map(async (h) => [h, (await pub!.getTransaction({ hash: h })).from] as const)));
  }, [pub, addresses]);

  // history: every Sync is a price point, every Swap/Mint/Burn an activity row
  const ingestSync = useCallback((logs: any[], senders: Map<Hex, Address>) => {
    if (!pool) return;
    const isMe = (a: Address) => !!account && a.toLowerCase() === account.toLowerCase();
    const lpMintedTo = new Map<string, Address>(); // Mint has no `to`; the LP recipient is in the same tx's Transfer from 0x0
    for (const l of logs) if (l.eventName === 'Transfer' && l.args.from === zeroAddress && l.args.to !== zeroAddress) lpMintedTo.set(l.transactionHash, l.args.to);
    const pts: PricePoint[] = [], acts: Activity[] = [];
    for (const l of logs) {
      const id = `${l.transactionHash}:${l.logIndex}`;
      if (seen.current.has(id)) continue; seen.current.add(id);
      const blk = Number(l.blockNumber), txh = l.transactionHash as Hex;
      if (l.eventName === 'Sync') { const r = split(l.args.reserve0, l.args.reserve1); pts.push({ i: 0, block: blk, tx: txh, gwei: gweiPerPepe(r.eth, r.token), reserveETH: r.eth, reserveToken: r.token, kind: 'swap' }); }
      if (l.eventName === 'Swap') {
        const inn = split(l.args.amount0In, l.args.amount1In), out = split(l.args.amount0Out, l.args.amount1Out), buy = inn.eth > 0n;
        volume.current.swaps++; volume.current.ethIn += inn.eth; volume.current.tokenIn += inn.token;
        const who: Address = senders.get(txh) ?? l.args.to;
        acts.push({ id, block: blk, tx: txh, kind: 'swap', who, you: isMe(who), text: buy ? `swapped ${fmtE(inn.eth)} ETH for ${fmtP(out.token)} PEPE` : `swapped ${fmtP(inn.token)} PEPE for ${fmtE(out.eth)} ETH` });
      }
      if (l.eventName === 'Mint') { const a = split(l.args.amount0, l.args.amount1); const who = lpMintedTo.get(l.transactionHash) ?? l.args.sender; acts.push({ id, block: blk, tx: txh, kind: 'mint', who, you: isMe(who), text: `added ${fmtE(a.eth)} ETH + ${fmtP(a.token)} PEPE` }); }
      if (l.eventName === 'Burn') { const a = split(l.args.amount0, l.args.amount1); acts.push({ id, block: blk, tx: txh, kind: 'burn', who: l.args.to, you: isMe(l.args.to), text: `removed ${fmtE(a.eth)} ETH + ${fmtP(a.token)} PEPE` }); }
    }
    if (pts.length) setPrices((prev) => [...prev, ...pts.map((p) => ({ ...p, kind: (acts.find((a) => a.tx === p.tx)?.kind ?? (prev.length === 0 ? 'open' : 'swap')) as PricePoint['kind'] }))].map((p, i) => ({ ...p, i })));
    if (acts.length) setActivity((prev) => [...acts.reverse(), ...prev].slice(0, 60));
  }, [account, pool, split]);
  const ingest = useCallback(async (logs: any[]) => ingestSync(logs, await resolveSenders(logs)), [ingestSync, resolveSenders]);

  /** (Re)load the whole history — on start, and whenever the head moves backwards (snapshot revert, reorg). */
  const reload = useCallback(async () => {
    if (!pub || !pool) return;
    const logs = await pub.getContractEvents({ address: pool.pair, abi: pairAbi, fromBlock: 0n });
    const senders = await resolveSenders(logs);
    seen.current.clear(); volume.current = zeroVolume(); setPrices([]); setActivity([]);   // nothing async between the clear and the re-ingest
    ingestSync(logs, senders);
    await refresh();
  }, [pub, pool, ingestSync, resolveSenders, refresh]);

  useEffect(() => {
    if (!pub || !pool) return;
    let stop = false;
    (async () => { setChainId(await pub.getChainId()); if (!stop) await reload(); })().catch(() => {});
    const unwatchLogs = pub.watchContractEvent({ address: pool.pair, abi: pairAbi, onLogs: (logs) => { ingest(logs); refresh(); } });
    // our own head poll: viem's watchBlockNumber ignores a head that moves backwards, and we want to notice that
    // (snapshot revert, reorg). A lower number, or the same number with a different hash, means our history is stale.
    const timer = setInterval(async () => {
      const b = await pub.getBlock({ blockTag: 'latest' }).catch(() => null);
      if (!b || stop) return;
      const h = head.current, cur = { number: b.number!, hash: b.hash! };
      if (h && (cur.number < h.number || (cur.number === h.number && cur.hash !== h.hash))) { head.current = cur; await reload(); }
      else if (!h || cur.number > h.number) { head.current = cur; await refresh(); }
    }, 400);
    return () => { stop = true; unwatchLogs(); clearInterval(timer); };
  }, [pub, pool, ingest, refresh, reload]);

  const deadline = useCallback(async () => (await pub!.getBlock()).timestamp + 1200n, [pub]);

  /** Run a write end to end with status reporting: pending -> confirmed/failed, then refresh. */
  const run = useCallback(async (label: string, fn: () => Promise<Hex>) => {
    if (!pub) return;
    setTx({ status: 'pending', label });
    try {
      const hash = await fn();
      const r = await pub.waitForTransactionReceipt({ hash });
      if (!head.current || r.blockNumber > head.current.number) head.current = { number: r.blockNumber, hash: r.blockHash };
      if (r.status !== 'success') { const sent = await pub.getTransaction({ hash }).catch(() => null); throw new Error(sent && r.gasUsed >= sent.gas ? 'Transaction ran out of gas on-chain' : 'Transaction reverted on-chain'); }
      await ingest(parseEventLogs({ abi: pairAbi, logs: r.logs }));   // the receipt already carries the logs: chart + feed update instantly
      setTx({ status: 'confirmed', label, hash, block: r.blockNumber });
      await refresh();
    } catch (e) { setTx({ status: 'failed', label, error: explain(e) }); }
  }, [pub, refresh, ingest]);

  const actions = useMemo(() => {
    const w = walletClient!, me = account!, { router, token } = addresses;
    const pct = (x: bigint, bps: bigint) => (x * (10_000n - bps)) / 10_000n;
    return {
      approve: (amount: bigint) => run('Approve PEPE', () => w.writeContract({ address: token, abi: PEPE.abi, functionName: 'approve', args: [router, amount] })),
      approveLP: (amount: bigint) => run('Approve LP tokens', () => w.writeContract({ address: pool!.pair, abi: pairAbi, functionName: 'approve', args: [router, amount] })),
      addLiquidity: (eth: bigint, tokenAmt: bigint, slippageBps: bigint) => run('Add liquidity', async () => w.writeContract({ address: router, abi: routerAbi, functionName: 'addLiquidityETH', args: [token, tokenAmt, pct(tokenAmt, slippageBps), pct(eth, slippageBps), me, await deadline()], value: eth })),
      removeLiquidity: (shares: bigint, minETH: bigint, minToken: bigint) => run('Remove liquidity', async () => w.writeContract({ address: router, abi: routerAbi, functionName: 'removeLiquidityETH', args: [token, shares, minToken, minETH, me, await deadline()] })),
      swapETH: (eth: bigint, minOut: bigint) => run('Swap ETH for PEPE', async () => w.writeContract({ address: router, abi: routerAbi, functionName: 'swapExactETHForTokens', args: [minOut, [pool!.weth, token], me, await deadline()], value: eth })),
      swapPEPE: (tokenAmt: bigint, minOut: bigint) => run('Swap PEPE for ETH', async () => w.writeContract({ address: router, abi: routerAbi, functionName: 'swapExactTokensForETH', args: [tokenAmt, minOut, [token, pool!.weth], me, await deadline()] })),
      /** quotes go through the router's own pure functions, so they match the contract exactly */
      quoteToken: (eth: bigint) => { const s = statsRef.current!; return pub!.readContract({ address: router, abi: routerAbi, functionName: 'quote', args: [eth, s.reserveETH, s.reserveToken] }); },
      quoteETH: (tokenAmt: bigint) => { const s = statsRef.current!; return pub!.readContract({ address: router, abi: routerAbi, functionName: 'quote', args: [tokenAmt, s.reserveToken, s.reserveETH] }); },
      getAmountOut: (amountIn: bigint, reserveIn: bigint, reserveOut: bigint) => pub!.readContract({ address: router, abi: routerAbi, functionName: 'getAmountOut', args: [amountIn, reserveIn, reserveOut] }),
      dismiss: () => setTx({ status: 'idle' }),
    };
  }, [run, walletClient, account, addresses, pool, pub, deadline]);

  return { chainId, pool, poolError, block, stats, prices, activity, tx, actions, refresh, ready: !!pub && !!pool };
}

const fmtE = (w: bigint) => Number(formatEther(w)).toLocaleString('en-US', { maximumFractionDigits: 4 });
const fmtP = (w: bigint) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(Number(formatEther(w)));
