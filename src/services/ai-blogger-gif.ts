const GIF_WIDTH = 180;
const GIF_HEIGHT = 320;

type Rgb = [number, number, number];

function parseHex(value: string, fallback: Rgb): Rgb {
  const match = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return fallback;
  const hex = match[1]!;
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
}

function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  return a.map((value, index) => Math.round(value + (b[index]! - value) * amount)) as Rgb;
}

function palette(primary: string, secondary: string): Rgb[] {
  const brand = parseHex(primary, [43, 106, 74]);
  const accent = parseHex(secondary, [198, 232, 209]);
  return [
    mix(brand, [8, 12, 18], .58), brand, accent, mix(brand, [255, 255, 255], .72),
    [244, 199, 166], [208, 143, 105], [56, 36, 34], [126, 78, 52],
    [255, 255, 255], mix(accent, [255, 255, 255], .4), [18, 24, 32], [235, 105, 120],
    mix(brand, [0, 0, 0], .3), mix(brand, [255, 255, 255], .48), [221, 226, 232], [4, 7, 11],
  ];
}

function topicHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function drawRect(frame: Uint8Array, x: number, y: number, width: number, height: number, color: number): void {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(GIF_WIDTH, Math.ceil(x + width));
  const bottom = Math.min(GIF_HEIGHT, Math.ceil(y + height));
  for (let row = top; row < bottom; row += 1) frame.fill(color, row * GIF_WIDTH + left, row * GIF_WIDTH + right);
}

function drawEllipse(frame: Uint8Array, cx: number, cy: number, rx: number, ry: number, color: number): void {
  const left = Math.max(0, Math.floor(cx - rx));
  const right = Math.min(GIF_WIDTH - 1, Math.ceil(cx + rx));
  const top = Math.max(0, Math.floor(cy - ry));
  const bottom = Math.min(GIF_HEIGHT - 1, Math.ceil(cy + ry));
  for (let y = top; y <= bottom; y += 1) {
    const dy = (y - cy) / ry;
    const span = rx * Math.sqrt(Math.max(0, 1 - dy * dy));
    drawRect(frame, cx - span, y, span * 2 + 1, 1, color);
  }
}

function drawRoundRect(frame: Uint8Array, x: number, y: number, width: number, height: number, radius: number, color: number): void {
  drawRect(frame, x + radius, y, width - radius * 2, height, color);
  drawRect(frame, x, y + radius, width, height - radius * 2, color);
  drawEllipse(frame, x + radius, y + radius, radius, radius, color);
  drawEllipse(frame, x + width - radius, y + radius, radius, radius, color);
  drawEllipse(frame, x + radius, y + height - radius, radius, radius, color);
  drawEllipse(frame, x + width - radius, y + height - radius, radius, radius, color);
}

function createFrame(role: number, phase: number, seed: number): Uint8Array {
  const frame = new Uint8Array(GIF_WIDTH * GIF_HEIGHT);
  frame.fill(0);

  // Branded studio backdrop. The topic hash changes the light panels and floating UI.
  for (let y = 0; y < GIF_HEIGHT; y += 1) {
    const color = y < 92 ? 12 : y < 220 ? 1 : 0;
    drawRect(frame, 0, y, GIF_WIDTH, 1, color);
  }
  const drift = ((phase * 5) + (seed % 17)) % 34;
  drawEllipse(frame, 28 + drift, 52, 35, 35, 13);
  drawEllipse(frame, 158 - drift / 2, 104, 28, 28, 2);
  drawRoundRect(frame, 13, 18, 52, 14, 7, 3);
  drawRect(frame, 22, 23, 31, 4, 1);
  drawRoundRect(frame, 118, 33 + (phase % 3) * 3, 46, 30, 9, 9);
  drawRect(frame, 126, 42 + (phase % 3) * 3, 28, 4, 1);
  drawRect(frame, 126, 50 + (phase % 3) * 3, 18, 3, 13);

  const blink = phase === 2 || phase === 3;
  const speaking = phase % 3;
  const skin = role === 2 ? 7 : role === 1 ? 5 : 4;
  const hair = role === 0 ? 6 : role === 1 ? 15 : 10;
  const faceX = role === 1 ? 88 : role === 2 ? 94 : 90;

  // Torso, neck and shoulders.
  drawEllipse(frame, faceX, 286, role === 1 ? 76 : 72, 70, role === 2 ? 2 : 13);
  drawRoundRect(frame, faceX - 17, 198, 34, 45, 12, skin);
  drawEllipse(frame, faceX, 155, role === 1 ? 49 : 52, role === 1 ? 61 : 66, hair);
  if (role === 0) drawRect(frame, faceX - 49, 147, 18, 91, hair);
  if (role === 2) drawRect(frame, faceX + 34, 147, 18, 82, hair);

  // Face and role-specific hair silhouette.
  drawEllipse(frame, faceX, 159, 40, 51, skin);
  drawEllipse(frame, faceX - 39, 161, 6, 11, skin);
  drawEllipse(frame, faceX + 39, 161, 6, 11, skin);
  if (role === 1) {
    drawRect(frame, faceX - 40, 111, 80, 21, hair);
    drawEllipse(frame, faceX - 27, 119, 20, 18, hair);
  } else {
    drawEllipse(frame, faceX - 14, 116, 34, 20, hair);
    drawEllipse(frame, faceX + 24, 123, 25, 22, hair);
  }

  // Eyes blink and mouth moves so the output reads as an animated presenter.
  if (blink) {
    drawRect(frame, faceX - 24, 157, 15, 2, 15);
    drawRect(frame, faceX + 9, 157, 15, 2, 15);
  } else {
    drawEllipse(frame, faceX - 17, 157, 4, 5, 15);
    drawEllipse(frame, faceX + 17, 157, 4, 5, 15);
    drawRect(frame, faceX - 18, 155, 2, 1, 8);
    drawRect(frame, faceX + 16, 155, 2, 1, 8);
  }
  drawRect(frame, faceX - 2, 166, 4, 10, 5);
  if (speaking === 0) drawRoundRect(frame, faceX - 10, 184, 20, 4, 2, 11);
  else if (speaking === 1) drawEllipse(frame, faceX, 186, 8, 5, 11);
  else drawEllipse(frame, faceX, 186, 7, 8, 15);

  // Branded mic/button and animated reaction counters.
  drawEllipse(frame, 145, 257, 18, 18, 8);
  drawEllipse(frame, 145, 257, 11, 11, 1);
  drawRect(frame, 143, 251, 4, 10, 8);
  drawRoundRect(frame, 12, 265 - (phase % 2) * 4, 48, 35, 10, 10);
  drawEllipse(frame, 24, 278 - (phase % 2) * 4, 5, 5, 11);
  drawRect(frame, 34, 274 - (phase % 2) * 4, 17, 4, 8);
  drawRect(frame, 34, 282 - (phase % 2) * 4, 11, 3, 14);
  return frame;
}

function encodeLzw(pixels: Uint8Array, minimumCodeSize: number): Uint8Array {
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  const codeSize = minimumCodeSize + 1;
  const bytes: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  const writeCode = (code: number): void => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };
  // A short clear-code interval keeps the stream at a fixed five-bit code size.
  // It is slightly larger than dictionary LZW, but deterministic and accepted by
  // browsers, PDF renderers and strict GIF decoders without a native dependency.
  for (let offset = 0; offset < pixels.length; offset += 10) {
    writeCode(clearCode);
    const end = Math.min(pixels.length, offset + 10);
    for (let index = offset; index < end; index += 1) writeCode(pixels[index]!);
  }
  writeCode(endCode);
  if (bitCount > 0) bytes.push(bitBuffer & 0xff);
  return Uint8Array.from(bytes);
}

function pushWord(bytes: number[], value: number): void {
  bytes.push(value & 0xff, (value >>> 8) & 0xff);
}

function encodeGif(frames: Uint8Array[], colors: Rgb[]): Uint8Array {
  const bytes: number[] = [...Buffer.from("GIF89a", "ascii")];
  pushWord(bytes, GIF_WIDTH);
  pushWord(bytes, GIF_HEIGHT);
  bytes.push(0xf3, 0, 0); // Global 16-colour palette.
  for (const color of colors) bytes.push(...color);
  bytes.push(0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0", "ascii"), 0x03, 0x01, 0x00, 0x00, 0x00);
  for (const frame of frames) {
    bytes.push(0x21, 0xf9, 0x04, 0x04, 0x0a, 0x00, 0x00, 0x00);
    bytes.push(0x2c);
    pushWord(bytes, 0); pushWord(bytes, 0); pushWord(bytes, GIF_WIDTH); pushWord(bytes, GIF_HEIGHT);
    bytes.push(0x00, 0x04);
    const image = encodeLzw(frame, 4);
    for (let offset = 0; offset < image.length; offset += 255) {
      const block = image.slice(offset, offset + 255);
      bytes.push(block.length, ...block);
    }
    bytes.push(0x00);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

export function createAiBloggerGifDataUri(primary: string, secondary: string, topic: string, role: number): string {
  const seed = topicHash(`${topic}|${role}`);
  const frames = Array.from({ length: 6 }, (_, phase) => createFrame(role % 3, phase, seed));
  const gif = encodeGif(frames, palette(primary, secondary));
  return `data:image/gif;base64,${Buffer.from(gif).toString("base64")}`;
}
