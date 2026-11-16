// Google 官方建議的 Gemma 4 ASR prompt 格式
// sourceLang 是語音的語言，預設與輸出語言相同（官方範本的寫法，實測最穩定）；只在評估比較時另外指定
export const asrPrompt = (lang: string, sourceLang: string = lang): string =>
  `Transcribe the following speech segment in ${sourceLang} into ${lang} text.\n\n` +
  `Follow these specific instructions for formatting the answer:\n` +
  `* Only output the transcription, with no newlines.\n` +
  `* When transcribing numbers, write the digits, i.e. write 1.7 and not one point seven, and write 3 instead of three.`;
