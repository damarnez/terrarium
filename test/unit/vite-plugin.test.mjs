// The Vite plugin: generated entry files, the injected script tag, the VITE_TERRARIUM=off switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { terrarium, workerEntry } from 'terrarium/vite';

const config = (root, mode = 'development') => ({ root, mode, envDir: root, logger: { info() {} } });

test('enabled: writes .terrarium/{inject,worker}.ts and injects one module script into index.html', () => {
  const root = mkdtempSync(join(tmpdir(), 'terrarium-plugin-'));
  const plugin = terrarium();
  assert.equal(plugin.name, 'terrarium');
  plugin.configResolved(config(root));
  assert.match(readFileSync(join(root, '.terrarium/worker.ts'), 'utf8'), /import scenario from '\/terrarium\.scenario\.ts';\s*import \{ runScenario \} from 'terrarium\/worker';\s*runScenario\(scenario\);/);
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
  assert.equal(workerEntry('/x.ts'), "import scenario from '/x.ts';\nimport { runScenario } from 'terrarium/worker';\nrunScenario(scenario);\n");
});

test('VITE_TERRARIUM=off in an env file disables everything: no files, html untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'terrarium-plugin-'));
  writeFileSync(join(root, '.env'), 'VITE_TERRARIUM=off\n');
  const plugin = terrarium();
  plugin.configResolved(config(root));
  assert.equal(existsSync(join(root, '.terrarium')), false);
  assert.equal(plugin.transformIndexHtml.handler('<html/>'), '<html/>');
});
