# Pinyin Lens

A Brave/Chrome extension for learning Chinese from shows. While any HTML `<video>` plays, it shows the current line with **pinyin above every word** and a **short English meaning below it**. Hover a word for the full dictionary entry, then click it to **save** it to your word list. You can export the list to Anki or Pleco.

## Install (Brave)

1. Unzip `pinyin-lens.zip` somewhere permanent.
2. Open `brave://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the unzipped `pinyin-lens` folder.
4. Pin the red **拼** icon to the toolbar.

Chrome and Edge work the same way: use `chrome://extensions` or `edge://extensions`.

## Where the Chinese text comes from

| Source | When | Cost |
|---|---|---|
| The video's Chinese subtitle track (`<track>`, srclang `zh`) | Automatic | Free, offline |
| Site captions on YouTube, Netflix, Disney+ and Prime Video | Automatic; turn on Chinese subtitles in the player | Free, offline |
| **Audio mode**: transcribes what is spoken | Click the toolbar icon → **Listen to this tab** | **Free**: runs Whisper on your computer. A cloud API is optional |

The site's own subtitles are hidden while the overlay is on, so you only see the overlay. You can change this in Settings. For other sites that draw their own subtitles, add their CSS selector under **Settings → Extra subtitle selectors**.

### Audio mode engines

- **On-device (default, free, no account).** Whisper runs inside the browser using [transformers.js](https://github.com/huggingface/transformers.js). On first use the browser downloads the model from Hugging Face (tiny ~40 MB, base ~80 MB, small ~250 MB) and caches it, so later starts are quick. It uses your GPU (WebGPU) when Brave allows it, otherwise the CPU. Download progress shows on the video. If lines fall behind, choose a smaller model in Settings. If Hugging Face is blocked where you are, set the model server to `https://hf-mirror.com/`.
- **Where the model is stored.** In Brave's cache storage, under the name `transformers-cache` and belonging to the extension (not in Downloads, and websites can't read it). On disk it's inside your Brave profile (assuming the usual `Default` profile), with scrambled file names:
  - macOS: `~/Library/Application Support/BraveSoftware/Brave-Browser/Default/Service Worker/CacheStorage/`
  - Windows: `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data\Default\Service Worker\CacheStorage\`
  - Linux: `~/.config/BraveSoftware/Brave-Browser/Default/Service Worker/CacheStorage/`

  It's about 80 MB for the default model on the CPU. The GPU uses a different version of the model, which can be somewhat bigger, and each model you pick in Settings is stored separately. To see or delete it, open the extension's Settings page, press F12 and go to **Application → Cache storage → transformers-cache**. To delete it, run `caches.delete('transformers-cache')` in the Console tab there. Removing the extension also deletes it. If it's deleted, the model downloads again the next time you use audio mode.
- **Readable pacing.** Transcripts arrive unevenly, so each line stays on screen long enough to read: about 1.5 s plus 0.3 s per character, up to 7 s. A very short line (a word or two) is added onto the line already showing instead of replacing it. The reading time only counts while the video plays, so **pausing the video pauses the subtitles**. Lines that arrive in the meantime wait their turn. If more than 3 pile up, the oldest are skipped so you don't fall far behind.
- **Cloud API (optional).** OpenAI (about $0.006/min with Whisper) or any OpenAI-compatible service, such as Groq's free tier with `whisper-large-v3`. Set the engine, key, base URL and model in Settings.

All translation is **offline**. Each word is looked up in the bundled CC-CEDICT dictionary (125,000 entries, simplified and traditional).

## Using it

- **Hover** a word: shows every reading and meaning, and pauses the video (you can turn this off). Move away and the video resumes.
- **Click** a word or press **S** while hovering: save or unsave it. Saved words are underlined in gold.
- **Alt+P**: show or hide the overlay.
- Toolbar popup: toggle pinyin and English, start or stop audio mode, open **Saved words**.
- **Saved words** page: filter, delete, and **Export CSV** (Simplified, Traditional, Pinyin, Meaning, Sentence, Source). In Anki, use File → Import.

## Limitations

- When a site makes the `<video>` element *itself* fullscreen (plain HTML5 players with native controls), nothing can be drawn over it. Most streaming sites make a wrapper element fullscreen instead, which works.
- Audio mode shows lines a few seconds after they are spoken, and its accuracy depends on the speech-to-text model. Whisper tiny/base make more mistakes on Chinese than the cloud models. Clips with no sound are skipped. If your computer can't keep up on-device, some audio is skipped rather than lagging further behind.
- Words are split using a dictionary and the readings are dictionary-based, so occasional mis-splits or the less common reading of a character can happen.
- Netflix and other sites change their caption markup from time to time. If captions stop being picked up, add the new selector in Settings.

## Development

```bash
npm test                          # everything below
node --test test/*.test.mjs       # segmentation, pinyin, transcription request tests
node test/e2e.mjs [outdir]        # overlay: subtitles, captions, saving, settings, fullscreen, iframes
node test/e2e-audio.mjs [outdir]  # audio mode: tab capture, phrase splitting, both engines (mock servers)
node scripts/build-dict.mjs       # rebuild data/cedict.json from the latest CC-CEDICT
```

The e2e tests need Playwright with Chromium and ffmpeg. They use local mock servers, so no real model or API is called.

`vendor/` holds transformers.js 3.8.1 and the ONNX Runtime WebAssembly build (Apache-2.0 / MIT), bundled because extensions can't load remote code.

Dictionary data: [CC-CEDICT](https://cc-cedict.org), licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
