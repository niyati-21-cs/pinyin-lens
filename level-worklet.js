// Runs on the audio thread: reports the loudness of every 50 ms of tab audio.
// Unlike timers in the (hidden) offscreen document, this never gets throttled.
class LevelMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sum = 0;
    this.count = 0;
    this.block = Math.round(sampleRate * 0.05);
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (const v of channel) this.sum += v * v;
      this.count += channel.length;
    } else {
      this.count += 128; // no input: silence
    }
    if (this.count >= this.block) {
      this.port.postMessage(Math.sqrt(this.sum / this.count));
      this.sum = 0;
      this.count = 0;
    }
    return true;
  }
}

registerProcessor('pl-level', LevelMeter);
