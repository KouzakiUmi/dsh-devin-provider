import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const CORE_PEERS = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-typert-protocol'
];
const CORE_RANGE = '>=0.2.1-rc.4 <0.3.0 || >=0.2.2-rc.1 <0.3.0';
const PI_AI_RANGE = '>=1.1.0 <2.0.0';

function parse(version) {
  const [core, pre] = String(version).split('-');
  return { tuple: core.split('.').map(Number), pre: pre ?? null };
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a.tuple[i] !== b.tuple[i]) return a.tuple[i] < b.tuple[i] ? -1 : 1;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

function comparator(raw) {
  const match = /^(>=|<=|>|<|=)?(.+)$/.exec(raw);
  return { op: match[1] || '=', version: parse(match[2]) };
}

function satisfies(version, range, { includePrerelease = false } = {}) {
  const candidate = parse(version);
  return range.split('||').some((clause) => {
    const parts = clause.trim().split(/\s+/).map(comparator);
    if (
      !includePrerelease &&
      candidate.pre !== null &&
      !parts.some((part) => part.version.pre !== null && part.version.tuple.every((n, i) => n === candidate.tuple[i]))
    ) {
      return false;
    }
    return parts.every((part) => {
      const cmp = compare(candidate, part.version);
      switch (part.op) {
        case '>=': return cmp >= 0;
        case '>': return cmp > 0;
        case '<': return cmp < 0;
        case '<=': return cmp <= 0;
        default: return cmp === 0;
      }
    });
  });
}

test('DSH Core peerDependencies cover verified host versions including 0.2.2-rc.3', () => {
  assert.equal(manifest.engines?.dsh, CORE_RANGE);
  for (const name of CORE_PEERS) {
    assert.equal(manifest.peerDependencies[name], CORE_RANGE, name);
  }
  for (const version of ['0.2.1-rc.4', '0.2.1', '0.2.2-rc.1', '0.2.2-rc.3', '0.2.2']) {
    for (const opts of [{}, { includePrerelease: true }]) {
      assert.ok(satisfies(version, CORE_RANGE, opts), `${version} ${JSON.stringify(opts)}`);
    }
  }
  assert.ok(!satisfies('0.2.0', CORE_RANGE));
  assert.ok(!satisfies('0.3.0', CORE_RANGE));
});

test('cordis, schemastery, and pi-ai peerDependencies match current DSH runtime', () => {
  assert.equal(manifest.peerDependencies['@earendil-works/pi-ai'], PI_AI_RANGE);
  assert.ok(satisfies('1.1.0', PI_AI_RANGE));
  assert.ok(satisfies('1.4.0', PI_AI_RANGE));
  assert.ok(satisfies('1.5.0', PI_AI_RANGE));
  assert.ok(!satisfies('2.0.0', PI_AI_RANGE));
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '^4.0.5');
  assert.equal(manifest.peerDependencies['@deepseek-ai/schemastery'], '^3.18.4');
});

test('manifest version is a plain release version (no prerelease suffix)', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});
