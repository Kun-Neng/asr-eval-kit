// 串接音檔：把多個音檔依序接成一個 16 kHz 單聲道 WAV，可重複數次，用來製作長音檔測試。
//
// 用法（在專案根目錄）：
//   node tools/concat-audio.mjs samples/eval --repeat 3 --out samples/tts-hanhan-x3.wav
//   node tools/concat-audio.mjs a.wav b.mp3 c.m4a --out samples/mixed.wav
//
// 輸入可以是檔案或資料夾（資料夾取其中的音檔，依檔名排序），格式不同也可以，
// 會統一轉成 16 kHz 單聲道 16-bit PCM。需要 ffmpeg 在 PATH 上。
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const AUDIO_EXTS = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.opus', '.webm']);

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repeat: { type: 'string', default: '1' },
    out: { type: 'string', default: 'samples/concat.wav' },
  },
});

const repeat = Number(opt.repeat);
if (!Number.isInteger(repeat) || repeat < 1) {
  throw new Error('--repeat 必須是正整數');
}

if (positionals.length === 0) {
  throw new Error('請指定要串接的音檔或資料夾，例如：node tools/concat-audio.mjs samples/eval --repeat 3');
}

const sources = positionals.flatMap((p) => {
  const full = resolve(p);
  if (!statSync(full).isDirectory()) {
    return [full];
  }

  return readdirSync(full)
    .filter((f) => AUDIO_EXTS.has(extname(f).toLowerCase()))
    .sort()
    .map((f) => join(full, f));
});
if (sources.length === 0) {
  throw new Error('找不到任何音檔');
}

const out = resolve(opt.out);
if (sources.includes(out)) {
  throw new Error(`輸出檔不能是輸入檔之一：${out}`);
}

const inputs = Array.from({ length: repeat }, () => sources).flat();

// 每個輸入先統一格式，再用 concat filter 接起來；不同取樣率或聲道數的檔案也能串接
const prep = inputs.map((_, i) => `[${i}:a]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono[a${i}]`);
const joined = inputs.map((_, i) => `[a${i}]`).join('') + `concat=n=${inputs.length}:v=0:a=1[out]`;

try {
  await promisify(execFile)('ffmpeg', [
    '-y', '-loglevel', 'error',
    ...inputs.flatMap((f) => ['-i', f]),
    '-filter_complex', [...prep, joined].join(';'),
    '-map', '[out]',
    '-c:a', 'pcm_s16le',
    out,
  ]);
} catch (err) {
  if (err.code === 'ENOENT') {
    throw new Error('找不到 ffmpeg，請先安裝（Windows：winget install --id Gyan.FFmpeg -e），安裝後重開終端機');
  }

  throw new Error(`ffmpeg 失敗：${err.stderr?.trim() || err.message}`);
}

// 從 WAV 的 data chunk 計算長度（16 kHz × 16-bit × 單聲道 = 32000 bytes/秒）
function wavSeconds(file) {
  const buf = readFileSync(file);

  for (let pos = 12; pos + 8 <= buf.length; ) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'data') {
      return size / 32000;
    }
    pos += 8 + size + (size % 2);
  }

  return NaN;
}

console.log(`輸入 ${sources.length} 個檔案 × ${repeat} 次 = ${inputs.length} 段`);
console.log(`輸出：${out}（${wavSeconds(out).toFixed(2)} 秒）`);
