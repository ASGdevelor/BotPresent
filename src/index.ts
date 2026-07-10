import { createBot } from "./bot";
import { loadConfig } from "./config";

const config = loadConfig();
const bot = createBot(config.botToken);

await bot.api.setMyCommands([
  { command: "start", description: "Запустить бота" },
  { command: "menu", description: "Показать главное меню" },
  { command: "cancel", description: "Отменить текущее действие" },
]);

bot.start({
  onStart: (botInfo) => console.log(`Bot @${botInfo.username} started`),
});

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

