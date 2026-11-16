# asr-eval-kit

評估本機語音轉文字（ASR）準確度的工具組：產生測試音檔、串接成長音檔，再對 OpenAI 相容的推論服務（llama.cpp、vLLM）逐檔轉錄並計算 CER（字元錯誤率）。

目前的 prompt 是 Gemma 4 官方的語音辨識範本（`prompts/asr.prompt.ts`）。

## 需求

- Node.js 22.18 以上（直接 import `.ts` 的 prompt，不需要安裝任何套件）
- 已啟動的推論服務，例如 llama.cpp：

  ```bash
  llama-server -hf google/gemma-4-E4B-it-qat-q4_0-gguf -hff gemma-4-E4B_q4_0-it.gguf -c 8192 -np 1 --port 8080
  ```

- `tools/concat-audio.mjs`：需要 ffmpeg 在 PATH 上
- `tools/make-test-audio.ps1`：需要 Windows（使用內建的 OneCore 語音），已在 Windows PowerShell 5.1 測試。若執行原則擋下腳本，改用 `powershell -ExecutionPolicy Bypass -File .\tools\make-test-audio.ps1 ...` 執行

## 目錄結構

```
asr-eval-kit/
├── prompts/asr.prompt.ts      # ASR prompt
├── tools/
│   ├── eval-cer.mjs           # 逐檔轉錄並計算 CER
│   ├── make-test-audio.ps1    # 用 Windows TTS 產生測試 WAV
│   └── concat-audio.mjs       # 串接音檔，製作長音檔測試
└── samples/eval/refs.tsv      # 評估集的正確文字（WAV 不進版控）
```

## 準備評估集

評估集是一個資料夾，裡面放 WAV 音檔與 `refs.tsv`。`refs.tsv` 為 UTF-8，每行是檔名與正確文字，中間用 Tab 分隔，`#` 開頭為註解：

```tsv
# 數字寫阿拉伯數字（ASR prompt 要求模型輸出數字）
tts-hanhan-01.wav	今天天氣很好，我們下午3點在台北車站見面。
```

音檔的限制：

- 只能用 WAV。`eval-cer.mjs` 會讀 WAV header 計算長度，並以 WAV 格式送出；其他格式請先轉檔（見下方的真人錄音）。
- 要符合推論服務的限制。以 Gemma 4 為例，單段不能超過 30 秒，建議用 16 kHz 單聲道 WAV。

`samples/eval/refs.tsv` 是四句繁體中文，WAV 不進版控，要自己產生或錄製。用 Windows TTS 產生時，把四句寫進文字檔（每行一句）：

```powershell
.\tools\make-test-audio.ps1 -List                                                        # 列出可用語音
.\tools\make-test-audio.ps1 -TextFile .\script.txt -Voice Hanhan -Out .\samples\eval\tts-hanhan.wav
# 產生 tts-hanhan-01.wav、tts-hanhan-02.wav …
```

真人錄音建議另外建一個資料夾（例如 `samples/my-voice/`），放入 WAV 與這個資料夾自己的 `refs.tsv`，再用 `--set` 指定。錄音不是 WAV 時（例如 m4a、webm），用 `concat-audio.mjs` 只給一個輸入，就能轉成 16 kHz 單聲道 WAV：

```bash
node tools/concat-audio.mjs rec.m4a --out samples/my-voice/rec-01.wav
```

## 計算 CER

`eval-cer.mjs` 有兩種模式，用 `--mode` 切換：

- `direct`（預設）：直接呼叫推論服務的 `/chat/completions`，prompt 由 `prompts/asr.prompt.ts` 組成。
- `backend`：經過你自己的後端，見[評估自己的後端](#評估自己的後端)。

以下指令都在專案根目錄執行：

```bash
node tools/eval-cer.mjs                                    # 預設連到 http://127.0.0.1:8080/v1
node tools/eval-cer.mjs --set samples/my-voice             # 其他評估集
node tools/eval-cer.mjs --base http://gpu-host:8000/v1     # 其他推論服務
```

每段會印出音訊長度、耗時、CER、期望文字與模型輸出，最後印出平均 CER。比對前會去掉標點與空白，並把「臺」統一成「台」。

### 比較不同設定

以下參數每次只改一項設定，用來比較它對準確度的影響。不加參數就是建議的設定。

| 參數 | 改動 | 預設 |
|------|------|------|
| `--source-lang <語言>` | prompt 裡語音的語言（`in <語言> into ...`），改成與輸出語言不同 | 與 `--lang` 相同 |
| `--audio-last` | 音訊改放在文字之後 | 音訊在文字之前 |
| `--think` | 開啟思考模式 | 關閉 |
| `--lang <語言>` | 輸出的語言 | `Traditional Chinese` |

```bash
node tools/eval-cer.mjs --source-lang "Japanese"
node tools/eval-cer.mjs --audio-last
node tools/eval-cer.mjs --think
```

### 評估自己的後端

`--mode backend` 會把音檔改送到你自己的後端，評估「前端 → 後端 → 推論服務」整條路徑。後端位址一定要用 `--base` 指定：

```bash
node tools/eval-cer.mjs --mode backend --base http://127.0.0.1:3000
```

後端需要實作以下介面：

| 項目 | 內容 |
|------|------|
| 請求 | `POST {base}/api/transcribe` ，`multipart/form-data` |
| 欄位 `audio` | 音檔，檔名 `eval.wav` ，類型 `audio/wav` ；內容就是評估集裡的 WAV ，不會轉檔或切段 |
| 欄位 `lang` | 輸出語言，即 `--lang` 的值，預設 `Traditional Chinese` |
| 成功回應 | HTTP 2xx ，JSON `{ "text": "轉錄結果" }` |
| 失敗回應 | 非 2xx 的狀態碼；回應的 JSON 會原樣印在該段的錯誤訊息中，例如 `{ "error": "missing audio" }` |

注意事項：

- prompt 與推論參數由後端決定。`--source-lang` 與 `--audio-last` 不能搭配使用（會直接報錯）；`--think` 不會報錯，但也不會生效。要和 direct 模式比較時，請確認後端用的 prompt 與 `prompts/asr.prompt.ts` 一致。
- 評估集的音檔一樣要符合[準備評估集](#準備評估集)的限制，後端模式不會幫忙轉檔或切段。
- 耗時包含後端的處理時間；後端回應不含 llama.cpp 的 token 統計，所以不會顯示 token 數。

### 環境變數

以下兩個只在 direct 模式使用：

- `VLLM_API_KEY`：推論服務有設 API key 時使用。
- `VLLM_MODEL`：模型名稱，預設 `gemma-4-E4B-it`。vLLM 需要正確的名稱，llama.cpp 只載入一個模型，會忽略這個值。

程式不會自動讀取 `.env`。把變數寫在 `.env`（已排除在版控外）時，用 `--env-file` 載入：

```bash
node --env-file=.env tools/eval-cer.mjs
```

## 長音檔測試

`eval-cer.mjs` 會把每個音檔整段送出，超過推論服務上限（Gemma 4 為 30 秒）的長音檔無法用 direct 模式評估。長音檔是用來測試會自己切段的流程，例如你的後端或前端。

把多個音檔依序串成一個 16 kHz 單聲道 WAV，可以重複數次：

```bash
node tools/concat-audio.mjs samples/eval --repeat 3 --out samples/tts-hanhan-x3.wav   # 4 段 × 3 次，約 81 秒
node tools/concat-audio.mjs samples/a.wav samples/b.mp3 --out samples/mixed.wav
```

要計算長音檔的 CER 時，把它放進獨立的評估集資料夾，`refs.tsv` 那一行的正確文字是各段文字依序串起來（重複幾次就串幾次），再用 `--mode backend` 評估。

> 音檔請放在 `samples/` 底下。 `.gitignore` 只排除這個資料夾裡的音檔，放在其他位置會被納入版控。
