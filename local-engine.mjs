import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ttsPython = process.env.TTS_PYTHON;
const models = { preset: process.env.QWEN_TTS_MODEL, clone: process.env.QWEN_CLONE_MODEL };
const referenceDir = process.env.VOICE_REFERENCES;
const museDir = process.env.MUSETALK_DIR && resolve(process.env.MUSETALK_DIR);
const musePython = process.env.MUSETALK_PYTHON;
const offline = { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' };
const hasModel = path => !!path && existsSync(join(path, 'config.json'));
const ps = process.platform === 'win32' && join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const psArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(root, 'engines', 'tts.ps1')];
const rate = 24000;
const fps = 25;
const languages = { ko: 'Korean', en: 'English', zh: 'Chinese', ja: 'Japanese', es: 'Spanish' };
const presets = [
  { id: 'clinic-guide', name: '솔 안내자 · 네이비', type: 'illustration', palette: ['#193957', '#e1f0fa', '#334758', '#e4ac89'] },
  { id: 'clinic-care', name: '솔 안내자 · 민트', type: 'illustration', palette: ['#21685d', '#e5f4ef', '#2f292b', '#c98e74'] }
];
const flags = { timeout: 1_800_000, windowsHide: true, maxBuffer: 3_000_000 };
let sapiVoices;

export const builtInAvatars = () => presets;
export const portraitReady = () => !!musePython && !!museDir && [
  'scripts/inference.py', 'models/musetalkV15/unet.pth', 'models/musetalkV15/musetalk.json',
  'models/whisper/config.json', 'models/sd-vae/config.json'
].every(path => existsSync(join(museDir, path)));

export async function localVoices(language) {
  if (!sapiVoices) {
    sapiVoices = ps ? run(ps, [...psArgs, '-Spec', 'list'], { ...flags, timeout: 8000 })
      .then(({ stdout }) => JSON.parse(stdout)).catch(() => []) : Promise.resolve([]);
  }
  const result = (await sapiVoices).filter(item => item.language === language).map(item => ({
    id: `windows:${item.name}`, name: item.name + ' · Windows', engine: 'windows', speaker: item.name
  }));
  if (!ttsPython || !languages[language]) return result;
  if (hasModel(models.preset)) {
    const speakers = { ko: ['Sohee'], en: ['Ryan', 'Aiden'], zh: ['Vivian', 'Serena'], ja: ['Ono_Anna'], es: ['Ryan'] };
    for (const speaker of speakers[language]) result.unshift({
      id: `qwen:${speaker}`, name: speaker + ' · Qwen3-TTS', engine: 'qwen', speaker
    });
  }
  if (hasModel(models.clone) && referenceDir && existsSync(referenceDir)) {
    for (const name of readdirSync(referenceDir)) {
      if (!/^[\p{L}\p{N}_ -]{1,40}\.wav$/u.test(name)) continue;
      const speaker = basename(name, '.wav');
      const transcript = join(referenceDir, speaker + '.txt');
      if (existsSync(transcript)) result.unshift({ id: `clone:${speaker}`, name: speaker + ' · 등록 음성', engine: 'clone',
        reference: { audio: resolve(referenceDir, name), text: resolve(transcript) } });
    }
  }
  return result;
}

function sentenceChunks(body, language) {
  const sentences = new Intl.Segmenter(language, { granularity: 'sentence' }).segment(body.trim());
  const lines = [];
  for (const { segment } of sentences) {
    for (const line of segment.trim().split(/\n+/)) {
      let remaining = line.trim();
      while (remaining.length > 54) {
        const gap = remaining.lastIndexOf(' ', 54);
        const end = gap >= 20 ? gap : 54;
        lines.push(remaining.slice(0, end).trim());
        remaining = remaining.slice(end).trim();
      }
      if (remaining) lines.push(remaining);
    }
  }
  return lines;
}

function stamp(samples) {
  const ms = Math.round(samples * 1000 / rate);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

function wave(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function speech(body, language, voice, scratch, source, captions) {
  const parts = sentenceChunks(body, language).map((text, index) => ({ text, file: join(scratch, `speech-${index}.wav`) }));
  if (!parts.length) throw new Error('읽을 원고가 없습니다.');
  const spec = join(scratch, 'speech.json');
  writeFileSync(spec, JSON.stringify({
    model: voice.engine === 'clone' ? models.clone : models.preset, language: languages[language], speaker: voice.speaker,
    reference: voice.reference, parts
  }));
  if (voice.engine === 'windows') {
    await run(ps, [...psArgs, '-Spec', spec], flags);
  } else {
    await run(ttsPython, [join(root, 'engines', 'tts.py'), spec], { ...flags, env: offline });
  }
  const samples = [];
  const cues = [];
  const pause = Buffer.alloc(Math.round(rate * 0.12) * 2);
  let offset = 0;
  for (const [index, part] of parts.entries()) {
    const file = join(scratch, 'speech.pcm');
    await run(ffmpeg, ['-v', 'error', '-y', '-i', part.file, '-ac', '1', '-ar', String(rate), '-f', 's16le', file], flags);
    const pcm = readFileSync(file);
    if (!pcm.length) throw new Error('음성 파일이 비어 있습니다.');
    cues.push(`${index + 1}\n${stamp(offset)} --> ${stamp(offset + pcm.length / 2)}\n${part.text}`);
    samples.push(pcm, pause);
    offset += (pcm.length + pause.length) / 2;
  }
  const pcm = Buffer.concat(samples);
  writeFileSync(source, wave(pcm));
  writeFileSync(captions, cues.join('\n\n') + '\n');
  return pcm;
}

const rgb = value => Buffer.from(value.slice(1), 'hex');
const dimensions = ratio => ratio === '9:16' ? [720, 1280] : [1280, 720];

function illustrate(file, avatar, width, height) {
  const [uniform, backdrop, hair, skin] = avatar.palette.map(rgb);
  const pixels = Buffer.alloc(width * height * 3);
  const cx = width / 2;
  const cy = height * 0.44;
  const oval = (x, y, rx, ry, color) => {
    for (let dy = Math.max(0, Math.floor(y - ry)); dy < Math.min(height, y + ry); dy++) {
      const span = rx * Math.sqrt(Math.max(0, 1 - ((dy - y) / ry) ** 2));
      const left = Math.max(0, Math.ceil(x - span));
      const right = Math.min(width, Math.floor(x + span));
      for (let dx = left; dx < right; dx++) color.copy(pixels, (dy * width + dx) * 3);
    }
  };
  for (let y = 0; y < height; y++) {
    const shade = Math.round(y / height * 14);
    const row = Buffer.from(backdrop.map(value => value - shade));
    pixels.fill(row, y * width * 3, (y + 1) * width * 3);
  }
  oval(cx, cy + 10, 228, 218, rgb('#f3f8fa'));
  oval(cx, cy + 258, 260, 128, uniform);
  oval(cx, cy + 172, 59, 43, rgb('#f6f8f9'));
  oval(cx, cy + 133, 46, 59, skin);
  oval(cx, cy - 19, 137, 153, hair);
  oval(cx - 118, cy + 21, 24, 34, skin);
  oval(cx + 118, cy + 21, 24, 34, skin);
  oval(cx, cy + 10, 119, 139, skin);
  oval(cx - 38, cy - 96, 83, 44, hair);
  oval(cx + 58, cy - 93, 57, 40, hair);
  for (const side of [-1, 1]) {
    oval(cx + side * 48, cy - 19, 22, 5, hair);
    oval(cx + side * 47, cy + 0, 9, 11, rgb('#24303e'));
    oval(cx + side * 46 - 2, cy - 3, 2, 3, rgb('#fffafa'));
    oval(cx + side * 78, cy + 47, 20, 9, rgb('#cb8b7a'));
  }
  oval(cx + 3, cy + 35, 11, 6, rgb('#b67863'));
  writeFileSync(file, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]));
  return { x: cx - 48, y: Math.round(cy + 63) - 24 };
}

function* mouths(pcm) {
  const total = Math.ceil(pcm.length / 2 / rate * fps);
  const frames = [];
  for (let openness = 0; openness <= 16; openness++) {
    const frame = Buffer.alloc(96 * 48 * 4);
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 96; x++) {
        const dy = y - 24;
        if (((x - 48) / (33 - openness / 3)) ** 2 + (dy / (2 + openness)) ** 2 > 1) continue;
        const i = (y * 96 + x) * 4;
        const teeth = openness >= 5 && dy < -openness / 4;
        frame.set(teeth ? [243, 224, 211, 255] : [91, 43, 50, 255], i);
      }
    }
    frames.push(frame);
  }
  let smooth = 0;
  for (let index = 0; index < total; index++) {
    let sum = 0;
    const start = Math.floor(index * rate / fps);
    const end = Math.min(pcm.length / 2, Math.floor((index + 1) * rate / fps));
    for (let sample = start; sample < end; sample++) sum += (pcm.readInt16LE(sample * 2) / 32768) ** 2;
    const level = Math.sqrt(sum / Math.max(1, end - start));
    const target = level < 0.008 ? 0 : Math.min(16, 2 + level * 75);
    smooth = target * 0.68 + smooth * 0.32;
    yield frames[Math.round(smooth)];
  }
}

async function renderIllustration(pcm, avatar, ratio, scratch, source, destination) {
  const [width, height] = dimensions(ratio);
  const image = join(scratch, 'avatar.ppm');
  const { x, y } = illustrate(image, avatar, width, height);
  const args = ['-v', 'error', '-y', '-filter_complex_threads', '1', '-loop', '1', '-framerate', String(fps), '-i', image,
    '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', '96x48', '-framerate', String(fps), '-i', 'pipe:0', '-i', source,
    '-filter_complex', `[0:v][1:v]overlay=${x}:${y}:shortest=1,format=yuv420p[out]`,
    '-map', '[out]', '-map', '2:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', destination];
  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let errors = '';
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-1200); });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('FFmpeg 아바타 합성 실패: ' + errors)));
  });
  const timeout = setTimeout(() => child.kill(), flags.timeout);
  try {
    await Promise.all([completed, pipeline(Readable.from(mouths(pcm)), child.stdin)]);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
  }
}

async function renderPortrait(avatar, ratio, source, destination) {
  if (!portraitReady()) throw new Error('실사 아바타에 필요한 MuseTalk 1.5를 설정해 주세요.');
  // Upstream uses shell commands internally. Give it only fixed, relative ASCII filenames.
  const relative = `sol-job-${randomUUID()}`;
  const scratch = join(museDir, relative);
  mkdirSync(scratch, { mode: 0o700 });
  try {
    const photo = join(scratch, 'photo.' + (avatar.image.startsWith('data:image/png') ? 'png' : 'jpg'));
    writeFileSync(photo, Buffer.from(avatar.image.split(',')[1], 'base64'));
    copyFileSync(source, join(scratch, 'voice.wav'));
    const [width, height] = dimensions(ratio);
    await run(ffmpeg, ['-v', 'error', '-y', '-loop', '1', '-framerate', String(fps), '-i', photo, '-t', '1.2',
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`,
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', join(scratch, 'portrait.mp4')], flags);
    writeFileSync(join(scratch, 'inference.yaml'), `guide:\n  video_path: ${relative}/portrait.mp4\n  audio_path: ${relative}/voice.wav\n  result_name: result.mp4\n`);
    const env = { ...offline };
    if (resolve(ffmpeg) === ffmpeg) env.PATH = dirname(ffmpeg) + (process.platform === 'win32' ? ';' : ':') + (env.PATH || '');
    await run(musePython, ['-m', 'scripts.inference', '--version', 'v15', '--fps', '25', '--batch_size', '4', '--use_float16',
      '--inference_config', `${relative}/inference.yaml`, '--result_dir', `${relative}/render`,
      '--unet_model_path', 'models/musetalkV15/unet.pth', '--unet_config', 'models/musetalkV15/musetalk.json'], { ...flags, env, cwd: museDir });
    const generated = join(scratch, 'render', 'v15', 'result.mp4');
    if (!existsSync(generated)) throw new Error('MuseTalk 결과 파일이 없습니다. 설치와 사진의 정면 얼굴을 확인해 주세요.');
    copyFileSync(generated, destination);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function renderLocalStep({ avatar, voice, body, language, ratio, cwd, index }) {
  const scratch = join(cwd, 'step-' + index);
  const audio = join(scratch, 'voice.wav');
  const captions = join(cwd, `raw-${index}.srt`);
  const partial = join(cwd, `raw-${index}-next.mp4`);
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  try {
    const pcm = await speech(body, language, voice, scratch, audio, captions);
    if (avatar.type === 'portrait') await renderPortrait(avatar, ratio, audio, partial);
    else await renderIllustration(pcm, avatar, ratio, scratch, audio, partial);
    return { duration: pcm.length / 2 / rate, path: partial };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
