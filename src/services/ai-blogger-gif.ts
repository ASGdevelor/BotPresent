import { readFileSync } from "node:fs";

const REALISTIC_AVATAR_FILES = [
  new URL("../assets/ai-bloggers/role-1.gif", import.meta.url),
  new URL("../assets/ai-bloggers/role-2.gif", import.meta.url),
  new URL("../assets/ai-bloggers/role-3.gif", import.meta.url),
] as const;

const avatarData = REALISTIC_AVATAR_FILES.map(file =>
  `data:image/gif;base64,${readFileSync(file).toString("base64")}`
);

function topicHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/**
 * Возвращает полноцветный talking-head GIF, подготовленный из AI-видео.
 * Публичный интерфейс и место вызова не меняются: HTML и PDF получают тот же
 * data URI, что и раньше, но без процедурной 16-цветной пиксельной отрисовки.
 */
export function createAiBloggerGifDataUri(primary: string, secondary: string, topic: string, role: number): string {
  const offset = topicHash(`${primary}|${secondary}|${topic}`) % avatarData.length;
  return avatarData[(Math.abs(role) + offset) % avatarData.length]!;
}
