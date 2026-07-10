import { unlink } from "node:fs/promises";
import { Bot, GrammyError, HttpError, InputFile, type Context } from "grammy";
import { BUTTONS, MENU_TEXT } from "./constants";
import { createMainKeyboard } from "./keyboard";
import {
  isCompleteLeadCriteria,
  LEAD_PROMPTS,
  nextLeadField,
  normalizeLeadAnswer,
} from "./lead-form";
import {
  formatLeadReport,
  generateLeads,
  LeadGenerationError,
} from "./services/lead-generation";
import { formatHistoryReport, MessageHistory } from "./services/message-history";
import { createPresentation } from "./services/presentation";
import type { LeadCriteria, LeadField } from "./types/lead";
import { normalizeTopic, safeFilePart } from "./utils";

interface PresentationSession {
  kind: "presentation";
}

interface LeadGenerationSession {
  kind: "leadGeneration";
  currentField: LeadField;
  answers: Partial<LeadCriteria>;
}

type UserSession = PresentationSession | LeadGenerationSession;

const sessions = new Map<string, UserSession>();

type ReplyOptions = Parameters<Context["reply"]>[1];

function sessionKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

export function createBot(token: string, history = new MessageHistory()): Bot {
  const bot = new Bot(token);

  const recordHistory = (
    ctx: Context,
    direction: "user" | "bot" | "system",
    text: string,
  ): void => {
    if (!ctx.chat || !ctx.from) return;
    try {
      history.record(ctx.chat.id, ctx.from.id, direction, text);
    } catch (error) {
      console.error("Message history write failed", error);
    }
  };

  const reply = async (ctx: Context, text: string, options?: ReplyOptions) => {
    const message = await ctx.reply(text, options);
    recordHistory(ctx, "bot", text);
    return message;
  };

  bot.use(async (ctx, next) => {
    if (ctx.message?.text) recordHistory(ctx, "user", ctx.message.text);
    await next();
  });

  const showMenu = async (ctx: Context) => {
    await reply(ctx, MENU_TEXT, { reply_markup: createMainKeyboard() });
  };

  bot.command("start", async (ctx) => {
    if (ctx.chat && ctx.from) sessions.delete(sessionKey(ctx.chat.id, ctx.from.id));
    await showMenu(ctx);
  });

  bot.command("menu", showMenu);

  bot.command("cancel", async (ctx) => {
    if (ctx.chat && ctx.from) sessions.delete(sessionKey(ctx.chat.id, ctx.from.id));
    await reply(ctx, "Текущее действие отменено.", { reply_markup: createMainKeyboard() });
  });

  bot.command("history", async (ctx) => {
    if (!ctx.from) return;
    if (ctx.chat.type !== "private") {
      await reply(ctx, "Историю можно выгрузить только в личном чате с ботом.");
      return;
    }

    try {
      const report = formatHistoryReport(history.list(ctx.chat.id, ctx.from.id, 100));
      await ctx.replyWithDocument(new InputFile(Buffer.from(report, "utf8"), "bot-history.md"), {
        caption: "Последние сообщения в этом чате. Для удаления используйте /clear_history.",
      });
      recordHistory(ctx, "bot", "[Документ: bot-history.md]");
    } catch (error) {
      console.error("Message history export failed", error);
      await reply(ctx, "Не удалось выгрузить историю. Попробуйте позже.");
    }
  });

  bot.command("clear_history", async (ctx) => {
    if (!ctx.from) return;
    try {
      history.clear(ctx.chat.id, ctx.from.id);
      // Подтверждение намеренно не записывается: после очистки история должна остаться пустой.
      await ctx.reply("История сообщений удалена.", { reply_markup: createMainKeyboard() });
    } catch (error) {
      console.error("Message history clear failed", error);
      await reply(ctx, "Не удалось удалить историю. Попробуйте позже.");
    }
  });

  bot.hears(BUTTONS.presentation, async (ctx) => {
    if (!ctx.from) return;
    sessions.set(sessionKey(ctx.chat.id, ctx.from.id), { kind: "presentation" });
    await reply(ctx, "Напишите тему презентации одним сообщением. Для отмены: /cancel");
  });

  bot.hears(BUTTONS.leadGeneration, async (ctx) => {
    if (!ctx.from) return;
    sessions.set(sessionKey(ctx.chat.id, ctx.from.id), {
      kind: "leadGeneration",
      currentField: "whoCanBuy",
      answers: {},
    });
    await reply(ctx, [
      "Запускаем поиск потенциальных клиентов.",
      "Отвечайте на пять вопросов по одному. Для отмены: /cancel",
      "",
      LEAD_PROMPTS.whoCanBuy,
    ].join("\n"));
  });

  bot.on("message:text", async (ctx) => {
    const key = sessionKey(ctx.chat.id, ctx.from.id);
    const session = sessions.get(key);

    if (!session) {
      await reply(ctx, "Сначала выберите действие.", { reply_markup: createMainKeyboard() });
      return;
    }

    if (session.kind === "presentation") {
      const topic = normalizeTopic(ctx.message.text);
      if (topic.length < 3) {
        await reply(ctx, "Тема слишком короткая. Напишите хотя бы 3 символа.");
        return;
      }

      sessions.delete(key);
      await reply(ctx, "Готовлю презентацию…");
      await ctx.api.sendChatAction(ctx.chat.id, "upload_document");
      let generatedPath: string | undefined;

      try {
        const file = await createPresentation(topic);
        generatedPath = file.path;
        await ctx.replyWithDocument(new InputFile(file.path, file.name), {
          caption: "Готово! Это базовая структура — дополните её фактами и адаптируйте под аудиторию.",
          reply_markup: createMainKeyboard(),
        });
        recordHistory(ctx, "bot", `[Документ PowerPoint: ${file.name}]`);
      } catch (error) {
        console.error("Presentation generation failed", error);
        await reply(ctx, "Не удалось создать презентацию. Попробуйте ещё раз позже.", {
          reply_markup: createMainKeyboard(),
        });
      } finally {
        if (generatedPath) await unlink(generatedPath).catch(() => undefined);
      }

      return;
    }

    const field = session.currentField;
    const answer = normalizeLeadAnswer(ctx.message.text);
    const canSkipExclusions = field === "exclusions" && /^(?:-|нет)$/i.test(answer);
    if (answer.length < 3 && !canSkipExclusions) {
      await reply(ctx, "Ответ слишком короткий. Добавьте немного деталей или отправьте /cancel.");
      return;
    }

    session.answers[field] = answer;
    const nextField = nextLeadField(field);
    if (nextField) {
      session.currentField = nextField;
      sessions.set(key, session);
      await reply(ctx, LEAD_PROMPTS[nextField]);
      return;
    }

    if (!isCompleteLeadCriteria(session.answers)) {
      sessions.delete(key);
      await reply(ctx, "Не все параметры заполнены. Запустите лидогенерацию заново.", {
        reply_markup: createMainKeyboard(),
      });
      return;
    }

    sessions.delete(key);
    const criteria = session.answers;
    await reply(ctx, "Ищу компании и проверяю публичные Telegram-контакты. Это может занять до минуты…");
    await ctx.api.sendChatAction(ctx.chat.id, "upload_document");

    try {
      const result = await generateLeads(criteria);
      const report = formatLeadReport(result);
      const filename = `leads-${safeFilePart(criteria.whoToFind)}.md`;
      const withContacts = result.leads.filter((lead) => lead.telegramContacts.length > 0).length;
      await ctx.replyWithDocument(new InputFile(Buffer.from(report, "utf8"), filename), {
        caption: result.leads.length > 0
          ? `Готово! Компаний: ${result.leads.length}; с Telegram: ${withContacts}; без Telegram: ${result.leads.length - withContacts}.`
          : "Подходящие сайты не найдены или недоступны. Подробности есть в файле.",
        reply_markup: createMainKeyboard(),
      });
      recordHistory(ctx, "bot", `[Отчёт лидогенерации: ${filename}; компаний: ${result.leads.length}]`);
    } catch (error) {
      console.error("Lead generation failed", error);
      const message = error instanceof LeadGenerationError
        ? error.message
        : "Не удалось выполнить лидогенерацию. Уточните параметры или попробуйте позже.";
      await reply(ctx, message, {
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
