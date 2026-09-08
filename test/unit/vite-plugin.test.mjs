// The Vite plugin: generated entry files, the injected script tag, the VITE_TERRARIUM=off switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { terrarium, workerEntry, reactMountEntry, REACT_MOUNT_ID } from '@terrariumlabs/core/vite';

const config = (root, mode = 'development') => ({ root, mode, envDir: root, logger: { info() {} } });

test('enabled: writes .terrarium/{inject,worker}.ts and injects one module script into index.html', () => {
  const root = mkdtempSync(join(tmpdir(), 'terrarium-plugin-'));
  const plugin = terrarium();
  assert.equal(plugin.name, 'terrarium');
  plugin.configResolved(config(root));
  assert.match(readFileSync(join(root, '.terrarium/worker.ts'), 'utf8'), /import scenario from '\/terrarium\.scenario\.ts';\s*import \{ runScenario \} from '@terrariumlabs\/core\/worker';\s*runScenario\(scenario\);/);
  assert.match(readFileSync(join(root, '.terrarium/inject.ts'), 'utf8'), /startTerrarium\(new Worker\(new URL\('\.\/worker\.ts', import\.meta\.url\), \{ type: 'module' \}\)\)/);
  const out = plugin.transformIndexHtml.handler('<html><body></body></html>');
  assert.deepEqual(out.tags, [{ tag: 'script', attrs: { type: 'module', src: '/.terrarium/inject.ts' }, injectTo: 'body' }]);
  assert.equal(plugin.transformIndexHtml.order, 'pre');
});

test('a custom scenario path is resolved relative to the root', () => {
  const root = mkdtempSync(join(tmpdir(), 'terrarium-plugin-'));
  const plugin = terrarium({ scenario: 'scenarios/other.scenario.ts' });
  plugin.configResolved(config(root));
  assert.match(readFileSync(join(root, '.terrarium/worker.ts'), 'utf8'), /from '\/scenarios\/other\.scenario\.ts'/);
  assert.equal(workerEntry('/x.ts'), "import scenario from '/x.ts';\nimport { runScenario } from '@terrariumlabs/core/worker';\nrunScenario(scenario);\n");
});

test('VITE_TERRARIUM=off in an env file disables everything: no files, html untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'terrarium-plugin-'));
  writeFileSync(join(root, '.env'), 'VITE_TERRARIUM=off\n');
  const plugin = terrarium();
  plugin.configResolved(config(root));
  assert.equal(existsSync(join(root, '.terrarium')), false);
  assert.equal(plugin.transformIndexHtml.handler('<html/>'), '<html/>');
});

test("mount: 'react' generates the React mount, serves it as virtual:terrarium/react and injects no script", () => {
  const root = mkdtempSync(join(tmpdir(), 'terrarium-plugin-'));
  const plugin = terrarium({ mount: 'react', devBar: 'hidden' });
  plugin.configResolved(config(root));
  assert.equal(plugin.transformIndexHtml.handler('<html/>'), '<html/>', 'the app mounts it from its tree instead');
  assert.equal(existsSync(join(root, '.terrarium/inject.ts')), false);
  const mount = plugin.resolveId(REACT_MOUNT_ID);
  assert.equal(mount, join(root, '.terrarium/react.tsx'));
  const src = readFileSync(mount, 'utf8');
  assert.match(src, /import \{ Terrarium \} from '@terrariumlabs\/react'/);
  assert.match(src, /new Worker\(new URL\('\.\/worker\.ts', import\.meta\.url\), \{ type: 'module' \}\), defer: true, devBar: "hidden"/);
  assert.match(src, /export const enabled = true/);
  assert.equal(plugin.resolveId('something-else'), null);
  assert.equal(reactMountEntry(undefined).includes('devBar'), false, 'no option, no prop');
});

test("mount: 'react' with VITE_TERRARIUM=off: the virtual module exports null and nothing is generated", () => {
  const root = mkdtempSync(join(tmpdir(), 'terrarium-plugin-'));
  writeFileSync(join(root, '.env'), 'VITE_TERRARIUM=off\n');
  const plugin = terrarium({ mount: 'react' });
  plugin.configResolved(config(root));
  assert.equal(existsSync(join(root, '.terrarium')), false);
  const id = plugin.resolveId(REACT_MOUNT_ID);
  assert.equal(plugin.load(id), 'export const enabled = false;\nexport default null;\n');
  assert.equal(plugin.load('other'), null);
});
