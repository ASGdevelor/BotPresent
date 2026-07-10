import { load, type CheerioAPI } from "cheerio";
import type {
  CompanyLead,
  LeadCriteria,
  LeadGenerationResult,
  TelegramContact,
} from "../types/lead";
import { fetchPublicHtml, parsePublicHttpUrl } from "./public-web";

const SEARCH_ENDPOINT = "https://www.bing.com/search";
const MAX_CANDIDATES = 10;
const MAX_CONTACT_PAGES = 2;
const TELEGRAM_HANDLE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;
const CONTACT_HINT = /contact|contacts|kontakt|kontakty|контакт|связаться|about|о-компании|о-нас/i;
const IGNORED_HOSTS = new Set([
  "duckduckgo.com",
  "bing.com",
  "google.com",
  "yandex.ru",
  "t.me",
  "telegram.me",
  "vk.com",
  "youtube.com",
  "facebook.com",
  "instagram.com",
]);

export class LeadGenerationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LeadGenerationError";
  }
}

function cleanText(value: string, maxLength = 400): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeCandidateUrl(value: string): string | undefined {
  const trimmed = value.replace(/[),.;]+$/g, "").trim();
  if (!trimmed) return undefined;

  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = parsePublicHttpUrl(withProtocol);
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function extractExplicitUrls(value: string): string[] {
  const matches = value.match(/https?:\/\/[^\s,;]+|(?:www\.)?[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)+(?:\/[^\s,;]*)?/giu) ?? [];
  return [...new Set(matches.map(normalizeCandidateUrl).filter((url): url is string => Boolean(url)))];
}

function unwrapSearchUrl(href: string): string | undefined {
  try {
    const url = new URL(href, SEARCH_ENDPOINT);
    const duckTarget = url.searchParams.get("uddg");
    if (duckTarget) return normalizeCandidateUrl(decodeURIComponent(duckTarget));

    const bingTarget = url.hostname.endsWith("bing.com") ? url.searchParams.get("u") : undefined;
    if (bingTarget?.startsWith("a1")) {
      try {
        return normalizeCandidateUrl(Buffer.from(bingTarget.slice(2), "base64url").toString("utf8"));
      } catch {
        return undefined;
      }
    }

    return normalizeCandidateUrl(url.toString());
  } catch {
    return undefined;
  }
}

export function parseSearchResults(html: string): string[] {
  const $ = load(html);
  const urls: string[] = [];

  $("li.b_algo h2 a, a.result__a, a[data-testid='result-title-a']").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const candidate = unwrapSearchUrl(href);
    if (!candidate) return;

    try {
      const hostname = new URL(candidate).hostname.replace(/^www\./, "").toLowerCase();
      if (IGNORED_HOSTS.has(hostname)) return;
      if (!urls.includes(candidate)) urls.push(candidate);
    } catch {
      // Некорректная ссылка из поисковой выдачи пропускается.
    }
  });

  return urls.slice(0, MAX_CANDIDATES);
}

function buildSearchQuery(criteria: LeadCriteria): string {
  return [
    criteria.whoToFind,
    criteria.whoCanBuy,
    criteria.whereToSearch,
    "контакты telegram",
  ].join(" ");
}

async function searchCandidateUrls(criteria: LeadCriteria): Promise<string[]> {
  const explicitUrls = extractExplicitUrls(criteria.whereToSearch);
  if (explicitUrls.length > 0) return explicitUrls.slice(0, MAX_CANDIDATES);

  const searchUrl = new URL(SEARCH_ENDPOINT);
  searchUrl.searchParams.set("q", buildSearchQuery(criteria));

  let html: string;
  try {
    ({ html } = await fetchPublicHtml(searchUrl.toString()));
  } catch (error) {
    throw new LeadGenerationError(
      "Поиск недоступен. Укажите в поле «Где искать» конкретные сайты или повторите попытку позже.",
      { cause: error },
    );
  }

  const urls = parseSearchResults(html);
  if (urls.length === 0) {
    throw new LeadGenerationError(
      "Поиск не вернул сайты. Уточните портрет компании или укажите конкретные домены.",
    );
  }
  return urls;
}

function telegramContactFromUrl(value: string, label?: string): TelegramContact | undefined {
  try {
    const url = new URL(value, "https://example.com");
    const hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    if (hostname !== "t.me" && hostname !== "telegram.me") return undefined;

    const handle = url.pathname.split("/").filter(Boolean)[0] ?? "";
    if (!TELEGRAM_HANDLE.test(handle) || handle.toLowerCase().endsWith("bot")) return undefined;

    return {
      handle: `@${handle}`,
      url: `https://t.me/${handle}`,
      ...(label && label !== `@${handle}` ? { label: cleanText(label, 80) } : {}),
    };
  } catch {
    return undefined;
  }
}

export function extractTelegramContacts(html: string): TelegramContact[] {
  const $ = load(html);
  const contacts: TelegramContact[] = [];

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const contact = telegramContactFromUrl(href, $(element).text());
    if (contact) contacts.push(contact);
  });

  const text = cleanText($("body").text(), 200_000);
  const patterns = [
    /(?:telegram|телеграм)\s*[:—-]?\s*@([a-zA-Z][a-zA-Z0-9_]{4,31})/gi,
    /@([a-zA-Z][a-zA-Z0-9_]{4,31})\s*(?:в\s*)?(?:telegram|телеграм)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const handle = match[1];
      if (!handle || handle.toLowerCase().endsWith("bot")) continue;
      contacts.push({ handle: `@${handle}`, url: `https://t.me/${handle}` });
    }
  }

  return [...new Map(contacts.map((contact) => [contact.handle.toLowerCase(), contact])).values()];
}

function findContactPageUrls($: CheerioAPI, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const urls: string[] = [];

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const hint = `${href ?? ""} ${$(element).text()}`;
    if (!href || !CONTACT_HINT.test(hint)) return;

    try {
      const url = new URL(href, base);
      if (url.hostname !== base.hostname || !["http:", "https:"].includes(url.protocol)) return;
      url.hash = "";
      if (!urls.includes(url.toString())) urls.push(url.toString());
    } catch {
      // Некорректная внутренняя ссылка пропускается.
    }
  });

  return urls.slice(0, MAX_CONTACT_PAGES);
}

function exclusionPhrases(value: string): string[] {
  if (/^(?:-|нет|без исключений)$/i.test(value.trim())) return [];
  return value
    .split(/[,;\n]+/)
    .map((item) => cleanText(item.toLowerCase(), 100).replace(/^не\s+/, ""))
    .filter((item) => item.length >= 3);
}

function shouldExclude(text: string, criteria: LeadCriteria): boolean {
  const normalized = text.toLowerCase();
  return exclusionPhrases(criteria.exclusions).some((phrase) => normalized.includes(phrase));
}

function companyName($: CheerioAPI, finalUrl: string): string {
  const candidates = [
    $("meta[property='og:site_name']").attr("content"),
    $("meta[name='application-name']").attr("content"),
    $("h1").first().text(),
    $("title").text().split(/[|—–-]/)[0],
  ];
  return candidates.map((item) => cleanText(item ?? "", 100)).find(Boolean)
    ?? new URL(finalUrl).hostname.replace(/^www\./, "");
}

async function analyzeCompany(url: string, criteria: LeadCriteria): Promise<CompanyLead | undefined> {
  const page = await fetchPublicHtml(url);
  const $ = load(page.html);
  $("script, style, noscript, svg").remove();
  const pageText = cleanText($("body").text(), 200_000);
  if (shouldExclude(pageText, criteria)) return undefined;

  const contacts = extractTelegramContacts(page.html);
  const contactPages = findContactPageUrls($, page.finalUrl);

  for (const contactUrl of contactPages) {
    try {
      const contactPage = await fetchPublicHtml(contactUrl);
      contacts.push(...extractTelegramContacts(contactPage.html));
    } catch {
      // Контактная страница необязательна: продолжаем с данными главной страницы.
    }
  }

  const uniqueContacts = [...new Map(
    contacts.map((contact) => [contact.handle.toLowerCase(), contact]),
  ).values()];
  if (uniqueContacts.length === 0) return undefined;

  const description = cleanText(
    $("meta[name='description']").attr("content")
      ?? $("meta[property='og:description']").attr("content")
      ?? pageText,
    300,
  );

  return {
    companyName: companyName($, page.finalUrl),
    website: page.finalUrl,
    description: description || "Описание на сайте не найдено.",
    relevance: `Компания найдена по критериям «${criteria.whoToFind}»; можно предложить: ${criteria.offer}.`,
    telegramContacts: uniqueContacts,
  };
}

export async function generateLeads(criteria: LeadCriteria): Promise<LeadGenerationResult> {
  const candidates = await searchCandidateUrls(criteria);
  const settled = await Promise.allSettled(
    candidates.map((url) => analyzeCompany(url, criteria)),
  );

  const leads: CompanyLead[] = [];
  const warnings: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      if (result.value) leads.push(result.value);
      return;
    }

    const hostname = (() => {
      try { return new URL(candidates[index] ?? "").hostname; } catch { return "неизвестный сайт"; }
    })();
    warnings.push(`${hostname}: сайт не удалось проанализировать`);
  });

  return {
    criteria,
    leads,
    analyzedSites: settled.length,
    warnings,
  };
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function formatLeadReport(result: LeadGenerationResult): string {
  const { criteria, leads } = result;
  const createdAt = new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Moscow",
  }).format(new Date());

  const leadSections = leads.map((lead, index) => {
    const contacts = lead.telegramContacts.map((contact) => {
      const label = contact.label ? ` — ${oneLine(contact.label)}` : "";
      return `- ${contact.handle}${label}: ${contact.url}`;
    });
    return [
      `## ${index + 1}. ${oneLine(lead.companyName)}`,
      "",
      `- Сайт: ${lead.website}`,
      `- Почему подходит: ${oneLine(lead.relevance)}`,
      `- Описание: ${oneLine(lead.description)}`,
      "- Публичные Telegram-контакты:",
      ...contacts,
    ].join("\n");
  });

  const noLeads = leads.length === 0
    ? [
        "## Результат",
        "",
        "Компании с публично указанным Telegram-контактом не найдены. Укажите конкретные сайты в поле «Где искать» или расширьте критерии.",
      ]
    : [];

  return [
    "# Результаты лидогенерации",
    "",
    `Сформировано: ${createdAt}`,
    `Проанализировано сайтов: ${result.analyzedSites}`,
    `Найдено компаний с Telegram-контактом: ${leads.length}`,
    "",
    "## Параметры поиска",
    "",
    `- Кому можно продать: ${oneLine(criteria.whoCanBuy)}`,
    `- Кого ищем: ${oneLine(criteria.whoToFind)}`,
    `- Где ищем: ${oneLine(criteria.whereToSearch)}`,
    `- Что предлагаем: ${oneLine(criteria.offer)}`,
    `- Кого не берём: ${oneLine(criteria.exclusions)}`,
    "",
    "> В отчёт включаются только контакты, открыто опубликованные на сайтах. Перед обращением проверьте актуальность данных и соблюдайте правила площадки и применимое законодательство.",
    "",
    ...leadSections,
    ...noLeads,
    ...(result.warnings.length > 0 ? [
      "",
      "## Предупреждения",
      "",
      ...result.warnings.map((warning) => `- ${warning}`),
    ] : []),
  ].join("\n");
}
