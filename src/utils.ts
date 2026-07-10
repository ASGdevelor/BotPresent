const MAX_TOPIC_LENGTH = 160;

export function normalizeTopic(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_TOPIC_LENGTH);
}

export function safeFilePart(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return normalized || "result";
}

export function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()<>#+\-.!|])/g, "\\$1");
}

