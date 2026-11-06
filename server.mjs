import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { languages, parseSrt } from './web/shared.mjs';

const run = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.env.CLINIC_DATA_DIR || join(root, 'data'));
const port = Number(process.env.PORT || 8787);
const lanOrigin = process.env.CLINIC_ORIGIN;
const password = process.env.CLINIC_PASSWORD || '';
const origin = new URL(lanOrigin || `http://127.0.0.1:${port}`);
const privateIPv4 = /^(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}$/;
if (lanOrigin && (origin.origin !== lanOrigin || origin.protocol !== 'https:' || !privateIPv4.test(origin.hostname)
    || Number(origin.port || 443) !== port || password.length < 16 || !process.env.TLS_CERT_FILE || !process.env.TLS_KEY_FILE)) {
  throw new Error('원내망 사용에는 사설 IP의 HTTPS 주소, 일치하는 PORT, 16자 이상 비밀번호와 TLS 인증서가 필요합니다.');
}
const hosts = lanOrigin ? [origin.host] : [origin.host, `localhost:${port}`];
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const filters = spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
const canRender = filters.status === 0 && /\bass\s+V->V/.test(filters.stdout) && /\boverlay\s+VV->V/.test(filters.stdout);
const heyKey = process.env.HEYGEN_API_KEY;
const aiKey = process.env.OPENAI_API_KEY;
const defaults = {
  clinic: '연세솔안과', headline: '연세솔안과 진료안내', message: '영상에서 안내하는 내용을 차례대로 확인해 주세요.',
  notice: '이 영상에는 AI로 생성한 안내자가 등장합니다. 영상은 일반 안내이며, 개인별 진료는 담당 의료진의 안내를 따라 주세요.',
  logo: '', size: 36, position: 'right', captions: true, badge: true
};
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(dataDir, 'clinic.sqlite'));
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS records(kind TEXT, id TEXT, doc TEXT NOT NULL, PRIMARY KEY(kind,id));
`);
const get = (kind, id) => JSON.parse(db.prepare('SELECT doc FROM records WHERE kind=? AND id=?').get(kind, id)?.doc || 'null');
const list = kind => db.prepare('SELECT doc FROM records WHERE kind=? ORDER BY rowid DESC').all(kind).map(row => JSON.parse(row.doc));
const put = (kind, doc) => db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET doc=excluded.doc').run(kind, doc.id, JSON.stringify(doc));
const remove = (kind, id) => db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id);
const settings = () => ({ ...defaults, ...get('settings', 'clinic') });
const sessions = new Map();
const attempts = new Map();
const activeStatuses = new Set(['queued', 'generating', 'decorating']);
const jobDir = id => join(dataDir, id);
const token = () => randomBytes(24).toString('hex');
const hash = value => createHash('sha256').update(value).digest();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const getJob = id => get('jobs', id) || (() => { throw fail('영상을 찾을 수 없습니다.', 404); })();

function scriptFrom(input, previous) {
  const title = text(input.title, 60);
  const language = input.language;
  if (!title || !Object.hasOwn(languages, language) || !Array.isArray(input.steps) || input.steps.length > 4) {
    throw fail('제목, 언어와 1~4단계의 원고를 확인해 주세요.');
  }
  const steps = input.steps.map(step => ({ title: text(step?.title, 30), body: text(step?.body, 3500) }));
  if (!steps.length || steps.some(step => !step.body)) throw fail('각 단계에 읽을 문장을 입력해 주세요.');
  return { id: previous?.id || randomUUID(), createdAt: previous?.createdAt || now(), title, language, steps };
}

function decorations(input, base = settings()) {
  const size = Number(input.size);
  return {
    clinic: base.clinic, logo: input.showLogo === false ? '' : base.logo,
    size: [28, 36, 44, 52].includes(size) ? size : base.size,
    position: ['left', 'right'].includes(input.position) ? input.position : base.position,
    captions: typeof input.captions === 'boolean' ? input.captions : base.captions,
    badge: typeof input.badge === 'boolean' ? input.badge : base.badge
  };
}

async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw fail('JSON 요청만 지원합니다.', 415);
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 2_500_000) {
      req.resume();
      throw fail('파일 또는 입력 용량이 너무 큽니다.', 413);
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw Error();
    return body;
  } catch {
    throw fail('입력 형식을 확인해 주세요.');
  }
}

async function provider(url, headers, body) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...headers }, redirect: 'error',
    method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45_000)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(fail(`외부 서비스 오류 (${response.status}) ${text(json.error?.message, 300)}`, 502), { providerStatus: response.status });
  }
  return json;
}

function hey(path, body) {
  if (!heyKey) throw fail('원내 PC의 .env에 HeyGen API 키를 설정해 주세요.', 503);
  return provider(`https://api.heygen.com/v3${path}`, { 'x-api-key': heyKey }, body);
}

async function catalog(path, query) {
  const params = new URLSearchParams({ limit: '50' });
  for (const key of ['token', 'language']) {
    if (query.has(key)) params.set(key, text(query.get(key), 500));
  }
  const result = await hey(`${path}?${params}`);
  return {
    next: result.next_token || '',
    items: (Array.isArray(result.data) ? result.data : []).map(item => ({
      id: item.voice_id || item.id, name: item.name, language: item.language,
      orientation: item.preferred_orientation, type: item.avatar_type, status: item.status
    }))
  };
}

async function askAi(input) {
  if (!aiKey) throw fail('AI 초안·번역을 사용하려면 원내 PC의 .env에 OpenAI API 키를 설정해 주세요.', 503);
  if (!Object.hasOwn(languages, input.language)) throw fail('언어를 선택해 주세요.');
  const translating = input.mode === 'translate';
  const source = translating ? scriptFrom(input.source) : text(input.topic, 200);
  if (!source) throw fail('안내 주제를 입력해 주세요.');
  const result = await provider('https://api.openai.com/v1/responses', { Authorization: `Bearer ${aiKey}` }, {
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini', store: false, max_output_tokens: 3500,
    instructions: '안과의 환자 교육 원고를 작성한다. 환자 개인 정보와 개인별 진료 조언을 포함하지 않는다. 사실이나 수치, 처방, 기간을 지어내지 않는다. 번역에서는 원문의 지시와 순서를 유지한다. 각 단계는 쉬운 구어체를 사용한다. JSON 이외의 텍스트는 넣지 않는다.',
    input: JSON.stringify({ operation: translating ? 'translate' : 'draft', outputLanguage: languages[input.language], source }),
    text: { format: { type: 'json_schema', name: 'script', strict: true, schema: {
      type: 'object', additionalProperties: false, required: ['title', 'steps'], properties: {
        title: { type: 'string' }, steps: { type: 'array', minItems: 1, maxItems: 4, items: {
          type: 'object', additionalProperties: false, required: ['title', 'body'],
          properties: { title: { type: 'string' }, body: { type: 'string' } }
        } }
      }
    } } }
  });
  const output = result.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text;
  if (!output) throw fail('AI 응답에 원고가 없습니다. 다시 시도해 주세요.', 502);
  return scriptFrom({ ...JSON.parse(output), language: input.language });
}

function fromCdn(url) {
  const asset = new URL(url);
  if (asset.protocol !== 'https:' || asset.username || asset.password || asset.port
      || !/(^|\.)(heygen\.ai|heygen\.com)$/.test(asset.hostname)) throw fail('HeyGen 미디어 주소를 확인할 수 없습니다.', 502);
  return fetch(asset, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
}

async function download(url, file, maxBytes) {
  const response = await fromCdn(url);
  if (!response.ok || !response.body) throw fail(`미디어 내려받기 오류 (${response.status})`, 502);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes ? new Error('미디어 용량 제한을 초과했습니다.') : null, chunk);
    }
  });
  const part = `${file}.partial`;
  try {
    await pipeline(response.body, limit, createWriteStream(part));
    renameSync(part, file);
  } finally {
    rmSync(part, { force: true });
  }
}

function assTime(seconds) {
  const ticks = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(ticks / 360000)}:${String(Math.floor(ticks / 6000) % 60).padStart(2, '0')}:${String(Math.floor(ticks / 100) % 60).padStart(2, '0')}.${String(ticks % 100).padStart(2, '0')}`;
}

const assText = value => value.replaceAll('\\', '＼').replaceAll('{', '｛').replaceAll('}', '｝').replaceAll('\n', '\\N');

async function decorate(job) {
  const cwd = jobDir(job.id);
  const d = job.decor;
  const font = (process.env.CAPTION_FONT || 'Malgun Gothic').replace(/[,\r\n]/g, '');
  const vertical = job.ratio === '9:16';
  const [w, h] = vertical ? [720, 1280] : [1280, 720];
  const style = (name, size, align, margin) => `Style: ${name},${font},${size},&H00FFFFFF,&H00FFFFFF,&H001F2117,&H80181C2B,0,0,0,0,100,100,0,0,3,7,0,${align},40,40,${margin},1`;
  const logoFile = join(cwd, 'logo.img');
  if (d.logo) writeFileSync(logoFile, Buffer.from(d.logo.split(',')[1], 'base64'));
  for (const [index, clip] of job.clips.entries()) {
    const lines = [
      '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes',
      '[V4+ Styles]', 'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
      style('Clinic', 27, 7, 35), style('Stage', 28, 8, 94), style('Caption', d.size, 2, vertical ? 130 : 83),
      '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text'
    ];
    const cue = (start, end, styleName, value) => lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},${styleName},,0,0,0,,${assText(value)}`);
    cue(0, clip.duration || 3600, 'Clinic', d.clinic);
    if (d.badge) cue(0, clip.duration || 3600, 'Stage', `${index + 1} / ${job.clips.length}  ${job.steps[index].title || '단계'}`);
    if (d.captions) {
      const srt = join(cwd, `raw-${index}.srt`);
      if (!existsSync(srt)) throw fail('자막 파일이 없습니다. 자막 표시를 끄거나 다시 꾸며 주세요.');
      const cues = parseSrt(readFileSync(srt, 'utf8'));
      if (!cues.length) throw fail('제공된 자막의 시간 정보를 읽을 수 없습니다.');
      for (const row of cues) cue(row.start, row.end, 'Caption', row.body);
    }
    writeFileSync(join(cwd, `captions-${index}.ass`), lines.join('\n'));
    const input = ['-i', `raw-${index}.mp4`];
    let graph = `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,ass=captions-${index}.ass`;
    if (d.logo) {
      input.push('-i', 'logo.img');
      graph += `[base];[1:v]scale=110:54:force_original_aspect_ratio=decrease[logo];[base][logo]overlay=${d.position === 'left' ? '24' : 'W-w-24'}:H-h-24`;
    }
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-filter_complex', graph + '[out]',
      '-map', '[out]', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', `rendered-${index}.mp4`], { cwd, timeout: 900_000, windowsHide: true });
  }
  writeFileSync(join(cwd, 'clips.txt'), job.clips.map((_, index) => `file 'rendered-${index}.mp4'`).join('\n') + '\n');
  const output = 'result-next.mp4';
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', 'clips.txt',
    '-c', 'copy', '-movflags', '+faststart', output], { cwd, timeout: 180_000, windowsHide: true });
  // Versioned outputs keep active streams open and make the DB update the publication point.
  const filename = `result-${randomUUID()}.mp4`;
  renameSync(join(cwd, output), join(cwd, filename));
  for (const index of job.clips.keys()) rmSync(join(cwd, `rendered-${index}.mp4`), { force: true });
  return filename;
}

async function processJob(job) {
  const index = job.clips.findIndex(clip => !clip.ready);
  if (index < 0) {
    job.status = 'decorating';
    put('jobs', job);
    job.filename = await decorate(job);
    job.status = 'completed';
    return;
  }
  const clip = job.clips[index];
  job.status = 'generating';
  if (!clip.providerId) {
    job.submitting = true;
    put('jobs', job);
    const result = await hey('/videos', {
      type: 'avatar', avatar_id: job.avatar, ...(job.voice ? { voice_id: job.voice } : {}),
      title: `${job.title} (${index + 1}/${job.clips.length})`, aspect_ratio: job.ratio,
      script: job.steps[index].body, caption: { file_format: 'srt' }, output_format: 'mp4'
    });
    clip.providerId = result.data?.id || result.data?.video_id;
    if (!clip.providerId) throw fail('HeyGen에서 작업 ID를 받지 못했습니다.', 502);
    job.submitting = false;
    put('jobs', job);
    return;
  }
  const { data: result } = await hey(`/videos/${encodeURIComponent(clip.providerId)}`);
  if (['failed', 'cancelled', 'canceled'].includes(result?.status)) throw fail(text(result.failure_message || result.failure_code, 300) || 'HeyGen에서 영상 생성이 실패했습니다.');
  if (result?.status !== 'completed') return;
  const cwd = jobDir(job.id);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const rawFile = join(cwd, `raw-${index}.mp4`);
  const srtFile = join(cwd, `raw-${index}.srt`);
  if (!existsSync(rawFile)) await download(result.video_url, rawFile, 400_000_000);
  if (result.subtitle_url && !existsSync(srtFile)) await download(result.subtitle_url, srtFile, 2_000_000);
  clip.duration = Number(result.duration);
  clip.ready = true;
}

for (const job of list('jobs')) {
  if (job.submitting && activeStatuses.has(job.status)) {
    put('jobs', { ...job, status: 'uncertain', error: '이전 요청의 접수 여부를 HeyGen 대시보드에서 확인해 주세요.' });
  }
}

let processing = false;
async function tick() {
  if (processing) return;
  const job = list('jobs').reverse().find(item => activeStatuses.has(item.status));
  if (!job) return;
  processing = true;
  try {
    await processJob(job);
    job.error = '';
    job.failures = 0;
  } catch (error) {
    const retryable = !job.submitting && job.status === 'generating' && (!error.status || error.status >= 500);
    job.failures = (job.failures || 0) + 1;
    if (!retryable || job.failures >= 5) {
      const uncertain = job.submitting && (!error.providerStatus || error.providerStatus >= 500);
      job.status = uncertain ? 'uncertain' : job.status === 'decorating' ? 'decoration_error' : 'failed';
      job.error = uncertain ? '요청 접수 여부가 불명확합니다. HeyGen 대시보드에서 먼저 확인해 주세요.'
        : error.cmd ? 'FFmpeg에서 영상 꾸미기에 실패했습니다. 자막·로고 설정과 FFmpeg 설치를 확인해 주세요.'
          : text(error.message, 350);
    }
  } finally {
    put('jobs', job);
    processing = false;
  }
}

const jobView = job => ({
  id: job.id, title: job.title, language: job.language, status: job.status, createdAt: job.createdAt, ratio: job.ratio,
  progress: job.clips.filter(clip => clip.ready).length, total: job.clips.length, error: job.error, available: !!job.filename,
  share: job.share || '', scriptId: job.scriptId, canDecorate: job.clips.every(clip => clip.ready),
  captions: job.decor.captions, badge: job.decor.badge, size: job.decor.size, position: job.decor.position,
  showLogo: !!job.decor.logo
});

function send(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function serve(req, res, file, type, saveAs) {
  const { size } = statSync(file);
  const headers = { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' };
  if (saveAs) headers['Content-Disposition'] = `attachment; filename="video.mp4"; filename*=UTF-8''${encodeURIComponent(saveAs)}`;
  let start = 0, end = size - 1, status = 200;
  const range = req.headers.range;
  if (range && type === 'video/mp4') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match?.[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    } else if (Number(match?.[2]) > 0) {
      start = Math.max(0, size - Number(match[2]));
    } else {
      start = size;
    }
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Length'] = end - start + 1;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || !size) return res.end();
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/view', ['view.html', 'text/html']],
  ['/app.mjs', ['app.mjs', 'text/javascript']], ['/shared.mjs', ['shared.mjs', 'text/javascript']],
  ['/view.mjs', ['view.mjs', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]
]);

async function router(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (!hosts.includes(req.headers.host)) throw fail('접속 주소를 확인해 주세요.', 403);
  const url = new URL(req.url, origin);
  const path = url.pathname;
  const method = req.method;
  const read = method === 'GET' || method === 'HEAD';
  if (!read && req.headers.origin !== `${origin.protocol}//${req.headers.host}`) throw fail('요청 출처를 확인할 수 없습니다.', 403);
  if (read && assets.has(path)) {
    const [file, type] = assets.get(path);
    return serve(req, res, join(root, 'web', file), `${type}; charset=utf-8`);
  }
  const shared = /^\/share\/([a-f0-9]{48})(\/video)?$/.exec(path);
  if (read && shared) {
    const job = list('jobs').find(item => item.share === shared[1] && item.filename);
    if (!job) throw fail('공유가 만료되었거나 영상이 없습니다.', 404);
    if (shared[2]) return serve(req, res, join(jobDir(job.id), job.filename), 'video/mp4');
    const s = settings();
    return send(res, { clinic: s.clinic, headline: s.headline, message: s.message, notice: s.notice, title: job.title, ratio: job.ratio });
  }
  const session = /(?:^|;\s*)sol_session=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  if (method === 'POST' && path === '/api/login' && lanOrigin) {
    const ip = req.socket.remoteAddress;
    const recent = (attempts.get(ip) || []).filter(time => Date.now() - time < 60_000);
    if (recent.length >= 6) throw fail('잠시 후 다시 시도해 주세요.', 429);
    const body = await jsonBody(req);
    if (!timingSafeEqual(hash(text(body.password, 1024)), hash(password))) {
      attempts.set(ip, [...recent, Date.now()]);
      throw fail('비밀번호를 확인해 주세요.', 401);
    }
    attempts.delete(ip);
    for (const [key, expires] of sessions) if (expires <= Date.now()) sessions.delete(key);
    const key = token();
    sessions.set(key, Date.now() + 8 * 3600_000);
    res.setHeader('Set-Cookie', `sol_session=${key}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`);
    return send(res, { ok: true });
  }
  if (lanOrigin && (sessions.get(session) || 0) < Date.now()) throw fail('원내 관리자 로그인이 필요합니다.', 401);
  if (method === 'POST' && path === '/api/logout') {
    sessions.delete(session);
    res.setHeader('Set-Cookie', 'sol_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
    return send(res, { ok: true });
  }
  if (read && path === '/api/state') return send(res, {
    scripts: list('scripts'), settings: settings(), jobs: list('jobs').map(jobView),
    capabilities: { hey: !!heyKey, ai: !!aiKey, ffmpeg: canRender, lan: !!lanOrigin }
  });
  if (read && path === '/api/jobs') return send(res, list('jobs').map(jobView));
  if (read && path === '/api/avatars') return send(res, await catalog('/avatars/looks', url.searchParams));
  if (read && path === '/api/voices') return send(res, await catalog('/voices', url.searchParams));
  if (read && path === '/api/heygen') {
    await hey('/users/me');
    return send(res, { ok: true });
  }
  if (method === 'POST' && path === '/api/ai') return send(res, await askAi(await jsonBody(req)));
  if (method === 'POST' && path === '/api/scripts') {
    const body = await jsonBody(req);
    const previous = body.id ? get('scripts', body.id) : null;
    if (body.id && !previous) throw fail('원고를 찾을 수 없습니다.', 404);
    const script = scriptFrom(body, previous);
    put('scripts', script);
    return send(res, script);
  }
  if (method === 'POST' && path === '/api/settings') {
    const body = await jsonBody(req);
    const current = settings();
    const next = { ...current, id: 'clinic' };
    if (body.section === 'branding') {
      if (body.logo && !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]{1,1400000}$/.test(body.logo)) throw fail('1MB 이하의 PNG 또는 JPEG 로고를 사용해 주세요.');
      Object.assign(next, decorations(body, current), { clinic: text(body.clinic, 30) || defaults.clinic, logo: body.logo || '' });
    } else if (body.section === 'message') {
      Object.assign(next, { headline: text(body.headline, 60) || defaults.headline,
        message: text(body.message, 500), notice: text(body.notice, 320) || defaults.notice });
    } else {
      throw fail('설정 범위를 확인해 주세요.');
    }
    put('settings', next);
    return send(res, next);
  }
  if (method === 'POST' && path === '/api/jobs') {
    const body = await jsonBody(req);
    if (!heyKey || !canRender) throw fail('영상 제작에는 HeyGen API 키와 자막 필터가 포함된 FFmpeg가 필요합니다.', 503);
    const script = get('scripts', body.scriptId);
    if (!script || !text(body.avatar, 150) || !['16:9', '9:16'].includes(body.ratio)) throw fail('원고, 아바타 ID와 화면비를 확인해 주세요.');
    if (!/^[a-f0-9-]{36}$/.test(body.requestId)) throw fail('제작 요청 번호를 확인해 주세요.');
    const existing = get('jobs', body.requestId);
    if (existing) return send(res, jobView(existing));
    const job = { id: body.requestId, title: text(body.title, 60) || script.title, scriptId: script.id,
      language: script.language, steps: script.steps, avatar: text(body.avatar, 150), voice: text(body.voice, 150),
      ratio: body.ratio, decor: decorations(body), status: 'queued', createdAt: now(), clips: script.steps.map(() => ({})) };
    put('jobs', job);
    return send(res, jobView(job), 202);
  }
  const scriptRoute = /^\/api\/scripts\/([a-f0-9-]{36})$/.exec(path);
  if (method === 'DELETE' && scriptRoute) {
    remove('scripts', scriptRoute[1]);
    return send(res, { ok: true });
  }
  const jobRoute = /^\/api\/jobs\/([a-f0-9-]{36})(?:\/(video|share|decorate))?$/.exec(path);
  if (jobRoute) {
    const job = getJob(jobRoute[1]);
    const action = jobRoute[2];
    if (read && action === 'video' && job.filename) {
      return serve(req, res, join(jobDir(job.id), job.filename), 'video/mp4', url.searchParams.has('download') ? job.title + '.mp4' : '');
    }
    if (method === 'POST' && action === 'share' && job.filename && !activeStatuses.has(job.status)) {
      const body = await jsonBody(req);
      job.share = body.revoke ? '' : job.share || token();
      put('jobs', job);
      return send(res, { share: job.share });
    }
    if (method === 'POST' && action === 'decorate' && job.clips.every(clip => clip.ready) && !activeStatuses.has(job.status)) {
      if (!canRender) throw fail('자막 필터가 포함된 FFmpeg가 필요합니다.', 503);
      const body = await jsonBody(req);
      job.decor = decorations(body);
      job.status = 'decorating';
      job.error = '';
      put('jobs', job);
      return send(res, jobView(job), 202);
    }
    if (method === 'DELETE' && !action && !activeStatuses.has(job.status)) {
      remove('jobs', job.id);
      try { rmSync(jobDir(job.id), { recursive: true, force: true }); } catch { /* Windows may hold an active MP4 stream. */ }
      return send(res, { ok: true });
    }
  }
  throw fail('요청하신 페이지를 찾을 수 없습니다.', 404);
}

export function handler(req, res) {
  return router(req, res).catch(error => {
    if (res.headersSent) return res.destroy();
    if (!error.status) console.error(error);
    send(res, { error: error.status ? error.message : '요청을 처리할 수 없습니다.' }, error.status || 500);
  });
}

export const closeDatabase = () => db.close();

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = lanOrigin
    ? createTlsServer({ cert: readFileSync(process.env.TLS_CERT_FILE), key: readFileSync(process.env.TLS_KEY_FILE) }, handler)
    : createServer(handler);
  server.listen(port, origin.hostname, () => {
    const worker = setInterval(tick, 6500);
    worker.unref();
    console.log(`원내 영상 스튜디오  ${origin.origin}`);
  });
}
