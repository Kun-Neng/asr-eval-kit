<#
.SYNOPSIS
  用 Windows 內建的語音（TTS）把文字轉成 WAV，當作語音轉文字的測試音訊。

.DESCRIPTION
  使用 Windows Runtime 的 OneCore 語音（比 System.Speech 只能用的 Hanhan Desktop 更自然）。
  繁中可用：Yating（女）、Zhiwei（男）、Hanhan（女）。
  其他語音可在「設定 → 時間與語言 → 語音 → 新增語音」安裝。

.EXAMPLE
  .\tools\make-test-audio.ps1 -List
.EXAMPLE
  .\tools\make-test-audio.ps1 -Text '今天下午三點開會' -Voice Yating -Out .\samples\meeting.wav
.EXAMPLE
  .\tools\make-test-audio.ps1 -TextFile .\samples\script.txt -Voice Zhiwei -Rate 0.9
#>
param(
  [string]$Text,
  # 讀取 UTF-8 文字檔，每一行產生一個 WAV（檔名 <Out 去掉副檔名>-01.wav …）
  [string]$TextFile,
  [string]$Voice = 'Yating',
  [string]$Out = '.\samples\test.wav',
  # 語速：0.5 ~ 6.0，1.0 為正常
  [double]$Rate = 1.0,
  [switch]$List
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesisStream, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]

# PowerShell 5.1 沒有 await：把 WinRT IAsyncOperation<T> 轉成 .NET Task 再同步等待
$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
  Select-Object -First 1
function Wait-WinRT($operation, [Type]$resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$allVoices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices

if ($List) {
  $allVoices | Sort-Object Language, DisplayName |
    Select-Object DisplayName, Language, Gender | Format-Table -AutoSize
  return
}

$lines = if ($TextFile) {
  Get-Content -Path $TextFile -Encoding UTF8 | Where-Object { $_.Trim() }
} elseif ($Text) {
  , $Text
} else {
  throw '請用 -Text 或 -TextFile 指定要朗讀的內容（-List 可列出可用語音）'
}

$selected = $allVoices | Where-Object { $_.DisplayName -match $Voice } | Select-Object -First 1
if (-not $selected) { throw "找不到語音 '$Voice'，請用 -List 查看可用語音" }

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$synth.Voice = $selected
$synth.Options.SpeakingRate = $Rate

$outFull = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
New-Item -ItemType Directory -Force -Path (Split-Path $outFull) | Out-Null
$base = [IO.Path]::Combine((Split-Path $outFull), [IO.Path]::GetFileNameWithoutExtension($outFull))

$i = 0
foreach ($line in $lines) {
  $i++
  $path = if ($lines.Count -gt 1) { '{0}-{1:D2}.wav' -f $base, $i } else { $outFull }
  $stream = Wait-WinRT ($synth.SynthesizeTextToStreamAsync($line)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $src = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
  $dst = [IO.File]::Create($path)
  try { $src.CopyTo($dst) } finally { $dst.Dispose(); $src.Dispose(); $stream.Dispose() }

  # 讀 WAV header 顯示格式（OneCore 通常輸出 16-bit mono，取樣率依語音而定）
  $h = [IO.File]::ReadAllBytes($path)
  $rate = [BitConverter]::ToUInt32($h, 24); $ch = [BitConverter]::ToUInt16($h, 22); $bits = [BitConverter]::ToUInt16($h, 34)
  $secs = ($h.Length - 44) / ($rate * $ch * $bits / 8)
  Write-Host ('{0}  [{1}, {2}Hz {3}ch {4}bit, {5:N1}s]  {6}' -f $path, $selected.DisplayName, $rate, $ch, $bits, $secs, $line)
}
