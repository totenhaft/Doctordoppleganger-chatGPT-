import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseSrt, splitScript } from '../web/shared.mjs';

test('SRT timing and paragraph titles are kept separate from narration', () => {
  assert.deepEqual(parseSrt('1\r\n00:00:00,100 --> 00:00:01,250\r\n<i>안녕하세요.</i>\r\n'), [
    { start: 0.1, end: 1.25, body: '안녕하세요.' }
  ]);
  assert.deepEqual(splitScript('첫 단계\n문장 하나\n\n문장 둘'), [
    { title: '첫 단계', body: '문장 하나' }, { title: '', body: '문장 둘' }
  ]);
});

test('local access, persistent scripts, and revocable video links', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sol-studio-test-'));
  const origin = 'http://127.0.0.1:8787';
  Object.assign(process.env, { PORT: '8787', CLINIC_ORIGIN: '', CLINIC_DATA_DIR: directory, HEYGEN_API_KEY: '', OPENAI_API_KEY: '' });
  let app;
  const request = async (url, method = 'GET', body, headers = {}) => {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      url, method, headers: { host: '127.0.0.1:8787', origin, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }
    });
    const chunks = [];
    const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } });
    res.setHeader = () => {};
    res.writeHead = status => { res.status = status; res.headersSent = true; };
    const finished = once(res, 'finish');
    await app.handler(req, res);
    await finished;
    const result = Buffer.concat(chunks).toString();
    return { status: res.status, text: () => result, json: () => JSON.parse(result) };
  };
  try {
    app = await import('../server.mjs?first');
    assert.equal((await request('/')).status, 200);
    assert.equal((await request('/.env')).status, 404);
    assert.equal((await request('/api/state', 'GET', undefined, { host: 'outside.example' })).status, 403);
    const script = { title: '안약 안내', language: 'ko', steps: [{ title: '준비', body: '안녕하세요.' }] };
    assert.equal((await request('/api/scripts', 'POST', script, { origin: 'https://outside.example' })).status, 403);
    assert.equal((await request('/api/scripts', 'POST', { ...script, steps: [] })).status, 400);
    const saved = await (await request('/api/scripts', 'POST', script)).json();
    assert.ok(saved.id);
    assert.equal((await request('/api/jobs', 'POST', {})).status, 503);
    app.closeDatabase();
    app = null;

    const id = randomUUID();
    const filename = 'test-result.mp4';
    mkdirSync(join(directory, id));
    writeFileSync(join(directory, id, filename), '0123456789');
    const db = new DatabaseSync(join(directory, 'clinic.sqlite'));
    db.prepare('INSERT INTO records VALUES(?,?,?)').run('jobs', id, JSON.stringify({
      id, title: '안약 안내', language: 'ko', ratio: '16:9', status: 'completed', createdAt: new Date().toISOString(),
      filename, clips: [{ ready: true }], decor: { captions: true, badge: true }, scriptId: saved.id
    }));
    db.close();
    app = await import('../server.mjs?second');
    const state = await (await request('/api/state')).json();
    assert.equal(state.scripts[0].id, saved.id);
    assert.equal(state.jobs[0].status, 'completed');
    const published = await request('/api/jobs/' + id + '/share', 'POST', {});
    const { share } = await published.json();
    assert.match(share, /^[a-f0-9]{48}$/);
    const patientView = await (await request('/share/' + share)).json();
    assert.deepEqual(Object.keys(patientView).sort(), ['clinic', 'headline', 'message', 'notice', 'ratio', 'title']);
    const media = await request('/share/' + share + '/video', 'GET', undefined, { range: 'bytes=2-5' });
    assert.equal(media.status, 206);
    assert.equal(await media.text(), '2345');
    await request('/api/jobs/' + id + '/share', 'POST', { revoke: true });
    assert.equal((await request('/share/' + share)).status, 404);
  } finally {
    app?.closeDatabase();
    rmSync(directory, { recursive: true, force: true });
  }
});
