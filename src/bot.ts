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

function sessionKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  const showMenu = async (ctx: Context) => {
    await ctx.reply(MENU_TEXT, { reply_markup: createMainKeyboard() });
  };

  bot.command("start", async (ctx) => {
    if (ctx.chat && ctx.from) sessions.delete(sessionKey(ctx.chat.id, ctx.from.id));
    await showMenu(ctx);
  });

  bot.command("menu", showMenu);

  bot.command("cancel", async (ctx) => {
    if (ctx.chat && ctx.from) sessions.delete(sessionKey(ctx.chat.id, ctx.from.id));
    await ctx.reply("Текущее действие отменено.", { reply_markup: createMainKeyboard() });
  });

  bot.hears(BUTTONS.presentation, async (ctx) => {
    if (!ctx.from) return;
    sessions.set(sessionKey(ctx.chat.id, ctx.from.id), { kind: "presentation" });
    await ctx.reply("Напишите тему презентации одним сообщением. Для отмены: /cancel");
  });

  bot.hears(BUTTONS.leadGeneration, async (ctx) => {
    if (!ctx.from) return;
    sessions.set(sessionKey(ctx.chat.id, ctx.from.id), {
      kind: "leadGeneration",
      currentField: "whoCanBuy",
      answers: {},
    });
    await ctx.reply([
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
      await ctx.reply("Сначала выберите действие.", { reply_markup: createMainKeyboard() });
      return;
    }

    if (session.kind === "presentation") {
      const topic = normalizeTopic(ctx.message.text);
      if (topic.length < 3) {
        await ctx.reply("Тема слишком короткая. Напишите хотя бы 3 символа.");
        return;
      }

      sessions.delete(key);
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

    const field = session.currentField;
    const answer = normalizeLeadAnswer(ctx.message.text);
    const canSkipExclusions = field === "exclusions" && /^(?:-|нет)$/i.test(answer);
    if (answer.length < 3 && !canSkipExclusions) {
      await ctx.reply("Ответ слишком короткий. Добавьте немного деталей или отправьте /cancel.");
      return;
    }

    session.answers[field] = answer;
    const nextField = nextLeadField(field);
    if (nextField) {
      session.currentField = nextField;
      sessions.set(key, session);
      await ctx.reply(LEAD_PROMPTS[nextField]);
      return;
    }

    if (!isCompleteLeadCriteria(session.answers)) {
      sessions.delete(key);
      await ctx.reply("Не все параметры заполнены. Запустите лидогенерацию заново.", {
        reply_markup: createMainKeyboard(),
      });
      return;
    }

    sessions.delete(key);
    const criteria = session.answers;
    await ctx.reply("Ищу компании и проверяю публичные Telegram-контакты. Это может занять до минуты…");
    await ctx.api.sendChatAction(ctx.chat.id, "upload_document");

    try {
      const result = await generateLeads(criteria);
      const report = formatLeadReport(result);
      const filename = `leads-${safeFilePart(criteria.whoToFind)}.md`;
      await ctx.replyWithDocument(new InputFile(Buffer.from(report, "utf8"), filename), {
        caption: result.leads.length > 0
          ? `Готово! Найдено компаний с публичным Telegram-контактом: ${result.leads.length}.`
          : "По заданным критериям публичные Telegram-контакты не найдены. Рекомендации есть в файле.",
        reply_markup: createMainKeyboard(),
      });
    } catch (error) {
      console.error("Lead generation failed", error);
      const message = error instanceof LeadGenerationError
        ? error.message
        : "Не удалось выполнить лидогенерацию. Уточните параметры или попробуйте позже.";
      await ctx.reply(message, {
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
