import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PB, dec, failure, fields, frame, frames, inID, outID } from '../src/pb.mjs';
import {
  buildFromPiContext,
  events,
  forgetSigTypes,
  forgetThoughts,
  geminiSchema,
  objectRoot,
  rememberSigType,
  sigTypeOf
} from '../src/devin-wire.mjs';

test('outID/inID escape unsafe tool IDs and roundtrip cleanly', () => {
  assert.equal(outID('call_123'), 'call_123');
  const escaped = outID('Bash:0#a65b6a5e');
  assert.match(escaped, /^dv_[A-Za-z0-9_-]+$/);
  assert.equal(inID(escaped), 'Bash:0#a65b6a5e');

  const dvPrefixed = outID('dv_existing');
  assert.notEqual(dvPrefixed, 'dv_existing');
  assert.equal(inID(dvPrefixed), 'dv_existing');
});

test('frame compresses payloads > 8 KiB with gzip and frames() decodes them', async () => {
  const bigText = 'x'.repeat(10_000);
  const msg = new PB().str(3, bigText).done();
  const framed = frame(msg);
  assert.equal(framed[0], 1); // gzip flag
  assert.ok(framed.length < msg.length);

  const rs = new ReadableStream({
    start(ctl) {
      ctl.enqueue(framed.subarray(0, 7));
      ctl.enqueue(framed.subarray(7));
      ctl.close();
    }
  });
  const out = [];
  for await (const f of frames(rs)) out.push(f);
  assert.equal(out.length, 1);
  assert.equal(out[0].end, false);
  const decodedFields = fields(out[0].data);
  assert.equal(dec.decode(decodedFields[0].data), bigText);
});

test('objectRoot folds allOf/anyOf/oneOf and $defs into plain object schema', () => {
  const folded = objectRoot({
    $defs: {
      Create: { type: 'object', properties: { name: { type: 'string' }, mode: { type: 'string' } }, required: ['name', 'mode'] },
      Update: { type: 'object', properties: { name: { type: 'string' }, id: { type: 'string' } }, required: ['name'] }
    },
    oneOf: [{ $ref: '#/$defs/Create' }, { $ref: '#/$defs/Update' }]
  });
  assert.equal(folded.type, 'object');
  assert.equal(folded.oneOf, undefined);
  assert.ok(folded.properties.name);
  assert.ok(folded.properties.id);
  assert.deepEqual(folded.required, ['name']);
});

test('geminiSchema converts nullable list types, empty arrays, and anyOf beside type', () => {
  const cleaned = geminiSchema({
    type: 'object',
    properties: {
      title: { type: ['string', 'null'] },
      tags: { type: 'array' },
      offset: { type: 'integer', anyOf: [{ type: 'integer' }, { type: 'null' }] }
    }
  });
  assert.equal(cleaned.properties.title.type, 'string');
  assert.equal(cleaned.properties.title.nullable, true);
  assert.deepEqual(cleaned.properties.tags.items, {});
  assert.equal(cleaned.properties.offset.anyOf, undefined);
  assert.equal(cleaned.properties.offset.nullable, true);
});

test('buildFromPiContext formats non-Claude as single merged USER prompt (system first) and Claude with cache marks', () => {
  forgetSigTypes();
  forgetThoughts();
  rememberSigType('sig_claude_1', 'anthropic');
  assert.equal(sigTypeOf('sig_claude_1'), 'anthropic');

  const ctx = {
    systemPrompt: 'x-anthropic-billing-header: cc_version=1; cch=abc;\nBe concise.',
    tools: [{ name: 'Read', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Inspect' }, { type: 'image', data: 'AQID', mimeType: 'image/png' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', thinkingSignature: 'sig_claude_1' },
          { type: 'toolCall', id: 'tc1', name: 'Read', arguments: { path: 'a.txt' } },
          { type: 'toolCall', id: 'tc2', name: 'Read', arguments: { path: 'b.txt' } }
        ]
      },
      { role: 'toolResult', toolCallId: 'tc1', isError: true, content: [{ type: 'text', text: 'ENOENT' }] },
      { role: 'user', content: 'Continue' }
    ]
  };

  // Claude keeps separate USER prompts with cache marks and signed thinking
  const claudeReq = buildFromPiContext({ maxTokens: 4096 }, ctx, {}, 'claude-opus-5-5-high', 'k');
  const promptDatas = fields(claudeReq.bytes).filter((f) => f.num === 3).map((f) => fields(f.data));
  const texts = promptDatas.map((fs) => {
    const f3 = fs.find((x) => x.num === 3);
    return f3 ? dec.decode(f3.data) : '';
  });
  assert.ok(texts.some((t) => t.includes('<tool_descriptions>') && t.includes('Read file')));
  assert.ok(texts.some((t) => t.includes('Be concise.') && !t.includes('x-anthropic-billing-header')));
  assert.ok(texts.some((t) => t === 'Error: ENOENT'));
  assert.ok(texts.some((t) => t.includes('Tool use was interrupted')));

  const assistantPrompt = promptDatas.find((fs) => fs.some((x) => x.num === 2 && x.n === 2));
  assert.equal(dec.decode(assistantPrompt.find((x) => x.num === 12).data), 'sig_claude_1');

  // Non-Claude (swe-2-flash) merges systemPrompt -> <tool_descriptions> -> user into first USER prompt without field 8 cache
  const sweReq = buildFromPiContext({ maxTokens: 4096 }, ctx, {}, 'swe-2-flash-max', 'k');
  const swePrompts = fields(sweReq.bytes).filter((f) => f.num === 3).map((f) => fields(f.data));
  const firstUser = swePrompts[0];
  const firstText = dec.decode(firstUser.find((x) => x.num === 3).data);
  const sysIdx = firstText.indexOf('Be concise.');
  const toolIdx = firstText.indexOf('<tool_descriptions>');
  const usrIdx = firstText.indexOf('Inspect');
  assert.ok(sysIdx >= 0 && toolIdx > sysIdx && usrIdx > toolIdx);
  assert.equal(swePrompts.some((fs) => fs.some((x) => x.num === 8)), false);

  const sweAssistant = swePrompts.find((fs) => fs.some((x) => x.num === 2 && x.n === 2));
  assert.equal(dec.decode(sweAssistant.find((x) => x.num === 11).data), 'hmm');
  assert.equal(sweAssistant.find((x) => x.num === 12), undefined);

  assert.equal(failure(200, JSON.stringify({ error: { code: 'unauthenticated', message: 'bad' } })).status, 401);
  assert.equal(failure(200, JSON.stringify({ error: { code: 'resource_exhausted', message: 'limit' } })).status, 429);
});

test('events() decodes text, reasoning, signature, tool calls, and Gemini thought cache', async () => {
  forgetThoughts();
  async function* gen() {
    yield { end: false, data: new PB().str(9, 'thought').str(10, 'sig_gem_1').str(21, 'gemini').done() };
    yield { end: false, data: new PB().str(3, 'ok').done() };
    yield { end: false, data: new PB().varint(5, 1).bytes(7, new PB().varint(2, 10).varint(3, 2).done()).done() };
  }
  const list = [];
  for await (const e of events(gen(), 'gemini-4-argon-high')) list.push(e);
  assert.equal(list[0].reasoning, 'thought');
  assert.equal(list[1].signature, 'sig_gem_1');
  assert.equal(list[2].signatureType, 'gemini');
  assert.equal(list[3].text, 'ok');
  assert.equal(list[4].stop, 'stop');
  assert.equal(list[4].tokens.input, 10);

  // Verify Gemini thought signature is replayed in field 12/18/22 on next turn
  const nextReq = buildFromPiContext(
    { maxTokens: 4096 },
    {
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: 'Next' }
      ]
    },
    {},
    'gemini-4-argon-high',
    'k'
  );
  const prompts = fields(nextReq.bytes).filter((f) => f.num === 3).map((f) => fields(f.data));
  const asst = prompts.find((fs) => fs.some((x) => x.num === 2 && x.n === 2));
  assert.equal(dec.decode(asst.find((x) => x.num === 12).data), 'sig_gem_1');
  assert.equal(dec.decode(asst.find((x) => x.num === 18).data), 'gemini');
  assert.equal(dec.decode(asst.find((x) => x.num === 22).data), 'gemini-4-argon-high');

  async function* emptyGen() {
    yield { end: false, data: new PB().varint(5, 1).done() };
  }
  const emptyList = [];
  for await (const e of events(emptyGen())) emptyList.push(e);
  assert.equal(emptyList[0].error.status, 502);
});

test('events() fallback parses leaked Harmony <|message_model|>...<|content_invoke_tool_json|>...<|end_message|> across chunks', async () => {
  const full =
    '<|message_model|>thought\nNeed docs.<|end_message|>' +
    'Checking now.<|message_model|>skill<|content_invoke_tool_json|>{"name":"skill","args":{"name":"dsh-doc"}}<|end_message|>';
  async function* gen() {
    // Split at awkward chunk boundaries including mid-tag
    for (let i = 0; i < full.length; i += 7) {
      yield { end: false, data: new PB().str(3, full.slice(i, i + 7)).done() };
    }
    yield { end: false, data: new PB().varint(5, 1).bytes(7, new PB().varint(2, 20).varint(3, 10).done()).done() };
  }
  const list = [];
  for await (const e of events(gen(), 'swe-2-flash-max', new Set(['skill', 'read']))) list.push(e);

  assert.equal(list.filter((e) => e.reasoning).map((e) => e.reasoning).join(''), 'Need docs.');
  assert.equal(list.filter((e) => e.text).map((e) => e.text).join(''), 'Checking now.');
  const toolEv = list.find((e) => e.tool);
  const argsEv = list.find((e) => e.args);
  assert.equal(toolEv?.tool?.name, 'skill');
  assert.equal(argsEv?.args?.text, '{"name":"dsh-doc"}');
  const stopEv = list.find((e) => e.stop);
  assert.equal(stopEv?.stop, 'tool_calls');
});

test('buildFromPiContext merges consecutive user messages and sanitizes leaked Harmony tokens in assistant history', () => {
  const ctx = {
    systemPrompt: 'Sys',
    tools: [{ name: 'skill', description: 'Load skill', parameters: { type: 'object', properties: { name: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: 'Question' },
      { role: 'user', content: '<system-reminder>Rules</system-reminder>' },
      { role: 'user', content: 'Time' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '<|message_model|>skill<|content_invoke_tool_json|>{"name":"skill","args":{"name":"dsh-doc"}}<|end_message|>' }]
      },
      { role: 'user', content: 'Continue' },
      { role: 'user', content: 'Extra' }
    ]
  };
  const req = buildFromPiContext({ maxTokens: 4096 }, ctx, {}, 'swe-2-flash-max', 'k');
  const prompts = fields(req.bytes).filter((f) => f.num === 3).map((f) => fields(f.data));
  // Expected strict alternation: USER(1), ASSISTANT(2), USER(1)
  assert.deepEqual(
    prompts.map((fs) => fs.find((x) => x.num === 2).n),
    [1, 2, 1]
  );
  const firstUserText = dec.decode(prompts[0].find((x) => x.num === 3).data);
  assert.ok(firstUserText.includes('Sys'));
  assert.ok(firstUserText.includes('Question'));
  assert.ok(firstUserText.includes('Rules'));
  assert.ok(firstUserText.includes('Time'));

  const asstText = dec.decode(prompts[1].find((x) => x.num === 3).data);
  assert.equal(asstText.includes('<|message_model|>'), false);
  assert.equal(asstText, '[attempted tool call: skill]');

  const secondUserText = dec.decode(prompts[2].find((x) => x.num === 3).data);
  assert.equal(secondUserText, 'Continue\n\nExtra');
});

test('buildFromPiContext resolves pi-ai 1.4+ TranscriptContext toolsAdded/toolsRemoved and leading system message', () => {
  const ctx = {
    messages: [
      {
        role: 'system',
        content: 'Initial system',
        toolsAdded: [
          { name: 'read', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
          { name: 'old_tool', description: 'Deprecated', parameters: { type: 'object', properties: {} } }
        ]
      },
      { role: 'user', content: 'Hello' },
      {
        role: 'system',
        content: '',
        toolsRemoved: [{ name: 'old_tool' }],
        toolsAdded: [{ name: 'bash', description: 'Run bash', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }]
      }
    ]
  };
  const req = buildFromPiContext({ maxTokens: 4096 }, ctx, {}, 'swe-2-flash-max', 'k');
  const top = fields(req.bytes);
  const toolNames = top
    .filter((f) => f.num === 10)
    .map((f) => dec.decode(fields(f.data).find((x) => x.num === 1).data));
  assert.deepEqual(toolNames, ['read', 'bash']);

  const promptMsgs = top.filter((f) => f.num === 3).map((f) => fields(f.data));
  assert.equal(promptMsgs.length, 1);
  const text = dec.decode(promptMsgs[0].find((x) => x.num === 3).data);
  assert.ok(text.includes('Initial system'));
  assert.ok(text.includes('<tool name="read">'));
  assert.ok(text.includes('<tool name="bash">'));
  assert.equal(text.includes('old_tool'), false);
});
