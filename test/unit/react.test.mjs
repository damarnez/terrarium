// terrarium-react: the component is inert outside a browser (SSR renders only its children, never creates a Worker), and
// the inject entry it relies on can start and stop cleanly (StrictMode mounts twice).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Terrarium, DevBar, useTerrarium } from 'terrarium-react';

test('SSR: renders children only, does not touch a Worker, useTerrarium is null', () => {
  let created = 0;
  const Probe = () => createElement('i', null, String(useTerrarium()));
  const html = renderToString(createElement(Terrarium, { worker: () => { created++; return {}; } }, createElement('b', null, 'app'), createElement(Probe)));
  assert.equal(html, '<b>app</b><i>null</i>');
  assert.equal(created, 0, 'no Worker during SSR');
  assert.equal(renderToString(createElement(DevBar, { provider: null })), '');
});

test('inject: startTerrarium announces once per instance, stopTerrarium undoes it (a second start replaces the first)', async () => {
  const { startTerrarium, stopTerrarium } = await import('terrarium/inject');
  const listeners = new Map(), dispatched = [];
  const body = { style: { paddingBottom: '', removeProperty(k) { this[k] = ''; } }, append() {}, appended: [] };
  globalThis.window = { addEventListener: (ev, fn) => listeners.set(fn, ev), removeEventListener: (ev, fn) => listeners.delete(fn), dispatchEvent: (e) => dispatched.push(e.type) };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  globalThis.document = { body, getElementById: () => null, createElement: () => ({ style: {}, dataset: {}, append() {}, querySelector: () => ({}), remove() {} }), addEventListener() {} };
  try {
    const workers = [{ terminated: 0, onmessage: null, postMessage() {}, terminate() { this.terminated++; } }, { terminated: 0, onmessage: null, postMessage() {}, terminate() { this.terminated++; } }];
    const p1 = startTerrarium(workers[0], { devBar: false });
    assert.equal(typeof p1.request, 'function'); assert.equal(listeners.size, 1); assert.deepEqual(dispatched, ['eip6963:announceProvider']); assert.ok(globalThis.window.terrarium);
    startTerrarium(workers[1], { devBar: false });
    assert.equal(workers[0].terminated, 1, 'starting again stops the previous instance'); assert.equal(listeners.size, 1);
    stopTerrarium();
    assert.equal(workers[1].terminated, 1); assert.equal(listeners.size, 0); assert.equal(globalThis.window.terrarium, undefined);
    stopTerrarium();   // idempotent
  } finally { delete globalThis.window; delete globalThis.document; delete globalThis.CustomEvent; }
});
