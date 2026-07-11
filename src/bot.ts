import { Bot, GrammyError, HttpError, InputFile, type Context } from "grammy";
import { BUTTONS, MENU_TEXT } from "./constants";
import { createMainKeyboard, createPresentationKeyboard } from "./keyboard";
import {
  isCompleteLeadCriteria,
  LEAD_PROMPTS,
  nextLeadField,
  normalizeLeadAnswer,
} from "./lead-form";
import {
  formatLeadCsv,
  generateLeads,
  LeadGenerationError,
} from "./services/lead-generation";
import { formatHistoryReport, MessageHistory } from "./services/message-history";
import { createWebsitePresentation, listPresentations, type PresentationRecord } from "./services/presentation";
import type { LeadCriteria, LeadField } from "./types/lead";
import { normalizeTopic, safeFilePart } from "./utils";

interface PresentationSession {
  kind: "presentation";
  action: "create" | "edit";
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
    try {
      await next();
    } catch (error) {
      console.error("Update handling failed", error);
      await reply(ctx, "Не удалось обработать сообщение. Попробуйте ещё раз или откройте /menu.", {
        reply_markup: createMainKeyboard(),
      }).catch(() => undefined);
    }
  });

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

  bot.hears(BUTTONS.presentations, async (ctx) => {
    if (!ctx.from) return;
    sessions.delete(sessionKey(ctx.chat.id, ctx.from.id));
    await reply(ctx, "Выберите действие с презентациями.", { reply_markup: createPresentationKeyboard() });
  });

  bot.hears(BUTTONS.back, async (ctx) => {
    if (ctx.from) sessions.delete(sessionKey(ctx.chat.id, ctx.from.id));
    await showMenu(ctx);
  });

  bot.hears(BUTTONS.createPresentation, async (ctx) => {
    if (!ctx.from) return;
    sessions.set(sessionKey(ctx.chat.id, ctx.from.id), { kind: "presentation", action: "create" });
    await reply(ctx, "Отправьте адрес сайта компании. Я соберу факты с сайта и создам index.html и PDF. Для отмены: /cancel");
  });

  const presentationListText = (records: PresentationRecord[]) => records.length === 0
    ? "У вас пока нет презентаций."
    : records.map((record) => `${record.id} — ${record.companyName} — ${record.website}`).join("\n");

  bot.hears(BUTTONS.myPresentations, async (ctx) => {
    if (!ctx.from) return;
    const records = await listPresentations(ctx.from.id);
    await reply(ctx, presentationListText(records), { reply_markup: createPresentationKeyboard() });
    for (const record of records.slice(0, 10)) {
      await ctx.replyWithDocument(new InputFile(record.htmlPath, `${safeFilePart(record.companyName)}-index.html`), {
        caption: record.companyName,
      });
      if (record.pdfPath) await ctx.replyWithDocument(new InputFile(record.pdfPath, `${safeFilePart(record.companyName)}.pdf`));
    }
  });

  bot.hears(BUTTONS.editPresentation, async (ctx) => {
    if (!ctx.from) return;
    const records = await listPresentations(ctx.from.id);
    if (records.length === 0) {
      await reply(ctx, "У вас пока нет презентаций.", { reply_markup: createPresentationKeyboard() });
      return;
    }
    sessions.set(sessionKey(ctx.chat.id, ctx.from.id), { kind: "presentation", action: "edit" });
    await reply(ctx, `${presentationListText(records)}\n\nОтправьте ID презентации. Чтобы заменить сайт, отправьте: ID адрес-сайта`);
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
      const input = normalizeTopic(ctx.message.text);
      if (input.length < 3) {
        await reply(ctx, "Адрес или ID слишком короткий.");
        return;
      }
      let website = input;
      let recordId: string | undefined;
      if (session.action === "edit") {
        const [id, replacementWebsite] = input.split(/\s+/, 2);
        const records = await listPresentations(ctx.from.id);
        const record = records.find((item) => item.id === id);
        if (!record) {
          await reply(ctx, "Презентация с таким ID не найдена. Проверьте ID и отправьте ещё раз.");
          return;
        }
        recordId = record.id;
        website = replacementWebsite || record.website;
      }

      await reply(ctx, "Собираю реальные данные с сайта и формирую HTML/PDF…");
      await ctx.api.sendChatAction(ctx.chat.id, "upload_document");

      try {
        const record = await createWebsitePresentation(ctx.from.id, website, recordId);
        sessions.delete(key);
        await ctx.replyWithDocument(new InputFile(record.htmlPath, `${safeFilePart(record.companyName)}-index.html`), {
          caption: `${record.companyName} — HTML`,
          reply_markup: createPresentationKeyboard(),
        });
        if (record.pdfPath) {
          await ctx.replyWithDocument(new InputFile(record.pdfPath, `${safeFilePart(record.companyName)}.pdf`), {
            caption: `${record.companyName} — PDF`,
          });
        } else {
          await reply(ctx, "HTML готов. PDF не создан: для локальной печати PDF нужен Microsoft Edge или Chrome.", {
            reply_markup: createPresentationKeyboard(),
          });
        }
        recordHistory(ctx, "bot", `[Презентация: ${record.id}; сайт: ${record.website}]`);
      } catch (error) {
        console.error("Presentation generation failed", error);
        await reply(ctx, "Не удалось получить данные сайта или создать презентацию. Проверьте адрес и повторите.", {
          reply_markup: createPresentationKeyboard(),
        });
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
      const report = formatLeadCsv(result);
      const filename = `leads-${safeFilePart(criteria.whoToFind)}.csv`;
      const withContacts = result.leads.filter((lead) => (lead.contacts?.length ?? lead.telegramContacts.length) > 0).length;
      await ctx.replyWithDocument(new InputFile(Buffer.from(report, "utf8"), filename), {
        caption: result.leads.length > 0
          ? `Компаний: ${result.leads.length}; с контактами: ${withContacts}.`
          : "Подходящие сайты не найдены или недоступны. Подробности есть в файле.",
        reply_markup: createMainKeyboard(),
      });
      recordHistory(ctx, "bot", `[Список лидов: ${filename}; компаний: ${result.leads.length}]`);
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
