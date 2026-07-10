export interface Config {
  botToken: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // TOKEN поддерживается для совместимости с уже созданными .env-файлами.
  const botToken = env.BOT_TOKEN?.trim() || env.TOKEN?.trim();

  if (!botToken) {
    throw new Error(
      "Не задан BOT_TOKEN. Скопируйте .env.example в .env и добавьте токен от @BotFather.",
    );
  }

  return { botToken };
}

