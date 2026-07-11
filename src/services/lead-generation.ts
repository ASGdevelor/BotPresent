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
  maxCandidates: 100,
  maxContactPages: 8,
  contactPagesParallelism: 4,
  siteAnalysisParallelism: 6,
  requestTimeoutMs: 10000,
};

// ======================= Константы =======================
const SEARCH_ENDPOINT = "https://www.bing.com/search";
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

function criteriaKeywords(criteria: LeadCriteria): string[] {
  return [...new Set(`${criteria.whoToFind} ${criteria.whoCanBuy}`
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
  const keywords = criteriaKeywords(criteria);
  const matchedKeywords = keywords.filter(kw => normalized.includes(kw));
  const ratio = keywords.length > 0 ? matchedKeywords.length / keywords.length : 0.5;
  const score = Math.min(100, Math.round(15 + ratio * 65 + (regionMatched ? 15 : 0) + (contacts > 0 ? 5 : 0)));
  const matchKind = ratio >= 0.6 && regionMatched ? "exact" : ratio >= 0.28 ? "partial" : "similar";
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
  const urls: string[] = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const hint = `${href ?? ""} ${$(el).text()}`;
    if (!href || !CONTACT_HINT.test(hint)) return;

    try {
      const url = new URL(href, base);
      if (url.hostname !== base.hostname || !["http:", "https:"].includes(url.protocol)) return;
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
    if (val.length >= 10 && val.length <= 16) add({ kind: "phone", value: val, role: inferContactRole(text.slice(Math.max(0, text.indexOf(rawPhone) - 100), text.indexOf(rawPhone) + rawPhone.length + 100)), sourceUrl });
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

  async searchCandidateUrls(criteria: LeadCriteria): Promise<string[]> {
    const explicitUrls = extractExplicitUrls(criteria.whereToSearch);
    if (explicitUrls.length > 0) return explicitUrls.slice(0, this.config.maxCandidates);

    const queries = [
      `${criteria.whoToFind} ${criteria.whereToSearch} компания официальный сайт контакты`,
      `"${criteria.whoToFind}" ${criteria.whereToSearch} официальный сайт`,
      `${criteria.whoToFind} ${criteria.whereToSearch} каталог компаний`,
      `${criteria.whoToFind} ${criteria.whereToSearch} контакты руководство`,
      `${criteria.whoCanBuy} ${criteria.whereToSearch} официальный сайт`,
      `${criteria.whoToFind} похожие компании ${criteria.whereToSearch}`,
      `${criteria.offer} потенциальные клиенты ${criteria.whoToFind} ${criteria.whereToSearch}`,
      `${criteria.whoToFind} поставщики производители дистрибьюторы ${criteria.whereToSearch}`,
    ];

    const pages = await Promise.allSettled(
      queries.map((q, i) => {
        const endpoint = i % 2 === 0 ? SEARCH_ENDPOINT : DUCK_SEARCH_ENDPOINT;
        const url = new URL(endpoint);
        url.searchParams.set("q", q);
        return this.fetchWithTimeout(url.toString()).then(r => r.html);
      })
    );

    const htmls = pages.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled").map(r => r.value);
    if (htmls.length === 0) throw new LeadGenerationError("Поиск недоступен. Укажите конкретные сайты или повторите позже.");

    const discovered = [...new Set(htmls.flatMap(parseSearchResults))];
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
    if (shouldExclude(pageText, criteria)) return undefined;

    let region = detectRegion(pageText, criteria, page.finalUrl);
    const analyzedTexts = [pageText];

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

    const description = cleanText(
      $("meta[name='description']").attr("content") ??
      $("meta[property='og:description']").attr("content") ??
      pageText,
      300
    );

    return {
      companyName: $("meta[property='og:site_name']").attr("content") ||
        $("meta[name='application-name']").attr("content") ||
        cleanText($("h1").first().text(), 100) ||
        cleanText($("title").text().split(/[|—–-]/)[0] ?? "", 100) ||
        new URL(page.finalUrl).hostname.replace(/^www\./, ""),
      siteName: new URL(page.finalUrl).hostname.replace(/^www\./, ""),
      website: page.finalUrl,
      description: description || "Описание на сайте не найдено.",
      relevance: `${ranking.matchKind === "exact" ? "Точное" : ranking.matchKind === "partial" ? "Частичное" : "Похожее"} совпадение (${ranking.score}%): ${ranking.matchedKeywords.join(", ") || "по контексту ниши"}. Предложение: ${criteria.offer}.`,
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
        if (res.value) leads.push(res.value);
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
    const people = allContacts.filter(c => c.kind === "person").map(c => `${c.value} (${ROLE_LABELS[c.role]})`);
    const contacts = allContacts.filter(c => c.kind !== "person").map(c =>
      `${c.value}${c.role !== "unknown" ? ` (${ROLE_LABELS[c.role]})` : ""}${c.sourceUrl ? `; источник: ${c.sourceUrl}` : ""}`
    );
    return [
      `## ${i + 1}. ${oneLine(lead.companyName)}`,
      `- Название компании: ${oneLine(lead.companyName)}`,
      `- Название сайта: ${lead.siteName}`,
      `- Сайт: ${lead.website}`,
      `- Регион: ${lead.region ?? "подтверждён на сайте не был"}`,
      `- Совпадение: ${lead.matchKind ?? "не оценено"}, ${lead.relevanceScore ?? 0}%`,
      `- Управляющие люди / владельцы / менеджеры: ${people.join("; ") || "не найдены"}`,
      `- Контакты: ${contacts.join("; ") || "не найдены"}`,
      `- Публичные Telegram-контакты: ${lead.telegramContacts.length > 0 ? lead.telegramContacts.map(c => c.handle).join("; ") : "не найдены"}`,
    ].join("\n");
  });

  return [
    `Проанализировано сайтов: ${result.analyzedSites}`,
    `Компаний без Telegram-контакта: ${leads.filter(l => l.telegramContacts.length === 0).length}`,
    ...sections,
    leads.length === 0 ? "Подходящие сайты не удалось проанализировать." : "",
  ].filter(Boolean).join("\n\n");
}

export function formatLeadCsv(result: LeadGenerationResult): string {
  const rows = result.leads.map(lead => {
    const contacts = lead.contacts ?? [];
    const people = contacts.filter(c => c.kind === "person").map(c => `${c.value} — ${ROLE_LABELS[c.role]}`);
    const comm = contacts.filter(c => c.kind !== "person").map(c => `${c.value}${c.role !== "unknown" ? ` — ${ROLE_LABELS[c.role]}` : ""}`);
    if (comm.length === 0) comm.push(...lead.telegramContacts.map(tc => tc.handle));
    return [lead.companyName, lead.website, lead.region ?? "", lead.matchKind ?? "", String(lead.relevanceScore ?? ""), people.join("; "), comm.join("; ")]
      .map(v => `"${oneLine(v).replaceAll('"', '""')}"`).join(",");
  });
  return `\uFEFF${["Название компании,Сайт,Регион,Тип совпадения,Релевантность %,Управляющие люди владельцы менеджеры,Контакты", ...rows].join("\r\n")}`;
}

/**
 * Возвращает HTML-строку с таблицей лидов.
 * При сохранении в файл с расширением .doc Microsoft Word откроет его как документ.
 */
export function formatLeadHtml(result: LeadGenerationResult): string {
  const rows = result.leads.map(lead => {
    const contacts = lead.contacts ?? [];
    const people = contacts.filter(c => c.kind === "person").map(c => `${c.value} — ${ROLE_LABELS[c.role]}`).join("; ");
    const comm = contacts.filter(c => c.kind !== "person").map(c => `${c.value} — ${ROLE_LABELS[c.role]}`).join("; ");
    const tg = lead.telegramContacts.map(tc => tc.handle).join("; ");
    return `<tr>
      <td>${oneLine(lead.companyName)}</td>
      <td><a href="${lead.website}">${lead.website}</a></td>
      <td>${lead.region ?? ""}</td>
      <td>${lead.matchKind ?? ""}</td>
      <td>${lead.relevanceScore ?? ""}%</td>
      <td>${people || "—"}</td>
      <td>${comm || tg || "—"}</td>
    </tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Лиды</title>
  <style>
    body { font-family: 'Segoe UI', Tahoma, sans-serif; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #999; padding: 6px; text-align: left; vertical-align: top; }
    th { background: #eee; }
  </style>
</head>
<body>
  <h1>Результат поиска лидов</h1>
  <p>Проанализировано сайтов: ${result.analyzedSites}</p>
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
