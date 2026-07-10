import { unlink } from "node:fs/promises";
import { Bot, GrammyError, HttpError, InputFile, type Context } from "grammy";
import { BUTTONS, MENU_TEXT, type Action } from "./constants";
import { createMainKeyboard } from "./keyboard";
import { createPresentation } from "./services/presentation";
import { conductResearch } from "./services/research";
import { normalizeTopic, safeFilePart } from "./utils";

const pendingActions = new Map<string, Action>();

function sessionKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  const showMenu = async (ctx: Context) => {
    await ctx.reply(MENU_TEXT, { reply_markup: createMainKeyboard() });
  };

  bot.command("start", async (ctx) => {
    if (ctx.chat && ctx.from) pendingActions.delete(sessionKey(ctx.chat.id, ctx.from.id));
    await showMenu(ctx);
  });

  bot.command("menu", showMenu);

  bot.command("cancel", async (ctx) => {
    if (ctx.chat && ctx.from) pendingActions.delete(sessionKey(ctx.chat.id, ctx.from.id));
    await ctx.reply("Текущее действие отменено.", { reply_markup: createMainKeyboard() });
  });

  bot.hears(BUTTONS.presentation, async (ctx) => {
    if (!ctx.from) return;
    pendingActions.set(sessionKey(ctx.chat.id, ctx.from.id), "presentation");
    await ctx.reply("Напишите тему презентации одним сообщением. Для отмены: /cancel");
  });

  bot.hears(BUTTONS.research, async (ctx) => {
    if (!ctx.from) return;
    pendingActions.set(sessionKey(ctx.chat.id, ctx.from.id), "research");
    await ctx.reply("Напишите тему исследования одним сообщением. Для отмены: /cancel");
  });

  bot.on("message:text", async (ctx) => {
    const key = sessionKey(ctx.chat.id, ctx.from.id);
    const action = pendingActions.get(key);

    if (!action) {
      await ctx.reply("Сначала выберите действие.", { reply_markup: createMainKeyboard() });
      return;
    }

    const topic = normalizeTopic(ctx.message.text);
    if (topic.length < 3) {
      await ctx.reply("Тема слишком короткая. Напишите хотя бы 3 символа.");
      return;
    }

    pendingActions.delete(key);

    if (action === "presentation") {
      await ctx.reply("Готовлю презентацию…");
      await ctx.api.sendChatAction(ctx.chat.id, "upload_document");
      let generatedPath: string | undefined;

      try {
        const file = await createPresentation(topic);
        generatedPath = file.path;
        await ctx.replyWithDocument(new InputFile(file.path, file.name), {
          caption: "Готово! Это базовая структура — дополните её фактами и адаптируйте под аудиторию.",
          reply_markup: createMainKeyboard(),
        });
      } catch (error) {
        console.error("Presentation generation failed", error);
        await ctx.reply("Не удалось создать презентацию. Попробуйте ещё раз позже.", {
          reply_markup: createMainKeyboard(),
        });
      } finally {
        if (generatedPath) await unlink(generatedPath).catch(() => undefined);
      }

      return;
    }

    await ctx.reply("Ищу и собираю материалы…");
    await ctx.api.sendChatAction(ctx.chat.id, "upload_document");

    try {
      const report = await conductResearch(topic);
      const filename = `research-${safeFilePart(topic)}.md`;
      await ctx.replyWithDocument(new InputFile(Buffer.from(report, "utf8"), filename), {
        caption: "Исследование готово. Важные выводы перепроверьте по первичным источникам.",
        reply_markup: createMainKeyboard(),
      });
    } catch (error) {
      console.error("Research failed", error);
      await ctx.reply("Не удалось собрать исследование. Уточните тему или попробуйте позже.", {
        reply_markup: createMainKeyboard(),
      });
    }
  });

  bot.catch((error) => {
    const cause = error.error;
    if (cause instanceof GrammyError) {
      console.error("Telegram API error:", cause.description);
    } else if (cause instanceof HttpError) {
      console.error("Network error:", cause);
    } else {
      console.error("Unexpected bot error:", cause);
    }
  });

  return bot;
}
