import { createBot } from "./bot";
import { loadConfig } from "./config";

async function main(): Promise<void> {
  try {
    const config = loadConfig();
    const bot = createBot(config.botToken);

    process.once("SIGINT", () => bot.stop());
    process.once("SIGTERM", () => bot.stop());
    bot.hears("id", async (ctx) => {
      await ctx.reply(`Ваш id ${ctx.from?.id ?? "не определён"}`);
    });
    await bot.api.setMyCommands([
      { command: "start", description: "Запустить бота" },
      { command: "menu", description: "Показать главное меню" },
      { command: "cancel", description: "Отменить текущее действие" },
      { command: "history", description: "Выгрузить историю сообщений" },
      { command: "clear_history", description: "Удалить историю сообщений" },
    ]);

    await bot.start({
      onStart: (botInfo) => console.log(`Bot @${botInfo.username} started`),
    });
  } catch (error) {
    console.error("Bot startup failed", error);
    process.exitCode = 1;
  }
}

await main();
