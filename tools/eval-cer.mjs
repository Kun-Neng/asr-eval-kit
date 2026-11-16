// 轉錄準確度評估：對評估集逐檔轉錄，計算 CER（字元錯誤率）與耗時。
//
// 用法（在專案根目錄）：
//   node tools/eval-cer.mjs                         # 直接打 llama.cpp / vLLM（http://127.0.0.1:8080/v1）
//   node tools/eval-cer.mjs --mode backend --base http://127.0.0.1:3000   # 經過實作 POST /api/transcribe 的後端（介面見 README）
//   node tools/eval-cer.mjs --set samples/my-voice  # 指定評估集資料夾
//   node tools/eval-cer.mjs --base http://gpu-host:8000/v1 --think   # 指定位址；--think 開啟 thinking 做比較
//   node tools/eval-cer.mjs --source-lang "Japanese"                 # prompt 裡語音的語言改成與輸出語言不同
//   node tools/eval-cer.mjs --audio-last                             # 音訊改放在文字之後
//
// 評估集資料夾內放 WAV 與 refs.tsv（UTF-8，每行「檔名<Tab>正確文字」，# 開頭為註解）。
// 正確文字的數字請寫阿拉伯數字（ASR prompt 要求模型輸出數字）。WAV 不進版控，refs.tsv 進版控。
//
// 環境變數：VLLM_API_KEY（推論服務有設 key 時）、VLLM_MODEL（vLLM 需要；llama.cpp 會忽略）
// 需要 Node 22.18+（直接 import .ts 的 prompt）。--mode backend 時 prompt 由後端決定，
// 要和 direct 模式比較時，請確認後端用的 prompt 與 prompts/asr.prompt.ts 一致
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { asrPrompt } from '../prompts/asr.prompt.ts';

const { values: opt } = parseArgs({
  options: {
    mode: { type: 'string', default: 'direct' },
    base: { type: 'string' },
    set: { type: 'string', default: 'samples/eval' },
    lang: { type: 'string', default: 'Traditional Chinese' },
    think: { type: 'boolean', default: false },
    'source-lang': { type: 'string' }, // 語音的語言，預設與 --lang 相同
    'audio-last': { type: 'boolean', default: false }, // 音訊改放在文字之後
  },
});

if (!['direct', 'backend'].includes(opt.mode)) {
  throw new Error('--mode 只能是 direct 或 backend');
}

// backend 模式由後端自己組 prompt，這兩個參數不會生效，直接報錯避免誤用
if (opt.mode === 'backend' && (opt['source-lang'] || opt['audio-last'])) {
  throw new Error('--source-lang 與 --audio-last 只能用在 direct 模式');
}

// 後端的位址因專案而異，不提供預設值，避免誤連到同一個 port 上的其他服務
if (opt.mode === 'backend' && !opt.base) {
  throw new Error('--mode backend 需要用 --base 指定後端位址，例如 --base http://127.0.0.1:3000');
}

const base = opt.base ?? 'http://127.0.0.1:8080/v1';
const setDir = resolve(opt.set);

const items = readFileSync(join(setDir, 'refs.tsv'), 'utf8')
  .replace(/^﻿/, '')
  .split(/\r?\n/)
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => {
    const [file, ref] = l.split('\t');
    if (!file || !ref) {
      throw new Error(`refs.tsv 格式錯誤（需以 Tab 分隔）：${l}`);
    }

    return { file: file.trim(), ref: ref.trim() };
  });

// 比對前去掉標點與空白、統一「臺/台」，只比較文字內容
const norm = (s) => s.replace(/[\s，。、,.!?！？：:；;「」『』"'（）()…—-]/g, '').replace(/臺/g, '台');

function cer(ref, hyp) {
  const a = [...norm(ref)];
  const b = [...norm(hyp)];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);

  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }

  return prev[b.length] / a.length;
}

/** 從 WAV header 算長度（找 data chunk，支援非 44 bytes header） */
function wavSeconds(buf) {
  const byteRate = buf.readUInt32LE(28);

  for (let p = 12; p + 8 <= buf.length; ) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'data') {
      return Math.min(size, buf.length - p - 8) / byteRate;
    }
    p += 8 + size + (size % 2);
  }

  return NaN;
}

async function transcribe(wav) {
  if (opt.mode === 'backend') {
    const form = new FormData();
    form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'eval.wav');
    form.append('lang', opt.lang);

    const r = await fetch(`${base}/api/transcribe`, { method: 'POST', body: form });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(`${r.status} ${JSON.stringify(j)}`);
    }

    return { text: j.text };
  }

  const key = process.env.VLLM_API_KEY;
  const audio = { type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } };
  const text = { type: 'text', text: asrPrompt(opt.lang, opt['source-lang'] ?? opt.lang) };

  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model: process.env.VLLM_MODEL ?? 'gemma-4-E4B-it',
      temperature: 0,
      max_tokens: opt.think ? 2048 : 512,
      chat_template_kwargs: { enable_thinking: opt.think },
      messages: [{ role: 'user', content: opt['audio-last'] ? [text, audio] : [audio, text] }],
    }),
  });
  if (!r.ok) {
    throw new Error(`${r.status} ${await r.text()}`);
  }

  const j = await r.json();
  return { text: (j.choices?.[0]?.message?.content ?? '').trim(), model: j.model, timings: j.timings };
}

const variant = opt.mode === 'direct'
  ? `  source-lang=${opt['source-lang'] ?? opt.lang}  lang=${opt.lang}  ${opt['audio-last'] ? '音訊在後' : '音訊在前'}  think=${opt.think}`
  : '';
console.log(`mode=${opt.mode}  base=${base}  set=${setDir}  (${items.length} 筆)${variant}\n`);

let sum = 0;
let n = 0;
let audioSecs = 0;
let wallSecs = 0;

for (const { file, ref } of items) {
  let wav;
  try {
    wav = readFileSync(join(setDir, file));
  } catch {
    console.log(`[${file}] 找不到檔案，略過\n`);
    continue;
  }

  const secs = wavSeconds(wav);
  const t0 = performance.now();

  try {
    const { text, model, timings } = await transcribe(wav);
    const s = (performance.now() - t0) / 1000;
    const e = cer(ref, text);

    sum += e;
    n++;
    audioSecs += secs;
    wallSecs += s;

    console.log(`[${file}] 音訊 ${secs.toFixed(1)}s｜耗時 ${s.toFixed(2)}s｜CER ${(e * 100).toFixed(1)}%${model ? `｜${model}` : ''}`);
    console.log(`  期望：${ref}`);
    console.log(`  輸出：${text}`);
    if (timings) {
      console.log(`  llama.cpp：prompt ${timings.prompt_n} tok，生成 ${timings.predicted_n} tok / ${timings.predicted_per_second?.toFixed(1)} tok/s`);
    }
  } catch (err) {
    console.log(`[${file}] 失敗：${err.message}`);
  }

  console.log();
}

if (n) {
  console.log(`平均 CER：${((sum / n) * 100).toFixed(1)}%（${n} 筆）｜總音訊 ${audioSecs.toFixed(1)}s，總耗時 ${wallSecs.toFixed(1)}s`);
} else {
  process.exitCode = 1;
}
