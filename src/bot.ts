import { Bot, GrammyError, HttpError, InputFile, type Context } from "grammy";
import { BUTTONS, MENU_TEXT } from "./constants";
import { createAiBloggersKeyboard, createLeadResultKeyboard, createMainKeyboard, createPresentationKeyboard } from "./keyboard";
import {
  isCompleteLeadCriteria,
  LEAD_PROMPTS,
  nextLeadField,
  normalizeLeadAnswer,
} from "./lead-form";
import {
  formatLeadHtml,
  generateLeads,
  LeadGenerationError,
} from "./services/lead-generation";
import { formatHistoryReport, MessageHistory } from "./services/message-history";
import {
  createWebsitePresentation,
  listPresentations,
  presentationThemeList,
  PRESENTATION_FONTS,
  type PresentationEditOptions,
  type PresentationRecord,
} from "./services/presentation";
import type { CompanyLead, LeadCriteria, LeadField } from "./types/lead";
import { normalizeTopic, safeFilePart } from "./utils";

interface PresentationSession {
  kind: "presentation";
  action: "create" | "edit";
  step?: "website" | "aiMode";
  website?: string;
  editOptions?: PresentationEditOptions;
}

interface LeadGenerationSession {
  kind: "leadGeneration";
  currentField: LeadField;
  answers: Partial<LeadCriteria>;
}

type UserSession = PresentationSession | LeadGenerationSession;

const sessions = new Map<string, UserSession>();
const lastLeadResults = new Map<string, CompanyLead[]>();

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

  const updateProgress = (ctx: Context, messageId: number, prefix: string) => {
    let lastPercent = -1;
    return async (percent: number, stage: string) => {
      const normalized = Math.max(0, Math.min(100, Math.round(percent)));
      if (normalized === lastPercent) return;
      lastPercent = normalized;
      await ctx.api.editMessageText(ctx.chat!.id, messageId, `${prefix}: ${normalized}%\n${stage}`).catch(() => undefined);
    };
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
    sessions.set(sessionKey(ctx.chat.id, ctx.from.id), { kind: "presentation", action: "create", step: "website" });
    await reply(ctx, [
      "Отправьте адрес сайта компании. Я соберу название, описание, направления, изображения, фирменные цвета и проверяемые цифры для графиков.",
      "Формат: https://site.ru тема 1 (если тему не указать, используется схема 1).",
      "",
      presentationThemeList(),
      "",
      "После создания можно отдельно менять тему, шрифт, четыре изображения и текст каждого из восьми разделов презентации.",
      "Для отмены: /cancel",
    ].join("\n"));
  });

  const presentationListText = (records: PresentationRecord[]) => records.length === 0
    ? "У вас пока нет презентаций."
    : records.map((record) => `${record.id} — ${record.companyName} — ${record.website} — тема ${record.preferences?.themeId ?? "1"}, ${record.preferences?.fontFamily ?? "Open Sans"}, AI-блогеры: ${record.preferences?.sellAiBloggers === false ? "нет" : "да"}`).join("\n");

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
    await reply(ctx, [
      presentationListText(records),
      "",
      "Команды редактирования (каждая начинается с ID презентации):",
      "ID тема 1",
      "ID шрифт Montserrat",
      "ID картинка 2 https://site.ru/image.jpg",
      "ID AI-блогеры да",
      "ID AI-блогеры нет",
      "ID страница 3 Новый текст для страницы",
      "ID страница 3 очистить",
      "ID сайт https://new-site.ru",
      "",
      "Цветовые схемы:",
      presentationThemeList(),
      "",
      `Шрифты: ${PRESENTATION_FONTS.join(", ")}`,
    ].join("\n"));
  });

  bot.hears(BUTTONS.presentationsFromLeads, async (ctx) => {
    if (!ctx.from) return;
    const key = sessionKey(ctx.chat.id, ctx.from.id);
    const leads = lastLeadResults.get(key) ?? [];
    if (leads.length === 0) {
      await reply(ctx, "Сначала выполните лидогенерацию. После получения Word-отчёта найденные сайты будут доступны для пакетной презентации.", {
        reply_markup: createMainKeyboard(),
      });
      return;
    }

    const status = await reply(ctx, `Презентации для ${leads.length} сайтов: 0%\nПодготовка`);
    const setProgress = updateProgress(ctx, status.message_id, `Презентации для ${leads.length} сайтов`);
    let completed = 0;
    let failed = 0;
    let withoutPdf = 0;
    for (const [index, lead] of leads.entries()) {
      try {
        const record = await createWebsitePresentation(ctx.from.id, lead.website, undefined, async (local, stage) => {
          const overall = ((index + local / 100) / leads.length) * 100;
          await setProgress(overall, `${index + 1}/${leads.length}: ${lead.companyName} — ${stage}`);
        }, { leadRelevance: lead.relevance });
        history.recordPresentationResult(ctx.chat.id, ctx.from.id, {
          id: record.id,
          companyName: record.companyName,
          website: record.website,
          sources: record.sources ?? [record.website],
          researchStatus: record.researchStatus ?? "not-found",
        });
        await ctx.replyWithDocument(new InputFile(record.htmlPath, `${safeFilePart(record.companyName)}-index.html`), {
          caption: `${index + 1}/${leads.length} · ${record.companyName} · HTML`,
        });
        if (record.pdfPath) {
          await ctx.replyWithDocument(new InputFile(record.pdfPath, `${safeFilePart(record.companyName)}.pdf`), {
            caption: `${record.companyName} · PDF`,
          });
        } else withoutPdf += 1;
        completed += 1;
      } catch (error) {
        console.error(`Batch presentation failed for ${lead.website}`, error);
        failed += 1;
      }
    }
    await setProgress(100, `Готово: ${completed}; ошибок: ${failed}; без PDF: ${withoutPdf}`);
    await reply(ctx, `Создано презентаций: ${completed}. Не создано: ${failed}. Без PDF: ${withoutPdf}.`, {
      reply_markup: createPresentationKeyboard(),
    });
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
      "Как проходит лидогенерация: выполняю расширенный поиск в Google → собираю уникальные сайты компаний выбранной сферы → проверяю страну и домен → анализирую главную, услуги, руководство и контакты → показываю точные и частичные совпадения. Похожие компании исключаются.",
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
      if (input.length < 3 && !(session.action === "create" && session.step === "aiMode")) {
        await reply(ctx, "Адрес или ID слишком короткий.");
        return;
      }
      let website = session.website ?? input;
      let recordId: string | undefined;
      let editOptions: PresentationEditOptions | undefined = session.editOptions;
      if (session.action === "create") {
        if (session.step === "aiMode") {
          const yes = input === BUTTONS.aiBloggersYes || /^(?:да|yes|прода[её]м|ai)$/i.test(input);
          const no = input === BUTTONS.aiBloggersNo || /^(?:нет|no|обычная|без ai)$/i.test(input);
          if (!yes && !no) {
            await reply(ctx, "Выберите режим: продаём AI-блогеров — да или нет.", { reply_markup: createAiBloggersKeyboard() });
            return;
          }
          if (!session.website) {
            session.step = "website";
            sessions.set(key, session);
            await reply(ctx, "Адрес сайта не сохранён. Отправьте URL ещё раз.");
            return;
          }
          website = session.website;
          editOptions = { ...(session.editOptions ?? {}), sellAiBloggers: yes };
        } else {
          const creation = input.match(/^(\S+?)(?:\s+тема\s+(\d{1,2}))?$/i);
          if (!creation) {
            await reply(ctx, "Отправьте ссылку в формате: https://site.ru тема 1");
            return;
          }
          website = creation[1]!;
          session.step = "aiMode";
          session.website = website;
          session.editOptions = creation[2] ? { themeId: creation[2] } : {};
          sessions.set(key, session);
          await reply(ctx, "Продаём этой компании AI-блогеров?", { reply_markup: createAiBloggersKeyboard() });
          return;
        }
      }
      if (session.action === "edit") {
        const [id = "", ...commandParts] = input.split(/\s+/);
        const records = await listPresentations(ctx.from.id);
        const record = records.find((item) => item.id === id);
        if (!record) {
          await reply(ctx, "Презентация с таким ID не найдена. Проверьте ID и отправьте ещё раз.");
          return;
        }
        recordId = record.id;
        website = record.website;
        const command = commandParts.join(" ").trim();
        const theme = command.match(/^тема\s+(\d{1,2})$/i);
        const font = command.match(/^шрифт\s+(.+)$/i);
        const image = command.match(/^картинка\s+([1-4])\s+(https?:\/\/\S+)$/i);
        const aiBloggers = command.match(/^ai-блогеры\s+(да|нет)$/i);
        const page = command.match(/^страница\s+([1-8])(?:\s+([\s\S]*))?$/i);
        const site = command.match(/^сайт\s+(https?:\/\/\S+)$/i);
        if (!command) {
          editOptions = {};
        } else if (theme) {
          editOptions = { themeId: theme[1] };
        } else if (font) {
          editOptions = { fontFamily: font[1] };
        } else if (image) {
          editOptions = { productImage: { index: Number(image[1]), url: image[2]! } };
        } else if (aiBloggers) {
          editOptions = { sellAiBloggers: aiBloggers[1]!.toLocaleLowerCase("ru") === "да" };
        } else if (page) {
          const text = /^(?:очистить|удалить|-)$/i.test(page[2]?.trim() ?? "") ? "" : (page[2] ?? "");
          editOptions = { pageEdit: { page: Number(page[1]), text } };
        } else if (site) {
          website = site[1]!;
        } else if (/^https?:\/\/\S+$/i.test(command)) {
          website = command;
        } else {
          await reply(ctx, "Не понял правку. Используйте: ID тема N, ID шрифт Название, ID картинка N URL, ID AI-блогеры да/нет, ID страница N текст или ID сайт URL.");
          return;
        }
      }

      const status = await reply(ctx, "Презентация: 0%\nНачинаю обработку сайта");
      const setProgress = updateProgress(ctx, status.message_id, "Презентация");
      await ctx.api.sendChatAction(ctx.chat.id, "upload_document");

      try {
        const record = await createWebsitePresentation(ctx.from.id, website, recordId, setProgress, undefined, editOptions);
        history.recordPresentationResult(ctx.chat.id, ctx.from.id, {
          id: record.id,
          companyName: record.companyName,
          website: record.website,
          sources: record.sources ?? [record.website],
          researchStatus: record.researchStatus ?? "not-found",
        });
        if (session.action === "create") sessions.delete(key);
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
        if (session.action === "edit") {
          await reply(ctx, `Правка применена. Можно отправить следующую команду для ${record.id}. Тема: ${record.preferences?.themeId}; шрифт: ${record.preferences?.fontFamily}.`, {
            reply_markup: createPresentationKeyboard(),
          });
        }
        recordHistory(ctx, "bot", `[Презентация: ${record.id}; сайт: ${record.website}]`);
      } catch (error) {
        console.error("Presentation generation failed", error);
        const details = error instanceof Error ? ` ${error.message}` : "";
        await ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          `Презентация не создана\nОшибка:${details || " неизвестная ошибка"}`,
        ).catch(() => undefined);
        await reply(ctx, `Не удалось получить данные сайта или создать презентацию.${details}`, {
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
    await reply(ctx, "Выполняю расширенный поиск в Google, проверяю сайты компаний и публичные контакты. Из-за глубокого поиска это может занять несколько минут…");
    await ctx.api.sendChatAction(ctx.chat.id, "upload_document");

    try {
      const result = await generateLeads(criteria);
      const eligibleLeads = result.leads.filter((lead) => lead.matchKind !== "similar");
      const filteredResult = { ...result, leads: eligibleLeads };
      lastLeadResults.set(key, eligibleLeads);
      const report = formatLeadHtml(filteredResult);
      const filename = `leads-${safeFilePart(criteria.whoToFind)}.doc`;
      const withContacts = eligibleLeads.filter((lead) => (lead.contacts?.length ?? lead.telegramContacts.length) > 0).length;
      const exact = eligibleLeads.filter((lead) => lead.matchKind === "exact").length;
      const partial = eligibleLeads.filter((lead) => lead.matchKind === "partial").length;
      await ctx.replyWithDocument(new InputFile(Buffer.from(report, "utf8"), filename), {
        caption: eligibleLeads.length > 0
          ? `Компаний: ${eligibleLeads.length}; точных: ${exact}; частичных: ${partial}; похожие компании исключены; с контактами: ${withContacts}. Word-совместимый HTML, UTF-8.`
          : "Подходящие сайты не найдены или недоступны. Подробности есть в файле.",
        reply_markup: eligibleLeads.length > 0 ? createLeadResultKeyboard() : createMainKeyboard(),
      });
      if (exact === 0 && eligibleLeads.length > 0) {
        await reply(ctx, "Для более точного результата укажите: конкретную отрасль и специализацию, размер компании, город/область, 2–3 обязательных признака и явные исключения. Например: «частные стоматологии Москвы от 3 филиалов, имплантация и ортодонтия; исключить агрегаторы и одиночные кабинеты».");
      }
      recordHistory(ctx, "bot", `[Список лидов: ${filename}; компаний: ${eligibleLeads.length}; похожие исключены]`);
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
