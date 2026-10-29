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
| **Audio mode**: transcribes what is spoken | Click the toolbar icon → **Listen to this tab** | OpenAI API key, about $0.006/min |

The site's own subtitles are hidden while the overlay is on, so you only see the overlay. You can change this in Settings. For other sites that draw their own subtitles, add their CSS selector under **Settings → Extra subtitle selectors**.

All translation is **offline**. Each word is looked up in the bundled CC-CEDICT dictionary (125,000 entries, simplified and traditional).

## Using it

- **Hover** a word: shows every reading and meaning, and pauses the video (you can turn this off). Move away and the video resumes.
- **Click** a word or press **S** while hovering: save or unsave it. Saved words are underlined in gold.
- **Alt+P**: show or hide the overlay.
- Toolbar popup: toggle pinyin and English, start or stop audio mode, open **Saved words**.
- **Saved words** page: filter, delete, and **Export CSV** (Simplified, Traditional, Pinyin, Meaning, Sentence, Source). In Anki, use File → Import.

## Limitations

- When a site makes the `<video>` element *itself* fullscreen (plain HTML5 players with native controls), nothing can be drawn over it. Most streaming sites make a wrapper element fullscreen instead, which works.
- Audio mode shows lines 3–8 s after they are spoken, and its accuracy depends on the speech-to-text model. Clips with no sound are not sent.
- Words are split using a dictionary and the readings are dictionary-based, so occasional mis-splits or the less common reading of a character can happen.
- Netflix and other sites change their caption markup from time to time. If captions stop being picked up, add the new selector in Settings.

## Development

```bash
node --test test/*.test.mjs   # segmentation, pinyin, transcription request tests
node test/e2e.mjs [outdir]    # loads the extension in Chromium (Playwright) and checks the overlay
node scripts/build-dict.mjs   # rebuild data/cedict.json from the latest CC-CEDICT
```

Dictionary data: [CC-CEDICT](https://cc-cedict.org), licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
