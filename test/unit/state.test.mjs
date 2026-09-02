// Fabricating state: deal on any ERC20, setState by variable name, slotFromLayout, installing code at an address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concat, keccak256, pad, parseEther, stringToHex, toHex } from 'viem';
import { boot, deployPepe, PEPE, rejects } from './helpers.mjs';
import { FixedPriceFeed } from '../../examples/aave/src/generated/contracts.ts';

const feedAbi = FixedPriceFeed.abi;

test('deal: sets any holder\'s balance, adjusts totalSupply by the difference, remembers the slot', async () => {
  const t = await boot();
  const pepe = await deployPepe(t);
  const read = (fn, args = []) => t.pub.readContract({ address: pepe, abi: PEPE.abi, functionName: fn, args });
  const alice = t.accounts[1];
  const slot = await t.sim.deal(pepe, alice, 1000n);
  assert.equal(slot, t.sim.slotFromLayout(PEPE.storageLayout, ['balanceOf', alice]));
  assert.equal(await read('balanceOf', [alice]), 1000n);
  assert.equal(await read('totalSupply'), parseEther('1000000') + 1000n);
  await t.sim.deal(pepe, alice, 400n);                                   // second time: cached slot, supply follows the delta
  assert.equal(await read('balanceOf', [alice]), 400n);
  assert.equal(await read('totalSupply'), parseEther('1000000') + 400n);
  await t.sim.deal(pepe, t.accounts[2], 7n, { adjustTotalSupply: false });
  assert.equal(await read('totalSupply'), parseEther('1000000') + 400n);
  assert.ok(t.sim.journal.some((e) => e.method === 'sim_deal'), 'deal goes through the RPC layer and is journaled');
  // the dealt tokens are real: a transfer works and emits
  const hash = await t.wallet(alice).writeContract({ address: pepe, abi: PEPE.abi, functionName: 'transfer', args: [t.accounts[3], 400n] });
  assert.equal((await t.pub.waitForTransactionReceipt({ hash })).status, 'success');
});

test('deal on an address without a stored balance explains itself', async () => {
  const t = await boot();
  await rejects(t.sim.deal(t.accounts[5], t.accounts[1], 1n), (e) => assert.match(e.message, /reverted while probing|no direct storage slot/));
});

test('setState writes scalars and nested mappings by name; slotFromLayout matches hand computation', async () => {
  const t = await boot();
  const pepe = await deployPepe(t);
  const read = (fn, args = []) => t.pub.readContract({ address: pepe, abi: PEPE.abi, functionName: fn, args });
  const [alice, bob] = [t.accounts[1], t.accounts[2]];
  const written = await t.sim.setState(pepe, PEPE.storageLayout, { totalSupply: 5n, balanceOf: { [alice]: 7, [bob]: '0x9' }, allowance: { [alice]: { [bob]: 11n } } });
  assert.equal(written.length, 4);
  assert.equal(await read('totalSupply'), 5n); assert.equal(await read('balanceOf', [alice]), 7n); assert.equal(await read('balanceOf', [bob]), 9n); assert.equal(await read('allowance', [alice, bob]), 11n);
  const layout = PEPE.storageLayout;
  const slotOf = (label) => BigInt(layout.storage.find((x) => x.label === label).slot);
  assert.equal(t.sim.slotFromLayout(layout, ['totalSupply']), pad(toHex(slotOf('totalSupply')), { size: 32 }));
  assert.equal(t.sim.slotFromLayout(layout, ['balanceOf', alice]), keccak256(concat([pad(alice, { size: 32 }), pad(toHex(slotOf('balanceOf')), { size: 32 })])));
  const inner = keccak256(concat([pad(alice, { size: 32 }), pad(toHex(slotOf('allowance')), { size: 32 })]));
  assert.equal(t.sim.slotFromLayout(layout, ['allowance', alice, bob]), keccak256(concat([pad(bob, { size: 32 }), inner])));
  assert.throws(() => t.sim.slotFromLayout(layout, ['nope']), /unknown variable/);
  assert.throws(() => t.sim.slotFromLayout(layout, ['totalSupply', 1]), /cannot index/);
});

test('slotFromLayout: dynamic arrays, string keys and packed variables', () => {
  const layout = { storage: [
    { label: 'arr', slot: '3', offset: 0, type: 't_array(t_uint256)dyn_storage' },
    { label: 'byName', slot: '4', offset: 0, type: 't_mapping(t_string_memory_ptr,t_uint256)' },
    { label: 'small', slot: '5', offset: 1, type: 't_uint8' },
  ], types: {
    't_array(t_uint256)dyn_storage': { encoding: 'dynamic_array', base: 't_uint256', numberOfBytes: '32', label: 'uint256[]' },
    't_uint256': { encoding: 'inplace', numberOfBytes: '32', label: 'uint256' },
    't_uint8': { encoding: 'inplace', numberOfBytes: '1', label: 'uint8' },
    't_mapping(t_string_memory_ptr,t_uint256)': { encoding: 'mapping', key: 't_string_memory_ptr', value: 't_uint256', label: 'mapping(string => uint256)' },
  } };
  const { slotFromLayout } = { slotFromLayout: null };
  return boot().then((t) => {
    assert.equal(BigInt(t.sim.slotFromLayout(layout, ['arr', 2])), BigInt(keccak256(pad('0x3', { size: 32 }))) + 2n);
    assert.equal(t.sim.slotFromLayout(layout, ['byName', 'bob']), keccak256(concat([stringToHex('bob'), pad('0x4', { size: 32 })])));
    assert.throws(() => t.sim.slotFromLayout(layout, ['small']), /packed/);
  });
});

test('install code at an address and set its variables: a fixed price feed where an oracle used to be', async () => {
  const t = await boot();
  const oracle = '0x00000000000000000000000000000000000000F0';
  await t.rpc('anvil_setCode', [oracle, FixedPriceFeed.deployedBytecode]);
  await t.sim.setState(oracle, FixedPriceFeed.storageLayout, { answer: 1234_00000000n, decimals: 8, roundId: 3 });
  const read = (fn) => t.pub.readContract({ address: oracle, abi: feedAbi, functionName: fn });
  assert.equal(await read('latestAnswer'), 1234_00000000n);
  assert.equal(await read('decimals'), 8);
  const [roundId, answer] = await read('latestRoundData');
  assert.equal(roundId, 3n); assert.equal(answer, 1234_00000000n);
  assert.equal(await read('description'), 'Terrarium fixed price feed');
});
