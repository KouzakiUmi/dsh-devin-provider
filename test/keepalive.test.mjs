import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PB, frame } from '../src/pb.mjs';
import {
  keepaliveKey,
  keepaliveSettings,
  keeping,
  scheduleKeepalive,
  stopAllKeepalive,
  stopKeepalive,
  useTimers
} from '../src/keepalive.mjs';

function okConnectStream(cacheRead, cacheWrite) {
  const usagePb = new PB().varint(2, 100).varint(3, 1).varint(4, cacheWrite).varint(5, cacheRead).done();
  const msgPb = new PB().bytes(7, usagePb).done();
  const f = frame(msgPb);
  return new Response(
    new ReadableStream({
      start(ctl) {
        ctl.enqueue(f);
        ctl.close();
      }
    }),
    { status: 200 }
  );
}

test('keepaliveSettings validates bounds and uses CLI defaults', () => {
  assert.deepEqual(keepaliveSettings(), { enabled: false, interval: 285_000, max: 6 });
  assert.deepEqual(keepaliveSettings({ enabled: true, intervalSec: 120, maxPings: 10 }), {
    enabled: true,
    interval: 120_000,
    max: 10
  });
  assert.deepEqual(keepaliveSettings({ enabled: true, intervalSec: 10, maxPings: 99 }), {
    enabled: true,
    interval: 285_000,
    max: 6
  });
});

test('keepaliveKey distinguishes sessions and falls back to growing prefix when sessionId is absent', () => {
  const k1 = keepaliveKey({ systemPrompt: 'sys', tools: [{ name: 'Read' }] }, { sessionId: 's1' });
  const k2 = keepaliveKey({ systemPrompt: 'sys', tools: [{ name: 'Read' }] }, { sessionId: 's2' });
  assert.notEqual(k1, k2);

  const a1 = keepaliveKey({ systemPrompt: 'sys', messages: [{ role: 'user', content: 'hello' }] });
  const a2 = keepaliveKey({ systemPrompt: 'sys', messages: [{ role: 'user', content: 'hello world' }] });
  assert.equal(a1, a2);
});

test('scheduleKeepalive pings on interval, stops after 2 cache misses or max pings', async () => {
  let fakeNow = 1_000_000;
  const scheduled = [];
  useTimers({
    now: () => fakeNow,
    set: (fn, ms) => {
      const h = { fn, ms, cleared: false };
      scheduled.push(h);
      return h;
    },
    clear: (h) => {
      if (h) h.cleared = true;
    }
  });

  try {
    let calls = 0;
    const mockFetch = async () => {
      calls++;
      if (calls === 1) return okConnectStream(500, 0); // hit
      return okConnectStream(10, 0); // miss (< 50%)
    };
    const pingBytes = new PB().str(21, 'swe-2-high').done();
    scheduleKeepalive({ id: 'conv-1', interval: 285_000, max: 6 }, 'key', 'https://example.test', pingBytes, fakeNow, mockFetch);
    assert.deepEqual(keeping(), ['conv-1']);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, 285_000);

    // Run ping 1 (cache hit)
    fakeNow += 285_000;
    await scheduled[0].fn();
    assert.equal(calls, 1);
    assert.equal(scheduled.length, 2);

    // Run ping 2 (miss 1)
    fakeNow += 285_000;
    await scheduled[1].fn();
    assert.equal(calls, 2);
    assert.equal(scheduled.length, 3);

    // Run ping 3 (miss 2 -> stops)
    fakeNow += 285_000;
    await scheduled[2].fn();
    assert.equal(calls, 3);
    assert.deepEqual(keeping(), []);

    // Stop on 401
    scheduleKeepalive({ id: 'conv-2', interval: 60_000, max: 6 }, 'key', 'https://example.test', pingBytes, fakeNow, async () => new Response('unauthenticated', { status: 401 }));
    await scheduled.at(-1).fn();
    assert.deepEqual(keeping(), []);
    stopKeepalive('conv-2');
    stopAllKeepalive();
  } finally {
    useTimers(null);
  }
});
