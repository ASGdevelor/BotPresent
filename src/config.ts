import { readFileSync } from "node:fs";
import path from "node:path";

export interface Config {
  botToken: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // TOKEN поддерживается для совместимости с уже созданными .env-файлами.
  let botToken = env.BOT_TOKEN?.trim() || env.TOKEN?.trim();
  // При локальном запуске из BotPresent поддерживаем общий .env в корне проекта.
  if (!botToken && env === process.env) {
    try {
      const content = readFileSync(path.resolve(import.meta.dir, "..", "..", ".env"), "utf8");
      const values = Object.fromEntries(content.split(/\r?\n/).map((line) => {
        const match = line.match(/^\s*([A-Z_][A-Z\d_]*)\s*=\s*(.*?)\s*$/i);
        return match ? [match[1], match[2]?.replace(/^(?:"(.*)"|'(.*)')$/, "$1$2") ?? ""] : [];
      }).filter((item) => item.length === 2));
      botToken = values.BOT_TOKEN?.trim() || values.TOKEN?.trim();
    } catch {
      // Отсутствие родительского .env обрабатывается общей ошибкой ниже.
    }
  }

  if (!botToken) {
    throw new Error(
      "Не задан BOT_TOKEN. Скопируйте .env.example в .env и добавьте токен от @BotFather.",
    );
  }

  return { botToken };
}
