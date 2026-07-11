import { load, type CheerioAPI } from "cheerio";
import type {
  CompanyLead,
  CompanyContact,
  ContactRole,
  LeadCriteria,
  LeadGenerationResult,
  TelegramContact,
} from "../types/lead";
import { fetchPublicHtml, parsePublicHttpUrl } from "./public-web";

const SEARCH_ENDPOINT = "https://www.bing.com/search";
const MAX_CANDIDATES = 30;
const MAX_CONTACT_PAGES = 5;
const TELEGRAM_HANDLE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;
const CONTACT_HINT = /contact|contacts|kontakt|kontakty|контакт|связаться|about|о-компании|о-нас|team|команда|руководство|management|leadership|реквизит/i;
const EMAIL_PATTERN = /[\w.!#$%&'*+/=?^`{|}~-]+@[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)+/giu;
const PHONE_PATTERN = /(?:\+?\d[\s().-]*){9,16}\d/g;
const PERSON_ROLE_PATTERN = /(?:генеральн(?:ый|ого) директор|директор|руководитель|владелец|собственник|основатель|коммерческий директор|менеджер(?: по продажам)?|CEO|founder|owner|manager)/i;
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

const ROLE_PRIORITY: Record<ContactRole, number> = {
  director: 0,
  sales: 1,
  manager: 2,
  employee: 3,
  unknown: 4,
  company: 5,
};

const ROLE_LABELS: Record<ContactRole, string> = {
  director: "директор / владелец",
  sales: "продажи / развитие бизнеса",
  manager: "менеджер",
  employee: "сотрудник",
  company: "корпоративный контакт",
  unknown: "роль не указана",
};

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
    "компания официальный сайт контакты директор владелец менеджер",
  ].join(" ");
}

async function searchCandidateUrls(criteria: LeadCriteria): Promise<string[]> {
  const explicitUrls = extractExplicitUrls(criteria.whereToSearch);
  if (explicitUrls.length > 0) return explicitUrls.slice(0, MAX_CANDIDATES);

  const queries = [
    buildSearchQuery(criteria),
    `${criteria.whoToFind} ${criteria.whereToSearch} каталог компаний`,
    `${criteria.whoCanBuy} ${criteria.whereToSearch} официальный сайт`,
  ];

  const searchPages = await Promise.allSettled(queries.map(async (query) => {
      const searchUrl = new URL(SEARCH_ENDPOINT);
      searchUrl.searchParams.set("q", query);
      return (await fetchPublicHtml(searchUrl.toString())).html;
  }));
  const pages = searchPages.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (pages.length === 0) {
    throw new LeadGenerationError(
      "Поиск недоступен. Укажите в поле «Где искать» конкретные сайты или повторите попытку позже.",
    );
  }

  const urls = [...new Set(pages.flatMap(parseSearchResults))].slice(0, MAX_CANDIDATES);
  if (urls.length === 0) {
    throw new LeadGenerationError(
      "Поиск не вернул сайты. Уточните портрет компании или укажите конкретные домены.",
    );
  }
  return urls;
}

export function inferContactRole(value: string): ContactRole {
  const text = value.toLowerCase();
  if (/директор|генеральн|руководител|владел|собственник|основател|founder|owner|chief|\bceo\b/.test(text)) {
    return "director";
  }
  if (/продаж|коммерч|развити[ея]\s+бизнес|business\s+development|bizdev|sales|account\s+executive/.test(text)) {
    return "sales";
  }
  if (/менеджер|manager|аккаунт|account/.test(text)) return "manager";
  if (/сотрудник|специалист|консультант|эксперт|employee|specialist|consultant/.test(text)) {
    return "employee";
  }
  if (/компания|официальн|канал|новости|company|official|channel|команда/.test(text)) return "company";
  return "unknown";
}

function telegramContactFromUrl(
  value: string,
  label?: string,
  context = "",
  sourceUrl?: string,
): TelegramContact | undefined {
  try {
    const url = new URL(value, "https://example.com");
    const hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    if (hostname !== "t.me" && hostname !== "telegram.me") return undefined;

    const handle = url.pathname.split("/").filter(Boolean)[0] ?? "";
    if (!TELEGRAM_HANDLE.test(handle) || handle.toLowerCase().endsWith("bot")) return undefined;

    const cleanLabel = cleanText(label ?? "", 80);
    return {
      handle: `@${handle}`,
      url: `https://t.me/${handle}`,
      role: inferContactRole(`${cleanLabel} ${context}`),
      ...(cleanLabel && cleanLabel !== `@${handle}` ? { label: cleanLabel } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  } catch {
    return undefined;
  }
}

export function extractTelegramContacts(html: string, sourceUrl?: string): TelegramContact[] {
  const $ = load(html);
  const contacts: TelegramContact[] = [];

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const label = $(element).text();
    const context = $(element).closest("li, p, div, address").first().text();
    const contact = telegramContactFromUrl(href, label, cleanText(context, 240), sourceUrl);
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
      const index = match.index ?? 0;
      const context = text.slice(Math.max(0, index - 120), index + match[0].length + 120);
      contacts.push({
        handle: `@${handle}`,
        url: `https://t.me/${handle}`,
        role: inferContactRole(context),
        ...(sourceUrl ? { sourceUrl } : {}),
      });
    }
  }

  return mergeTelegramContacts(contacts);
}

function mergeTelegramContacts(contacts: TelegramContact[]): TelegramContact[] {
  const unique = new Map<string, TelegramContact>();
  for (const contact of contacts) {
    const key = contact.handle.toLowerCase();
    const current = unique.get(key);
    if (!current || ROLE_PRIORITY[contact.role] < ROLE_PRIORITY[current.role]) unique.set(key, contact);
  }
  return [...unique.values()].sort((a, b) => ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role]);
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

function normalizePhone(value: string): string {
  return value.replace(/[^\d+]/g, "").replace(/^8(?=\d{10}$)/, "+7");
}

function extractCompanyContacts(html: string, sourceUrl: string): CompanyContact[] {
  const $ = load(html);
  const contacts: CompanyContact[] = [];
  const add = (contact: CompanyContact) => {
    const key = `${contact.kind}:${contact.value.toLowerCase()}`;
    if (!contacts.some((item) => `${item.kind}:${item.value.toLowerCase()}` === key)) contacts.push(contact);
  };

  $("a[href^='mailto:']").each((_, element) => {
    const value = ($(element).attr("href") ?? "").slice(7).split("?")[0]?.trim();
    if (value) add({ kind: "email", value, role: inferContactRole($(element).parent().text()), sourceUrl });
  });
  $("a[href^='tel:']").each((_, element) => {
    const value = normalizePhone(($(element).attr("href") ?? "").slice(4));
    if (value.length >= 10) add({ kind: "phone", value, role: inferContactRole($(element).parent().text()), sourceUrl });
  });

  const text = cleanText($("body").text(), 200_000);
  for (const email of text.match(EMAIL_PATTERN) ?? []) {
    add({ kind: "email", value: email.toLowerCase(), role: inferContactRole(text.slice(Math.max(0, text.indexOf(email) - 100), text.indexOf(email) + email.length + 100)), sourceUrl });
  }
  for (const rawPhone of text.match(PHONE_PATTERN) ?? []) {
    const value = normalizePhone(rawPhone);
    if (value.length >= 10 && value.length <= 16) add({ kind: "phone", value, role: inferContactRole(text.slice(Math.max(0, text.indexOf(rawPhone) - 100), text.indexOf(rawPhone) + rawPhone.length + 100)), sourceUrl });
  }

  $("li, p, td, address, [class*='team'], [class*='person'], [class*='staff']").each((_, element) => {
    const value = cleanText($(element).text(), 280);
    if (!PERSON_ROLE_PATTERN.test(value)) return;
    const name = value.match(/(?:[А-ЯЁ][а-яё-]+\s+){1,2}[А-ЯЁ][а-яё-]+|(?:[A-Z][a-z-]+\s+){1,2}[A-Z][a-z-]+/)?.[0];
    if (name) add({ kind: "person", value: name, name, label: value, role: inferContactRole(value), sourceUrl });
  });

  for (const contact of extractTelegramContacts(html, sourceUrl)) {
    add({ kind: "telegram", value: contact.handle, role: contact.role, label: contact.label, sourceUrl: contact.sourceUrl });
  }
  return contacts;
}

function regionTerms(criteria: LeadCriteria): string[] {
  if (extractExplicitUrls(criteria.whereToSearch).length > 0) return [];
  const stop = /^(?:искать|регион|область|город|страна|каталог|компани[ияй]|сайт(?:ы|ов)?|в|и|по)$/i;
  return criteria.whereToSearch
    .split(/[,;/\n]+|\s+/)
    .map((value) => value.replace(/[^\p{L}-]/gu, "").trim())
    .filter((value) => value.length >= 3 && !stop.test(value));
}

function detectRegion(pageText: string, criteria: LeadCriteria, website?: string): string | undefined {
  const terms = regionTerms(criteria);
  if (terms.length === 0) return undefined;
  const normalizedPage = pageText.toLocaleLowerCase("ru");
  const found = terms.filter((term) => {
    const normalized = term.toLocaleLowerCase("ru");
    const stem = normalized.length >= 6 ? normalized.slice(0, Math.max(5, normalized.length - 3)) : normalized;
    if (normalizedPage.includes(normalized) || normalizedPage.includes(stem)) return true;
    if (!website) return false;
    const hostname = new URL(website).hostname;
    return (/^росси|^россий/.test(normalized) && /\.(?:ru|рф)$/.test(hostname))
      || (/^беларус/.test(normalized) && hostname.endsWith(".by"))
      || (/^казах/.test(normalized) && hostname.endsWith(".kz"))
      || (/^узбек/.test(normalized) && hostname.endsWith(".uz"));
  });
  return found.length > 0 ? found.join(", ") : undefined;
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
  const requestedRegions = regionTerms(criteria);
  let region = detectRegion(pageText, criteria, page.finalUrl);

  const contacts = extractTelegramContacts(page.html, page.finalUrl);
  const companyContacts = extractCompanyContacts(page.html, page.finalUrl);
  const contactPages = findContactPageUrls($, page.finalUrl);

  for (const contactUrl of contactPages) {
    try {
      const contactPage = await fetchPublicHtml(contactUrl);
      contacts.push(...extractTelegramContacts(contactPage.html, contactPage.finalUrl));
      companyContacts.push(...extractCompanyContacts(contactPage.html, contactPage.finalUrl));
      if (!region) region = detectRegion(cleanText(load(contactPage.html)("body").text(), 200_000), criteria, contactPage.finalUrl);
    } catch {
      // Контактная страница необязательна: продолжаем с данными главной страницы.
    }
  }

  const uniqueContacts = mergeTelegramContacts(contacts);
  if (requestedRegions.length > 0 && !region) return undefined;

  const description = cleanText(
    $("meta[name='description']").attr("content")
      ?? $("meta[property='og:description']").attr("content")
      ?? pageText,
    300,
  );

  return {
    companyName: companyName($, page.finalUrl),
    siteName: new URL(page.finalUrl).hostname.replace(/^www\./, ""),
    website: page.finalUrl,
    description: description || "Описание на сайте не найдено.",
    relevance: `Компания найдена по критериям «${criteria.whoToFind}»; можно предложить: ${criteria.offer}.`,
    ...(region ? { region } : {}),
    contacts: companyContacts.filter((contact, index, all) => all.findIndex((item) => item.kind === contact.kind && item.value.toLowerCase() === contact.value.toLowerCase()) === index),
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

  leads.sort((a, b) => Number(b.telegramContacts.length > 0) - Number(a.telegramContacts.length > 0));

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
  const { leads } = result;
  const leadSections = leads.map((lead, index) => {
    const allContacts = lead.contacts ?? lead.telegramContacts.map((contact) => ({
      kind: "telegram" as const,
      value: contact.handle,
      role: contact.role,
      label: contact.label,
      sourceUrl: contact.sourceUrl,
    }));
    const people = allContacts.filter((contact) => contact.kind === "person")
      .map((contact) => `${contact.value} (${ROLE_LABELS[contact.role]})`);
    const contacts = allContacts.filter((contact) => contact.kind !== "person")
      .map((contact) => `${contact.value}${contact.role !== "unknown" ? ` (${ROLE_LABELS[contact.role]})` : ""}${contact.sourceUrl ? `; источник: ${contact.sourceUrl}` : ""}`);
    return [
      `## ${index + 1}. ${oneLine(lead.companyName)}`,
      `- Название компании: ${oneLine(lead.companyName)}`,
      `- Название сайта: ${lead.siteName}`,
      `- Сайт: ${lead.website}`,
      `- Регион: ${lead.region ?? "подтверждён на сайте не был"}`,
      `- Управляющие люди / владельцы / менеджеры: ${people.join("; ") || "не найдены"}`,
      `- Контакты: ${contacts.join("; ") || "не найдены"}`,
      `- Публичные Telegram-контакты: ${lead.telegramContacts.length > 0 ? lead.telegramContacts.map((contact) => contact.handle).join("; ") : "не найдены"}`,
    ].join("\n");
  });

  const noLeads = leads.length === 0
    ? [
        "## Результат",
        "",
        "Подходящие сайты не удалось проанализировать. Укажите конкретные сайты в поле «Где искать» или расширьте критерии.",
      ]
    : [];

  return [
    `Проанализировано сайтов: ${result.analyzedSites}`,
    `Компаний без Telegram-контакта: ${leads.filter((lead) => lead.telegramContacts.length === 0).length}`,
    ...leadSections,
    ...noLeads,
  ].join("\n");
}

function csvCell(value: string): string {
  return `"${oneLine(value).replaceAll('"', '""')}"`;
}

export function formatLeadCsv(result: LeadGenerationResult): string {
  const rows = result.leads.map((lead) => {
    const contacts = lead.contacts ?? [];
    const people = contacts.filter((contact) => contact.kind === "person")
      .map((contact) => `${contact.value} — ${ROLE_LABELS[contact.role]}`);
    const communication = contacts.filter((contact) => contact.kind !== "person")
      .map((contact) => `${contact.value}${contact.role !== "unknown" ? ` — ${ROLE_LABELS[contact.role]}` : ""}`);
    if (contacts.length === 0) communication.push(...lead.telegramContacts.map((contact) => contact.handle));
    return [lead.companyName, lead.website, lead.region ?? "", people.join("; "), communication.join("; ")]
      .map(csvCell).join(",");
  });
  return `\uFEFF${["Название компании,Сайт,Регион,Управляющие люди владельцы менеджеры,Контакты", ...rows].join("\r\n")}`;
}
