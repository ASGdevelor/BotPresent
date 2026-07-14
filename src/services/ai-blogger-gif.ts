import { readFileSync } from "node:fs";

type Rgb = [number, number, number];
type Hsl = [number, number, number];

const REALISTIC_AVATAR_FILES = [
  new URL("../assets/ai-bloggers/role-1.gif", import.meta.url),
  new URL("../assets/ai-bloggers/role-2.gif", import.meta.url),
  new URL("../assets/ai-bloggers/role-3.gif", import.meta.url),
] as const;

const avatarBuffers = REALISTIC_AVATAR_FILES.map(file => new Uint8Array(readFileSync(file)));

const BUSINESS_PALETTES: Array<{ pattern: RegExp; clothing: Rgb; background: Rgb }> = [
  { pattern: /медиц|клиник|аптек|фарма|здоров|стомат|beauty|космет/i, clothing: [28, 132, 111], background: [215, 243, 235] },
  { pattern: /финанс|банк|инвест|страх|юрист|право|legal/i, clothing: [39, 66, 112], background: [225, 232, 244] },
  { pattern: /технолог|software|digital|it\b|saas|автоматизац|интеграц/i, clothing: [47, 94, 177], background: [218, 235, 251] },
  { pattern: /образован|школ|универс|курс|обучен/i, clothing: [92, 68, 164], background: [235, 229, 250] },
  { pattern: /ресторан|еда|food|напит|агро|ферм|продукт/i, clothing: [175, 91, 35], background: [250, 232, 211] },
  { pattern: /строит|недвиж|производ|завод|логист|транспорт/i, clothing: [72, 91, 106], background: [226, 232, 235] },
  { pattern: /мода|fashion|одежд|дизайн|салон|украшен/i, clothing: [165, 58, 112], background: [250, 224, 238] },
];

function topicHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function parseHex(value: string, fallback: Rgb): Rgb {
  const match = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return fallback;
  const hex = match[1]!;
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
}

function mix(first: Rgb, second: Rgb, amount: number): Rgb {
  return first.map((value, index) => Math.round(value + (second[index]! - value) * amount)) as Rgb;
}

function rgbToHsl([red, green, blue]: Rgb): Hsl {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = lightness > .5 ? delta / (2 - max - min) : delta / (max + min);
  const hue = max === r
    ? ((g - b) / delta + (g < b ? 6 : 0)) / 6
    : max === g
      ? ((b - r) / delta + 2) / 6
      : ((r - g) / delta + 4) / 6;
  return [hue * 360, saturation, lightness];
}

function hueToRgb(p: number, q: number, value: number): number {
  let t = value;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb([hue, saturation, lightness]: Hsl): Rgb {
  const h = ((hue % 360) + 360) % 360 / 360;
  if (saturation === 0) {
    const gray = Math.round(lightness * 255);
    return [gray, gray, gray];
  }
  const q = lightness < .5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)]
    .map(value => Math.round(clamp(value) * 255)) as Rgb;
}

function varyColour(color: Rgb, seed: number, role: number): Rgb {
  const [hue, saturation, lightness] = rgbToHsl(color);
  const hueShift = ((seed >>> (role * 4)) % 41) - 20 + role * 7;
  const saturationShift = (((seed >>> 9) % 13) - 6) / 100;
  const lightnessShift = (((seed >>> 16) % 11) - 5) / 100;
  return hslToRgb([
    hue + hueShift,
    clamp(saturation + saturationShift, .28, .88),
    clamp(lightness + lightnessShift, .22, .78),
  ]);
}

function resolveBusinessColours(primary: string, secondary: string, topic: string, role: number, seed: number): {
  clothing: Rgb;
  background: Rgb;
} {
  const business = BUSINESS_PALETTES.find(item => item.pattern.test(topic));
  const brandPrimary = parseHex(primary, [43, 106, 74]);
  const brandSecondary = parseHex(secondary, [224, 239, 229]);
  const clothingBase = mix(business?.clothing ?? brandPrimary, brandPrimary, .48);
  const backgroundBase = mix(business?.background ?? brandSecondary, brandSecondary, .58);
  return {
    clothing: varyColour(clothingBase, seed, role),
    background: varyColour(backgroundBase, seed ^ 0x9e3779b9, role + 1),
  };
}

function transformPalette(data: Uint8Array, offset: number, length: number, clothing: Rgb, background: Rgb, seed: number): void {
  const neutralTint = .08 + (seed % 9) / 100;
  for (let index = offset; index + 2 < offset + length; index += 3) {
    const original: Rgb = [data[index]!, data[index + 1]!, data[index + 2]!];
    const [hue, saturation, lightness] = rgbToHsl(original);
    const greenSurface = hue >= 65 && hue <= 175 && saturation >= .16;
    const lightBackdrop = lightness >= .68 && saturation <= .3;
    const darkBackdrop = lightness <= .22 && saturation <= .22;
    let next = original;
    if (greenSurface) {
      const target = rgbToHsl(clothing);
      next = hslToRgb([
        target[0],
        clamp(target[1] * .82 + saturation * .18, .24, .9),
        clamp(lightness * .86 + target[2] * .14, .08, .9),
      ]);
    } else if (lightBackdrop) {
      next = mix(original, background, neutralTint + (lightness - .68) * .15);
    } else if (darkBackdrop) {
      next = mix(original, clothing, .08);
    }
    data[index] = next[0];
    data[index + 1] = next[1];
    data[index + 2] = next[2];
  }
}

function paletteLength(packed: number): number {
  return 3 * (1 << ((packed & 0x07) + 1));
}

function skipSubBlocks(data: Uint8Array, start: number): number {
  let offset = start;
  while (offset < data.length) {
    const size = data[offset++] ?? 0;
    if (size === 0) break;
    offset += size;
  }
  return offset;
}

function recolourGif(source: Uint8Array, clothing: Rgb, background: Rgb, seed: number): Uint8Array {
  const data = Uint8Array.from(source);
  if (Buffer.from(data.subarray(0, 6)).toString("ascii") !== "GIF89a") return data;
  const globalPacked = data[10] ?? 0;
  let offset = 13;
  if ((globalPacked & 0x80) !== 0) {
    const length = paletteLength(globalPacked);
    transformPalette(data, offset, length, clothing, background, seed);
    offset += length;
  }
  while (offset < data.length) {
    const marker = data[offset++] ?? 0;
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      offset += 1;
      offset = skipSubBlocks(data, offset);
      continue;
    }
    if (marker !== 0x2c || offset + 9 > data.length) break;
    const packed = data[offset + 8] ?? 0;
    offset += 9;
    if ((packed & 0x80) !== 0) {
      const length = paletteLength(packed);
      transformPalette(data, offset, length, clothing, background, seed);
      offset += length;
    }
    offset += 1;
    offset = skipSubBlocks(data, offset);
  }
  return data;
}

/**
 * Возвращает полноцветный talking-head GIF. Реалистичные базовые кадры не
 * перерисовываются: меняются только палитры одежды, декора и светлого фона.
 * Topic содержит постоянный seed презентации, поэтому разные презентации имеют
 * разные варианты, а повторное редактирование одного ID сохраняет их вид.
 */
export function createAiBloggerGifDataUri(primary: string, secondary: string, topic: string, role: number): string {
  const normalizedRole = ((role % avatarBuffers.length) + avatarBuffers.length) % avatarBuffers.length;
  const seed = topicHash(`${primary}|${secondary}|${topic}|${normalizedRole}`);
  const colours = resolveBusinessColours(primary, secondary, topic, normalizedRole, seed);
  const gif = recolourGif(avatarBuffers[normalizedRole]!, colours.clothing, colours.background, seed);
  return `data:image/gif;base64,${Buffer.from(gif).toString("base64")}`;
}
