import { load, type CheerioAPI } from "cheerio";
import type {
  CompanyLead,
  CompanyContact,
  ContactRole,
  LeadCriteria,
  LeadGenerationResult,
  TelegramContact,
} from "../types/lead";
import { fetchPublicHtml, fetchPublicXml, parsePublicHttpUrl } from "./public-web";

// ======================= Конфигурация =======================
export interface LeadGeneratorConfig {
  maxCandidates: number;
  maxContactPages: number;
  contactPagesParallelism: number;
  siteAnalysisParallelism: number;
  requestTimeoutMs: number;
}

export class LeadGenerationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LeadGenerationError";
  }
}

const DEFAULT_CONFIG: LeadGeneratorConfig = {
  maxCandidates: 250,
  maxContactPages: 10,
  contactPagesParallelism: 4,
  siteAnalysisParallelism: 8,
  requestTimeoutMs: 12000,
};

// ======================= Константы =======================
const SEARCH_ENDPOINT = "https://www.google.com/search";
const BING_SEARCH_ENDPOINT = "https://www.bing.com/search";
const DUCK_SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const TELEGRAM_HANDLE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;
const CONTACT_HINT = /contact|contacts|kontakt|kontakty|контакт|связаться|about|о-компании|о-нас|team|команда|руководство|management|leadership|реквизит|service|услуг|product|продукт|catalog|каталог|direction|направлен/i;
const EMAIL_PATTERN = /[\w.!#$%&'*+/=?^`{|}~-]+@[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)+/giu;
const PHONE_PATTERN = /(?:\+?\d[\s().-]*){9,16}\d/g;
const PERSON_ROLE_PATTERN = /(?:генеральн(?:ый|ого) директор|директор|руководитель|владелец|собственник|основатель|коммерческий директор|менеджер(?: по продажам)?|CEO|founder|owner|manager)/i;

// Расширенный список игнорируемых хостов
const IGNORED_HOSTS = new Set([
  // Поисковики и агрегаторы
  "duckduckgo.com", "bing.com", "google.com", "yandex.ru",
  // Социальные сети и мессенджеры
  "t.me", "telegram.me", "vk.com", "facebook.com", "instagram.com",
  "whatsapp.com", "wa.me", "linkedin.com", "twitter.com", "x.com",
  // Вики и справочные
  "wikipedia.org", "wikimedia.org", "wikiwand.com",
  // Чат-боты, AI, форумы
  "chat.openai.com", "chatgpt.com", "web.telegram.org",
  // Доски объявлений, каталоги
  "2gis.ru", "zoon.ru", "yell.ru", "avito.ru", "hh.ru",
  "youtube.com", "rutube.ru", "dzen.ru", "tiktok.com",
  "pinterest.com", "reddit.com", "livejournal.com",
  "github.com", "stackoverflow.com",
]);

// Пути, которые гарантированно не ведут к компании
const IRRELEVANT_PATH_SEGMENTS = [
  "chat", "wiki", "login", "signup", "account", "cart", "checkout",
  "password", "auth", "register", "search", "page", "feed", "blog", "news",
];

// ======================= Вспомогательные утилиты =======================

function cleanText(value: string, maxLength = 400): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeCandidateUrl(value: string): string | undefined {
  const trimmed = value.replace(/[),.;]+$/g, "").trim();
  if (!trimmed) return undefined;

  try {
    let withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = parsePublicHttpUrl(withProtocol);
    url.hash = "";
    const hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    // Игнорируем по хосту
    if (IGNORED_HOSTS.has(hostname)) return undefined;
    // Игнорируем по пути
    const pathLower = url.pathname.toLowerCase();
    if (IRRELEVANT_PATH_SEGMENTS.some(seg => pathLower.includes(`/${seg}`) || pathLower.startsWith(`${seg}/`))) {
      return undefined;
    }
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

    const googleTarget = url.hostname.endsWith("google.com") && url.pathname === "/url"
      ? url.searchParams.get("q") ?? url.searchParams.get("url")
      : undefined;
    if (googleTarget) return normalizeCandidateUrl(googleTarget);

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

export function parseSearchResults(html: string, requiredKeywords: string[] = []): string[] {
  const $ = load(html);
  const urls: string[] = [];
  const normalizedKeywords = requiredKeywords.map(keywordStem);

  $("li.b_algo h2 a, a.result__a, a[data-testid='result-title-a'], a:has(h3), a[href^='/url?']").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const resultText = cleanText($(element).closest("li, article, [data-snhf], div").first().text() || $(element).text(), 1200)
      .toLocaleLowerCase("ru").replace(/ё/g, "е");
    if (normalizedKeywords.length > 0 && !normalizedKeywords.some(keyword => resultText.includes(keyword))) return;
    const candidate = unwrapSearchUrl(href);
    if (candidate && !urls.includes(candidate)) urls.push(candidate);
  });

  return urls.slice(0, 60);
}

export function parseBingRssResults(xml: string, requiredKeywords: string[] = []): string[] {
  const document = load(xml, { xmlMode: true });
  const urls: string[] = [];
  const normalizedKeywords = requiredKeywords.map(keywordStem);
  document("item > link").each((_, element) => {
    const itemText = document(element).parent().text().toLocaleLowerCase("ru").replace(/ё/g, "е");
    if (normalizedKeywords.length > 0 && !normalizedKeywords.some(keyword => itemText.includes(keyword))) return;
    const candidate = normalizeCandidateUrl(document(element).text().trim());
    if (candidate && !urls.includes(candidate)) urls.push(candidate);
  });
  return urls.slice(0, 60);
}

// ======================= Скоринг и роли =======================

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

const KEYWORD_STOP = new Set([
  "компания", "компании", "который", "которые", "нужно", "можно", "услуга", "услуги",
  "для", "или", "при", "это", "как", "чтобы", "если", "под", "над", "без", "есть",
]);

function keywordStem(value: string): string {
  const normalized = value.toLocaleLowerCase("ru").replace(/ё/g, "е");
  return normalized.length > 6 ? normalized.slice(0, -3) : normalized;
}

function keywordsFrom(value: string): string[] {
  return [...new Set(value
    .split(/[^\p{L}\d]+/u)
    .map(keywordStem)
    .filter(w => w.length >= 4 && !KEYWORD_STOP.has(w))
  )].slice(0, 24);
}

export function scoreCompany(text: string, criteria: LeadCriteria, regionMatched: boolean, contacts: number): {
  score: number;
  matchKind: "exact" | "partial" | "similar";
  matchedKeywords: string[];
} {
  const normalized = text.toLocaleLowerCase("ru").replace(/ё/g, "е");
  const targetKeywords = keywordsFrom(criteria.whoToFind);
  const buyerKeywords = keywordsFrom(criteria.whoCanBuy);
  const matchedTarget = targetKeywords.filter(kw => normalized.includes(kw));
  const matchedBuyer = buyerKeywords.filter(kw => normalized.includes(kw));
  const targetRatio = targetKeywords.length > 0 ? matchedTarget.length / targetKeywords.length : 0.5;
  const buyerRatio = buyerKeywords.length > 0 ? matchedBuyer.length / buyerKeywords.length : targetRatio;
  const ratio = targetRatio * 0.8 + buyerRatio * 0.2;
  const matchedKeywords = [...new Set([...matchedTarget, ...matchedBuyer])];
  const score = Math.min(100, Math.round(15 + ratio * 65 + (regionMatched ? 15 : 0) + (contacts > 0 ? 5 : 0)));
  const matchKind = matchedTarget.length === 0
    ? "similar"
    : targetRatio >= 0.6 && regionMatched
      ? "exact"
      : targetRatio >= 0.25 && ratio >= 0.28
        ? "partial"
        : "similar";
  return { score, matchKind, matchedKeywords };
}

export function inferContactRole(value: string): ContactRole {
  const text = value.toLowerCase();
  if (/директор|генеральн|руководител|владел|собственник|основател|founder|owner|chief|\bceo\b/.test(text)) return "director";
  if (/продаж|коммерч|развити[ея]\s+бизнес|business\s+development|bizdev|sales|account\s+executive/.test(text)) return "sales";
  if (/менеджер|manager|аккаунт|account/.test(text)) return "manager";
  if (/сотрудник|специалист|консультант|эксперт|employee|specialist|consultant/.test(text)) return "employee";
  if (/компания|официальн|канал|новости|company|official|channel|команда/.test(text)) return "company";
  return "unknown";
}

// ======================= Извлечение контактов =======================

function telegramContactFromUrl(
  value: string, label?: string, context = "", sourceUrl?: string
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

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const label = $(el).text();
    const context = $(el).closest("li, p, div, address").first().text();
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
  const baseHost = base.hostname.replace(/^www\./, "").toLowerCase();
  const urls: string[] = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const hint = `${href ?? ""} ${$(el).text()}`;
    if (!href || !CONTACT_HINT.test(hint)) return;

    try {
      const url = new URL(href, base);
      const host = url.hostname.replace(/^www\./, "").toLowerCase();
      if (host !== baseHost || !["http:", "https:"].includes(url.protocol)) return;
      url.hash = "";
      const pathLower = url.pathname.toLowerCase();
      if (IRRELEVANT_PATH_SEGMENTS.some(seg => pathLower.includes(`/${seg}`))) return;
      if (!urls.includes(url.toString())) urls.push(url.toString());
    } catch {}
  });

  return urls.slice(0, 20);
}

function normalizePhone(value: string): string {
  return value.replace(/[^\d+]/g, "").replace(/^8(?=\d{10}$)/, "+7");
}

function isLikelyPhoneText(rawValue: string, normalized: string): boolean {
  const digits = normalized.replace(/\D/g, "");
  if (rawValue.trim().startsWith("+")) {
    if (digits.startsWith("7")) return /^7[3489]\d{9}$/.test(digits);
    return digits.length >= 11 && digits.length <= 15;
  }
  return /^7[3489]\d{9}$/.test(digits) && rawValue.trim().startsWith("8");
}

function extractCompanyContacts(html: string, sourceUrl: string): CompanyContact[] {
  const $ = load(html);
  const contacts: CompanyContact[] = [];
  const add = (c: CompanyContact) => {
    const key = `${c.kind}:${c.value.toLowerCase()}`;
    if (!contacts.some(item => `${item.kind}:${item.value.toLowerCase()}` === key)) contacts.push(c);
  };

  $("a[href^='mailto:']").each((_, el) => {
    const val = ($(el).attr("href") ?? "").slice(7).split("?")[0]?.trim();
    if (val) add({ kind: "email", value: val, role: inferContactRole($(el).parent().text()), sourceUrl });
  });
  $("a[href^='tel:']").each((_, el) => {
    const val = normalizePhone(($(el).attr("href") ?? "").slice(4));
    if (val.length >= 10) add({ kind: "phone", value: val, role: inferContactRole($(el).parent().text()), sourceUrl });
  });
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const url = new URL(href, sourceUrl);
      const host = url.hostname.replace(/^www\./, "").toLowerCase();
      if (!/^(?:wa\.me|api\.whatsapp\.com|vk\.com|linkedin\.com|instagram\.com)$/.test(host)) return;
      const context = cleanText($(el).closest("li,p,div,address").first().text(), 240);
      add({ kind: "social", value: url.toString(), role: inferContactRole(context), label: cleanText($(el).text(), 80), sourceUrl });
    } catch {}
  });

  const text = cleanText($("body").text(), 200_000);
  for (const email of text.match(EMAIL_PATTERN) ?? []) {
    add({ kind: "email", value: email.toLowerCase(), role: inferContactRole(text.slice(Math.max(0, text.indexOf(email) - 100), text.indexOf(email) + email.length + 100)), sourceUrl });
  }
  for (const rawPhone of text.match(PHONE_PATTERN) ?? []) {
    const val = normalizePhone(rawPhone);
    if (isLikelyPhoneText(rawPhone, val)) {
      add({ kind: "phone", value: val, role: inferContactRole(text.slice(Math.max(0, text.indexOf(rawPhone) - 100), text.indexOf(rawPhone) + rawPhone.length + 100)), sourceUrl });
    }
  }

  $("li, p, td, address, [class*='team'], [class*='person'], [class*='staff']").each((_, el) => {
    const val = cleanText($(el).text(), 280);
    if (!PERSON_ROLE_PATTERN.test(val)) return;
    const name = val.match(/(?:[А-ЯЁ][а-яё-]+\s+){1,2}[А-ЯЁ][а-яё-]+|(?:[A-Z][a-z-]+\s+){1,2}[A-Z][a-z-]+/)?.[0];
    if (name) add({ kind: "person", value: name, name, label: val, role: inferContactRole(val), sourceUrl });
  });

  for (const contact of extractTelegramContacts(html, sourceUrl)) {
    add({ kind: "telegram", value: contact.handle, role: contact.role, label: contact.label, sourceUrl: contact.sourceUrl });
  }
  return contacts;
}

// ======================= Регион и исключения =======================

function regionTerms(criteria: LeadCriteria): string[] {
  if (extractExplicitUrls(criteria.whereToSearch).length > 0) return [];
  const stop = /^(?:искать|регион|область|город|страна|каталог|компани[ияй]|сайт(?:ы|ов)?|в|и|по)$/i;
  return criteria.whereToSearch
    .split(/[,;/\n]+|\s+/)
    .map(v => v.replace(/[^\p{L}-]/gu, "").trim())
    .filter(v => v.length >= 3 && !stop.test(v));
}

function detectRegion(pageText: string, criteria: LeadCriteria, website?: string): string | undefined {
  const terms = regionTerms(criteria);
  if (terms.length === 0) return undefined;
  const normalizedPage = pageText.toLocaleLowerCase("ru");
  const found = terms.filter(term => {
    const t = term.toLocaleLowerCase("ru");
    if (normalizedPage.includes(t)) return true;
    if (!website) return false;
    const hostname = new URL(website).hostname;
    return (/^росси|^россий/.test(t) && /\.(?:ru|рф)$/.test(hostname))
      || (/^беларус/.test(t) && hostname.endsWith(".by"))
      || (/^казах/.test(t) && hostname.endsWith(".kz"))
      || (/^узбек/.test(t) && hostname.endsWith(".uz"));
  });
  return found.length > 0 ? found.join(", ") : undefined;
}

const COUNTRY_RULES = [
  { aliases: ["россия", "российская федерация", "russia"], tlds: [".ru", ".рф", ".su"], googleCountry: "ru" },
  { aliases: ["беларусь", "белоруссия", "belarus"], tlds: [".by"], googleCountry: "by" },
  { aliases: ["казахстан", "kazakhstan"], tlds: [".kz"], googleCountry: "kz" },
  { aliases: ["узбекистан", "uzbekistan"], tlds: [".uz"], googleCountry: "uz" },
  { aliases: ["украина", "ukraine"], tlds: [".ua"], googleCountry: "ua" },
  { aliases: ["армения", "armenia"], tlds: [".am"], googleCountry: "am" },
  { aliases: ["грузия", "georgia"], tlds: [".ge"], googleCountry: "ge" },
  { aliases: ["кыргызстан", "киргизия", "kyrgyzstan"], tlds: [".kg"], googleCountry: "kg" },
] as const;

function countrySearchHint(criteria: LeadCriteria): { googleCountry?: string; siteOperator?: string } {
  const requestedText = criteria.whereToSearch.toLocaleLowerCase("ru");
  const rule = COUNTRY_RULES.find(item => item.aliases.some(alias => requestedText.includes(alias)));
  if (!rule) return {};
  return {
    googleCountry: rule.googleCountry,
    siteOperator: `(${rule.tlds.map(tld => `site:${tld}`).join(" OR ")})`,
  };
}

function countryDomainMatch(criteria: LeadCriteria, pageText: string, website: string): {
  requested: boolean;
  matched: boolean;
  conflicting: boolean;
} {
  const requestedText = criteria.whereToSearch.toLocaleLowerCase("ru");
  const rule = COUNTRY_RULES.find(item => item.aliases.some(alias => requestedText.includes(alias)));
  if (!rule) return { requested: false, matched: true, conflicting: false };

  const hostname = new URL(website).hostname.toLocaleLowerCase("ru");
  const normalizedPage = pageText.toLocaleLowerCase("ru");
  const domainMatched = rule.tlds.some(tld => hostname.endsWith(tld));
  const textMatched = rule.aliases.some(alias => normalizedPage.includes(alias));
  const knownCountryTlds = COUNTRY_RULES.flatMap(item => [...item.tlds]);
  const finalLabel = hostname.split(".").at(-1) ?? "";
  const hasDifferentCountryTld = finalLabel.length === 2
    && !rule.tlds.some(tld => tld === `.${finalLabel}`);
  const conflicting = (knownCountryTlds.some(tld => hostname.endsWith(tld)) || hasDifferentCountryTld)
    && !domainMatched;
  return { requested: true, matched: domainMatched || textMatched, conflicting };
}

function exclusionPhrases(value: string): string[] {
  if (/^(?:-|нет|без исключений)$/i.test(value.trim())) return [];
  return value
    .split(/[,;\n]+/)
    .map(item => cleanText(item.toLowerCase(), 100))
    .filter(item => item.length >= 3);
}

function shouldExclude(text: string, criteria: LeadCriteria): boolean {
  const normalized = text.toLowerCase();
  return exclusionPhrases(criteria.exclusions).some(phrase => normalized.includes(phrase));
}

function hasOfficialSiteSignals(document: CheerioAPI, pageText: string): boolean {
  const title = cleanText(document("title").text(), 160);
  const heading = cleanText(document("h1").first().text(), 160);
  if (pageText.length < 180 || (!title && !heading)) return false;
  const identity = `${title} ${heading}`.toLowerCase();
  return !/(?:404|not found|страница не найдена|домен прода[её]тся|parking domain)/i.test(identity);
}

function queryValue(value: string, maxLength = 180): string {
  return cleanText(value.replace(/["'`<>]/g, " "), maxLength);
}

function exclusionQuerySuffix(criteria: LeadCriteria): string {
  const terms = exclusionPhrases(criteria.exclusions)
    .flatMap(phrase => phrase.split(/\s+/))
    .map(term => term.replace(/[^\p{L}\d-]/gu, ""))
    .filter(term => term.length >= 4)
    .slice(0, 8);
  return terms.length > 0 ? ` ${terms.map(term => `-${term}`).join(" ")}` : "";
}

/** Поисковые запросы строятся из всех пяти ответов анкеты, без случайных подстановок. */
export function buildLeadSearchQueries(criteria: LeadCriteria): string[] {
  const target = queryValue(criteria.whoToFind);
  const buyer = queryValue(criteria.whoCanBuy);
  const region = queryValue(criteria.whereToSearch);
  const offer = queryValue(criteria.offer, 140);
  const negative = exclusionQuerySuffix(criteria);
  const countryHint = countrySearchHint(criteria);
  return [...new Set([
    `${target} ${region} компания официальный сайт контакты${negative}`,
    `"${target}" ${region} официальный сайт${negative}`,
    `${target} ${region} руководство директор владелец контакты${negative}`,
    `${target} ${region} отдел продаж менеджер Telegram контакты${negative}`,
    `${buyer} ${region} ${target} официальный сайт${negative}`,
    `${target} ${region} ${offer} бизнес${negative}`,
    `intitle:${target} ${region} контакты${negative}`,
    `inurl:contact ${target} ${region}${negative}`,
    `inurl:about ${target} ${region} руководство${negative}`,
    `${target} ${region} реквизиты команда филиалы${negative}`,
    `${target} ${region} организации предприятия официальный сайт${negative}`,
    countryHint.siteOperator
      ? `${countryHint.siteOperator} ${target} ${buyer} официальный сайт${negative}`
      : `${target} ${region} похожие компании официальный сайт${negative}`,
  ].map(query => cleanText(query, 480)).filter(Boolean))];
}

// ======================= Генератор лидов =======================

export class LeadGenerator {
  private config: LeadGeneratorConfig;

  constructor(config: Partial<LeadGeneratorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private async fetchWithTimeout(url: string): ReturnType<typeof fetchPublicHtml> {
    return Promise.race([
      fetchPublicHtml(url),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout for ${url}`)), this.config.requestTimeoutMs)
      ),
    ]);
  }

  private async fetchXmlWithTimeout(url: string): ReturnType<typeof fetchPublicXml> {
    return Promise.race([
      fetchPublicXml(url),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout for ${url}`)), this.config.requestTimeoutMs)
      ),
    ]);
  }

  async searchCandidateUrls(criteria: LeadCriteria): Promise<string[]> {
    const explicitUrls = extractExplicitUrls(criteria.whereToSearch);
    if (explicitUrls.length > 0) return explicitUrls.slice(0, this.config.maxCandidates);

    const countryHint = countrySearchHint(criteria);
    const queries = buildLeadSearchQueries(criteria);

    const googleRequests = queries.flatMap(q => [0, 10, 20].map(start => {
      const url = new URL(SEARCH_ENDPOINT);
      url.searchParams.set("q", q);
      url.searchParams.set("num", "10");
      url.searchParams.set("start", String(start));
      url.searchParams.set("filter", "0");
      url.searchParams.set("pws", "0");
      url.searchParams.set("hl", "ru");
      if (countryHint.googleCountry) url.searchParams.set("gl", countryHint.googleCountry);
      return this.fetchWithTimeout(url.toString()).then(r => r.html);
    }));
    const bingRequests = queries.flatMap(q => [1, 11, 21].map(first => {
      const url = new URL(BING_SEARCH_ENDPOINT);
      url.searchParams.set("q", q);
      url.searchParams.set("count", "10");
      url.searchParams.set("first", String(first));
      url.searchParams.set("setlang", "ru");
      return this.fetchWithTimeout(url.toString()).then(result => result.html);
    }));

    const [googlePages, bingPages] = await Promise.all([
      Promise.allSettled(googleRequests),
      Promise.allSettled(bingRequests),
    ]);
    const googleHtmls = googlePages
      .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
      .map(result => result.value);
    const bingHtmls = bingPages
      .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
      .map(result => result.value);
    const targetKeywords = keywordsFrom(criteria.whoToFind);
    let bingDiscovered = bingHtmls.flatMap(html => parseSearchResults(html, targetKeywords));
    if (bingDiscovered.length === 0) {
      const rssPages = await Promise.allSettled(queries.slice(0, 8).flatMap(q => [1, 11].map(first => {
        const url = new URL(BING_SEARCH_ENDPOINT);
        url.searchParams.set("q", q);
        url.searchParams.set("format", "rss");
        url.searchParams.set("count", "10");
        url.searchParams.set("first", String(first));
        return this.fetchXmlWithTimeout(url.toString()).then(result => result.xml);
      })));
      bingDiscovered = rssPages
        .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
        .flatMap(result => parseBingRssResults(result.value, targetKeywords));
    }
    let discovered = [...new Set([
      ...googleHtmls.flatMap(html => parseSearchResults(html, targetKeywords)),
      ...bingDiscovered,
    ])];

    // Если оба основных поисковика временно вернули CAPTCHA/пустую выдачу,
    // DuckDuckGo используется только как резерв, а не как источник случайных URL.
    if (discovered.length === 0) {
      const fallbackPages = await Promise.allSettled(queries.slice(0, 10).flatMap(q => [0, 30].map(offset => {
        const url = new URL(DUCK_SEARCH_ENDPOINT);
        url.searchParams.set("q", q);
        if (offset > 0) url.searchParams.set("s", String(offset));
        return this.fetchWithTimeout(url.toString()).then(r => r.html);
      })));
      const fallbackHtmls = fallbackPages
        .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
        .map(result => result.value);
      discovered = [...new Set(fallbackHtmls.flatMap(html => parseSearchResults(html, targetKeywords)))];
    }

    if (discovered.length === 0) {
      throw new LeadGenerationError("Поиск не вернул сайты компаний. Укажите конкретные сайты или повторите позже.");
    }
    const byHost = new Map<string, string>();
    for (const c of discovered) {
      try {
        const u = new URL(c);
        const host = u.hostname.replace(/^www\./, "").toLowerCase();
        if (!byHost.has(host)) byHost.set(host, new URL("/", u).toString());
      } catch {}
    }
    return [...byHost.values()].slice(0, this.config.maxCandidates);
  }

  private async analyzeCompany(url: string, criteria: LeadCriteria): Promise<CompanyLead | undefined> {
    const page = await this.fetchWithTimeout(url);
    const $ = load(page.html);
    $("script, style, noscript, svg").remove();
    const pageText = cleanText($("body").text(), 200_000);
    if (!hasOfficialSiteSignals($, pageText)) return undefined;
    if (shouldExclude(pageText, criteria)) return undefined;

    const country = countryDomainMatch(criteria, pageText, page.finalUrl);
    if (country.conflicting) return undefined;

    let region = detectRegion(pageText, criteria, page.finalUrl);
    const analyzedTexts = [new URL(page.finalUrl).hostname, $("title").text(), pageText];

    const contacts = extractTelegramContacts(page.html, page.finalUrl);
    const companyContacts = extractCompanyContacts(page.html, page.finalUrl);
    const contactPages = findContactPageUrls($, page.finalUrl).slice(0, this.config.maxContactPages);

    // Параллельный обход контактных страниц
    for (let i = 0; i < contactPages.length; i += this.config.contactPagesParallelism) {
      const batch = contactPages.slice(i, i + this.config.contactPagesParallelism);
      const results = await Promise.allSettled(
        batch.map(cp => this.fetchWithTimeout(cp))
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          const cp = result.value;
          const cp$ = load(cp.html);
          cp$("script, style, noscript, svg").remove();
          const cpText = cleanText(cp$("body").text(), 200_000);
          analyzedTexts.push(cpText);
          contacts.push(...extractTelegramContacts(cp.html, cp.finalUrl));
          companyContacts.push(...extractCompanyContacts(cp.html, cp.finalUrl));
          if (!region) region = detectRegion(cpText, criteria, cp.finalUrl);
        }
      }
    }

    const uniqueContacts = mergeTelegramContacts(contacts);
    const mergedContacts = companyContacts.filter((c, idx, arr) =>
      arr.findIndex(x => x.kind === c.kind && x.value.toLowerCase() === c.value.toLowerCase()) === idx
    );

    const ranking = scoreCompany(analyzedTexts.join(" "), criteria, regionTerms(criteria).length === 0 || Boolean(region), mergedContacts.length);
    if (ranking.matchKind === "similar") return undefined;
    if (country.requested && !country.matched && !region) return undefined;

    const description = cleanText(
      $("meta[name='description']").attr("content") ??
      $("meta[property='og:description']").attr("content") ??
      pageText,
      300
    );

    return {
      companyName: $("meta[property='og:site_name']").attr("content") ||
        $("meta[name='application-name']").attr("content") ||
        cleanText($("title").text().split(/[|—–-]/)[0] ?? "", 100) ||
        cleanText($("h1").first().text(), 100) ||
        new URL(page.finalUrl).hostname.replace(/^www\./, ""),
      siteName: new URL(page.finalUrl).hostname.replace(/^www\./, ""),
      website: page.finalUrl,
      description,
      relevance: `${ranking.matchKind === "exact" ? "Точное" : "Частичное"} совпадение (${ranking.score}%). Ключевые признаки: ${ranking.matchedKeywords.join(", ")}. Предложение пользователя: ${criteria.offer}.`,
      ...(region ? { region } : {}),
      relevanceScore: ranking.score,
      matchKind: ranking.matchKind,
      matchedKeywords: ranking.matchedKeywords,
      contacts: mergedContacts,
      telegramContacts: uniqueContacts,
    };
  }

  async generateLeads(criteria: LeadCriteria): Promise<LeadGenerationResult> {
    const candidates = await this.searchCandidateUrls(criteria);
    const settled: PromiseSettledResult<CompanyLead | undefined>[] = [];

    for (let i = 0; i < candidates.length; i += this.config.siteAnalysisParallelism) {
      const batch = candidates.slice(i, i + this.config.siteAnalysisParallelism);
      settled.push(...await Promise.allSettled(batch.map(url => this.analyzeCompany(url, criteria))));
    }

    const leads: CompanyLead[] = [];
    const warnings: string[] = [];
    settled.forEach((res, idx) => {
      if (res.status === "fulfilled") {
        if (res.value && res.value.matchKind !== "similar") leads.push(res.value);
      } else {
        const host = (() => { try { return new URL(candidates[idx] ?? "").hostname } catch { return "неизвестный сайт" } })();
        warnings.push(`${host}: сайт не удалось проанализировать`);
      }
    });

    leads.sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0)
      || Number((b.contacts?.length ?? 0) > 0) - Number((a.contacts?.length ?? 0) > 0));

    return { criteria, leads, analyzedSites: settled.length, warnings };
  }
}

// ======================= Экспорт функций обратной совместимости =======================
const defaultGenerator = new LeadGenerator();

export async function generateLeads(criteria: LeadCriteria): Promise<LeadGenerationResult> {
  return defaultGenerator.generateLeads(criteria);
}

// ======================= Форматирование отчётов =======================

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function formatLeadReport(result: LeadGenerationResult): string {
  const { leads } = result;
  const sections = leads.map((lead, i) => {
    const allContacts = lead.contacts ?? lead.telegramContacts.map(c => ({
      kind: "telegram" as const, value: c.handle, role: c.role, label: c.label, sourceUrl: c.sourceUrl,
    }));
    const people = allContacts
      .filter(c => c.kind === "person" && ["director", "sales", "manager"].includes(c.role))
      .map(c => `${c.value} (${ROLE_LABELS[c.role]})${c.sourceUrl ? `; источник: ${c.sourceUrl}` : ""}`);
    const contacts = allContacts.filter(c => c.kind !== "person" && c.kind !== "telegram").map(c =>
      `${c.value}${c.role !== "unknown" ? ` (${ROLE_LABELS[c.role]})` : ""}${c.sourceUrl ? `; источник: ${c.sourceUrl}` : ""}`
    );
    const telegram = lead.telegramContacts.map(c =>
      `${c.handle}${c.role !== "unknown" ? ` (${ROLE_LABELS[c.role]})` : ""}${c.sourceUrl ? `; источник: ${c.sourceUrl}` : ""}`
    );
    return [
      `## ${i + 1}. ${oneLine(lead.companyName)}`,
      `- Название компании: ${oneLine(lead.companyName)}`,
      `- Название сайта: ${lead.siteName}`,
      `- Сайт: ${lead.website}`,
      lead.region ? `- Регион: ${lead.region}` : "",
      `- Совпадение: ${lead.matchKind ?? "не оценено"}, ${lead.relevanceScore ?? 0}%`,
      people.length > 0 ? `- Руководители / владельцы / менеджеры: ${people.join("; ")}` : "",
      telegram.length > 0 ? `- Публичные Telegram-контакты: ${telegram.join("; ")}` : "",
      contacts.length > 0 ? `- Другие контакты компании: ${contacts.join("; ")}` : "",
    ].filter(Boolean).join("\n");
  });

  return [
    `Проанализировано сайтов: ${result.analyzedSites}`,
    ...sections,
    leads.length === 0 ? "Подходящие сайты не удалось проанализировать." : "",
  ].filter(Boolean).join("\n\n");
}

export function formatLeadCsv(result: LeadGenerationResult): string {
  const rows = result.leads.map(lead => {
    const contacts = lead.contacts ?? [];
    const people = contacts
      .filter(c => c.kind === "person" && ["director", "sales", "manager"].includes(c.role))
      .map(c => `${c.value} — ${ROLE_LABELS[c.role]}${c.sourceUrl ? ` — ${c.sourceUrl}` : ""}`);
    const comm = contacts
      .filter(c => c.kind !== "person" && c.kind !== "telegram")
      .map(c => `${c.value}${c.role !== "unknown" ? ` — ${ROLE_LABELS[c.role]}` : ""}${c.sourceUrl ? ` — ${c.sourceUrl}` : ""}`);
    comm.unshift(...lead.telegramContacts.map(tc =>
      `${tc.handle}${tc.role !== "unknown" ? ` — ${ROLE_LABELS[tc.role]}` : ""}${tc.sourceUrl ? ` — ${tc.sourceUrl}` : ""}`
    ));
    return [lead.companyName, lead.website, lead.region ?? "", lead.matchKind ?? "", String(lead.relevanceScore ?? ""), people.join("; "), comm.join("; ")]
      .map(v => `"${oneLine(v).replaceAll('"', '""')}"`).join(",");
  });
  return `\uFEFF${["Название компании,Сайт,Регион,Тип совпадения,Релевантность %,Управляющие люди владельцы менеджеры,Контакты", ...rows].join("\r\n")}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

/**
 * Возвращает HTML-строку с таблицей лидов.
 * При сохранении в файл с расширением .doc Microsoft Word откроет его как документ.
 */
export function formatLeadHtml(result: LeadGenerationResult): string {
  const leads = result.leads.filter(lead => lead.matchKind !== "similar");
  const rows = leads.map(lead => {
    const contacts = lead.contacts ?? [];
    const people = contacts
      .filter(c => c.kind === "person" && ["director", "sales", "manager"].includes(c.role))
      .map(c => `${c.value} — ${ROLE_LABELS[c.role]}${c.sourceUrl ? ` (источник: ${c.sourceUrl})` : ""}`)
      .join("; ");
    const comm = contacts
      .filter(c => c.kind !== "person" && c.kind !== "telegram")
      .map(c => `${c.value}${c.role !== "unknown" ? ` — ${ROLE_LABELS[c.role]}` : ""}${c.sourceUrl ? ` (источник: ${c.sourceUrl})` : ""}`);
    const telegram = lead.telegramContacts.map(tc =>
      `${tc.handle}${tc.role !== "unknown" ? ` — ${ROLE_LABELS[tc.role]}` : ""}${tc.sourceUrl ? ` (источник: ${tc.sourceUrl})` : ""}`
    );
    const communication = [...telegram, ...comm].join("; ");
    return `<tr>
      <td>${escapeHtml(oneLine(lead.companyName))}</td>
      <td><a href="${escapeHtml(lead.website)}">${escapeHtml(lead.website)}</a></td>
      <td>${escapeHtml(lead.region ?? "")}</td>
      <td>${escapeHtml(lead.matchKind ?? "")}</td>
      <td>${lead.relevanceScore ?? ""}%</td>
      <td>${escapeHtml(people)}</td>
      <td>${escapeHtml(communication)}</td>
    </tr>`;
  }).join("\n");

  return `﻿<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" lang="ru">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <title>Лиды</title>
  <style>
    @page { size: A4 landscape; margin: 1.5cm; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 10pt; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #999; padding: 6px; text-align: left; vertical-align: top; }
    th { background: #eee; }
  </style>
</head>
<body>
  <h1>Результат поиска лидов</h1>
  <p>Проанализировано сайтов: ${result.analyzedSites}</p>
  <p>В документ включены только точные и частичные совпадения. Похожие компании исключены.</p>
  <table>
    <thead>
      <tr>
        <th>Компания</th><th>Сайт</th><th>Регион</th><th>Совпадение</th><th>Релевантность</th>
        <th>Люди</th><th>Контакты / Telegram</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="7">Нет данных</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;
}


export { LeadGenerator as LeadGeneratorClass };
