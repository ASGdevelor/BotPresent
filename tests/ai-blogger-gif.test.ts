import { describe, expect, test } from "bun:test";
import { createAiBloggerGifDataUri } from "../src/services/ai-blogger-gif";

function frameCount(gif: Uint8Array): number {
  const globalPalette = gif[10] ?? 0;
  let offset = 13;
  if ((globalPalette & 0x80) !== 0) offset += 3 * (1 << ((globalPalette & 0x07) + 1));
  let frames = 0;
  const skipBlocks = (): void => {
    while (offset < gif.length) {
      const size = gif[offset++] ?? 0;
      if (size === 0) return;
      offset += size;
    }
  };
  while (offset < gif.length) {
    const marker = gif[offset++] ?? 0;
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      offset += 1;
      skipBlocks();
      continue;
    }
    if (marker !== 0x2c) break;
    frames += 1;
    const packed = gif[offset + 8] ?? 0;
    offset += 9;
    if ((packed & 0x80) !== 0) offset += 3 * (1 << ((packed & 0x07) + 1));
    offset += 1;
    skipBlocks();
  }
  return frames;
}

describe("AI-blogger GIF", () => {
  test("uses high-resolution full-colour AI-video avatars", () => {
    const first = createAiBloggerGifDataUri("#6d4cc3", "#ebe4ff", "Медицина", 0);
    const second = createAiBloggerGifDataUri("#6d4cc3", "#ebe4ff", "Медицина", 1);
    const gif = Buffer.from(first.split(",", 2)[1]!, "base64");

    expect(first).toStartWith("data:image/gif;base64,");
    expect(first).not.toBe(second);
    expect(gif.subarray(0, 6).toString("ascii")).toBe("GIF89a");
    expect(gif.readUInt16LE(6)).toBe(256);
    expect(gif.readUInt16LE(8)).toBe(454);
    expect(frameCount(gif)).toBe(15);
    expect(gif.length).toBeGreaterThan(800_000);
  });
});
