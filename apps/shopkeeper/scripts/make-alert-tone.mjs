// Writes assets/sounds/new_order.wav, the new-order alarm (#507): YGo's own tone, so there is no licence to check.
// Run `node scripts/make-alert-tone.mjs` from apps/shopkeeper after changing it, and commit the file it writes.
// A low-high beep pair twice, then a pause, three times over: about 5 s, well under the 30 s an iPhone plays.
import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { stdout } from "node:process";
import { URL } from "node:url";

const rate = 22_050;
const beep = 0.18;
const gap = 0.07;
const pause = 0.6;
const tones = [880, 1320];
const rounds = 3;
const fade = 0.01;

const samples = [];
const silence = (seconds) => samples.push(...new Array(Math.round(seconds * rate)).fill(0));
for (let round = 0; round < rounds; round++) {
  for (let twice = 0; twice < 2; twice++) {
    for (const hz of tones) {
      const count = Math.round(beep * rate);
      for (let i = 0; i < count; i++) {
        const t = i / rate;
        // A short fade in and out, so no beep clicks.
        const envelope = Math.min(1, t / fade, (beep - t) / fade);
        samples.push(Math.sin(2 * Math.PI * hz * t) * envelope * 0.8);
      }
      silence(gap);
    }
  }
  silence(pause);
}

// 16-bit mono PCM: what both Android and iPhone play as a notification sound.
const data = Buffer.alloc(samples.length * 2);
samples.forEach((sample, i) => data.writeInt16LE(Math.round(sample * 32_767), i * 2));
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(rate, 24);
header.writeUInt32LE(rate * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(data.length, 40);
writeFileSync(new URL("../assets/sounds/new_order.wav", import.meta.url), Buffer.concat([header, data]));
stdout.write(`new_order.wav: ${samples.length / rate} s\n`);
