import { randomUUID } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "cheerio";
import { fetchPublicCss, fetchPublicHtml, fetchPublicXml, parsePublicHttpUrl, PublicWebError } from "./public-web";
import { safeFilePart } from "../utils";

export interface PresentationFile {
  path: string;
  name: string;
}

export interface PresentationRecord {
  id: string;
  userId: number;
  companyName: string;
  website: string;
  createdAt: string;
  updatedAt: string;
  htmlPath: string;
  pdfPath?: string;
  sources?: string[];
  researchStatus?: "verified" | "not-found";
  preferences?: PresentationPreferences;
}

export interface IndustryFact {
  label: string;
  value: number;
  displayValue: string;
  unit?: string;
  year?: number;
  qualityScore?: number;
  sourceUrl: string;
  sourceTitle: string;
  origin?: "website" | "research";
}

export interface WebsiteFacts {
  companyName: string;
  website: string;
  description: string;
  headings: string[];
  services: string[];
  contacts: string[];
  sources: string[];
  accent?: string;
  // НОВОЕ: изображения и дополнительные данные
  logoUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
  statistics: {
    label: string;
    value: string;
    displayValue?: string;
    unit?: string;
    sourceUrl?: string;
  }[];
  advantages: string[];
  testimonial?: string;      // одна цитата-отзыв
  industry?: string;
  industryFacts?: IndustryFact[];
  productImages?: string[];
}

export interface PresentationContext {
  leadRelevance?: string;
}

export type PresentationThemeId = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10";

export interface PresentationPreferences {
  themeId: PresentationThemeId;
  fontFamily: string;
  productImages: Record<string, string>;
  pageEdits: Record<string, string>;
}

export interface PresentationEditOptions {
  themeId?: string;
  fontFamily?: string;
  productImage?: { index: number; url: string };
  pageEdit?: { page: number; text: string };
}

interface PresentationTheme {
  id: PresentationThemeId;
  name: string;
  mode: "light" | "dark";
  primary?: string;
  secondary?: string;
  background: string;
  backgroundEnd: string;
  ink: string;
  muted: string;
  line: string;
  soft: string;
  paper: string;
  panel: string;
}

export const PRESENTATION_THEMES: readonly PresentationTheme[] = [
  { id: "1", name: "Фирменная светлая", mode: "light", background: "#f4f7f5", backgroundEnd: "#ffffff", ink: "#17201b", muted: "#66736b", line: "#dce5df", soft: "#f5f8f6", paper: "#ffffff", panel: "#102b1b" },
  { id: "2", name: "Океан светлая", mode: "light", primary: "#146c94", secondary: "#d8f0fa", background: "#edf8fc", backgroundEnd: "#ffffff", ink: "#102531", muted: "#607580", line: "#cfe1e9", soft: "#f2f9fc", paper: "#ffffff", panel: "#0b405a" },
  { id: "3", name: "Фиолетовая светлая", mode: "light", primary: "#6d4cc3", secondary: "#ebe4ff", background: "#f5f1ff", backgroundEnd: "#ffffff", ink: "#241c35", muted: "#716982", line: "#ded5ef", soft: "#f8f5ff", paper: "#ffffff", panel: "#3b276f" },
  { id: "4", name: "Янтарная светлая", mode: "light", primary: "#a85c00", secondary: "#ffebc7", background: "#fff8eb", backgroundEnd: "#ffffff", ink: "#302213", muted: "#7d6b58", line: "#eadbc5", soft: "#fffaf2", paper: "#ffffff", panel: "#633900" },
  { id: "5", name: "Розовая светлая", mode: "light", primary: "#b23a65", secondary: "#ffe0eb", background: "#fff2f6", backgroundEnd: "#ffffff", ink: "#311c24", muted: "#7d6670", line: "#ead4dc", soft: "#fff7fa", paper: "#ffffff", panel: "#6b203b" },
  { id: "6", name: "Фирменная тёмная", mode: "dark", background: "#0d1410", backgroundEnd: "#121b16", ink: "#f3f7f4", muted: "#a8b6ad", line: "#304038", soft: "#17221c", paper: "#141f19", panel: "#09100c" },
  { id: "7", name: "Океан тёмная", mode: "dark", primary: "#40b9ee", secondary: "#163c4d", background: "#07151d", backgroundEnd: "#0d202a", ink: "#eefaff", muted: "#9db6c2", line: "#294653", soft: "#102832", paper: "#0d222c", panel: "#051016" },
  { id: "8", name: "Фиолетовая тёмная", mode: "dark", primary: "#a98aff", secondary: "#392d5f", background: "#100c1d", backgroundEnd: "#1a132c", ink: "#f8f4ff", muted: "#b5a9ca", line: "#44375b", soft: "#241b36", paper: "#1d162c", panel: "#0b0812" },
  { id: "9", name: "Янтарная тёмная", mode: "dark", primary: "#ffb84d", secondary: "#54391a", background: "#171109", backgroundEnd: "#241a0d", ink: "#fff8eb", muted: "#c8b79c", line: "#55432c", soft: "#2c2114", paper: "#231a10", panel: "#100b05" },
  { id: "10", name: "Красная тёмная", mode: "dark", primary: "#ff6685", secondary: "#572535", background: "#190b10", backgroundEnd: "#291119", ink: "#fff3f6", muted: "#c8a8b0", line: "#58323d", soft: "#301820", paper: "#28131a", panel: "#110609" },
] as const;

export const PRESENTATION_FONTS = [
  "Open Sans", "Inter", "Arial", "Georgia", "Times New Roman",
  "Verdana", "Trebuchet MS", "Tahoma", "Roboto", "Montserrat",
] as const;

export type PresentationProgress = (percent: number, stage: string) => void | Promise<void>;

// Путь к шаблону теперь можно переопределить через переменную окружения
const APP_ROOT = path.resolve(import.meta.dir, "..", "..");
const PRESENTATIONS_ROOT = path.join(APP_ROOT, "data", "presentations");
const BUNDLED_TEMPLATE_ROOT = path.join(APP_ROOT, "Generic");
const WORKSPACE_TEMPLATE_ROOT = path.resolve(APP_ROOT, "..", "TestSite", "Generic");

async function templateRoot(): Promise<string> {
  // 1. Переменная окружения
  if (process.env.PRESENTATION_TEMPLATE_ROOT) {
    try {
      await access(path.join(process.env.PRESENTATION_TEMPLATE_ROOT, "index.html"));
      return process.env.PRESENTATION_TEMPLATE_ROOT;
    } catch {}
  }
  // 2. Репозиторный шаблон: его маркеры соответствуют renderHtml.
  try {
    await access(path.join(BUNDLED_TEMPLATE_ROOT, "index.html"));
    return BUNDLED_TEMPLATE_ROOT;
  } catch {}
  // 3. Совместимость со старым рабочим окружением (рядом с репозиторием).
  try {
    await access(path.join(WORKSPACE_TEMPLATE_ROOT, "index.html"));
    return WORKSPACE_TEMPLATE_ROOT;
  } catch {}
  // 4. Последний fallback.
  return BUNDLED_TEMPLATE_ROOT;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] ?? char);
}

function clean(value: string, max = 500): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeWebsite(value: string): string {
  const candidate = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
  return parsePublicHttpUrl(candidate).toString();
}

function defaultPreferences(existing?: Partial<PresentationPreferences>): PresentationPreferences {
  const themeId = PRESENTATION_THEMES.some((theme) => theme.id === existing?.themeId)
    ? existing!.themeId as PresentationThemeId
    : "1";
  const fontFamily = PRESENTATION_FONTS.includes(existing?.fontFamily as typeof PRESENTATION_FONTS[number])
    ? existing!.fontFamily!
    : "Open Sans";
  return {
    themeId,
    fontFamily,
    productImages: { ...(existing?.productImages ?? {}) },
    pageEdits: { ...(existing?.pageEdits ?? {}) },
  };
}

function applyEditOptions(
  current: PresentationPreferences,
  options?: PresentationEditOptions,
): PresentationPreferences {
  const next = defaultPreferences(current);
  if (options?.themeId) {
    const theme = PRESENTATION_THEMES.find((item) => item.id === options.themeId);
    if (!theme) throw new Error("Цветовая схема должна быть от 1 до 10.");
    next.themeId = theme.id;
  }
  if (options?.fontFamily) {
    const font = PRESENTATION_FONTS.find((item) => item.toLocaleLowerCase("ru") === options.fontFamily!.trim().toLocaleLowerCase("ru"));
    if (!font) throw new Error(`Недоступный шрифт. Выберите: ${PRESENTATION_FONTS.join(", ")}.`);
    next.fontFamily = font;
  }
  if (options?.productImage) {
    if (!Number.isInteger(options.productImage.index) || options.productImage.index < 1 || options.productImage.index > 4) {
      throw new Error("Номер изображения должен быть от 1 до 4.");
    }
    const imageUrl = parsePublicHttpUrl(options.productImage.url).toString();
    next.productImages[String(options.productImage.index)] = imageUrl;
  }
  if (options?.pageEdit) {
    if (!Number.isInteger(options.pageEdit.page) || options.pageEdit.page < 1 || options.pageEdit.page > 8) {
      throw new Error("Номер страницы должен быть от 1 до 8.");
    }
    const text = clean(options.pageEdit.text, 2000);
    if (!text) delete next.pageEdits[String(options.pageEdit.page)];
    else next.pageEdits[String(options.pageEdit.page)] = text;
  }
  return next;
}

function resolveTheme(facts: WebsiteFacts, preferences: PresentationPreferences): PresentationTheme & {
  primary: string;
  secondary: string;
} {
  const theme = PRESENTATION_THEMES.find((item) => item.id === preferences.themeId) ?? PRESENTATION_THEMES[0]!;
  const primary = theme.primary ?? facts.primaryColor ?? "#2a5c8e";
  const secondary = theme.secondary ?? facts.secondaryColor ?? "#dfe9e3";
  return { ...theme, primary, secondary };
}

export function presentationThemeList(): string {
  return PRESENTATION_THEMES.map((theme) => `${theme.id}. ${theme.name} (${theme.mode === "light" ? "белый фон" : "тёмный фон"})`).join("\n");
}

function dedupe(values: string[], limit: number): string[] {
  return [...new Set(values.map((value) => clean(value)).filter((value) => value.length >= 3))].slice(0, limit);
}

function normalizeCssColor(value: string): string | undefined {
  const color = value.trim().toLowerCase();
  if (/^#[\da-f]{6}$/i.test(color)) return color;
  if (/^#[\da-f]{3}$/i.test(color)) {
    return `#${color.slice(1).split("").map((part) => part.repeat(2)).join("")}`;
  }
  const rgb = color.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (!rgb) return undefined;
  const channels = rgb.slice(1, 4).map((part) => Math.min(255, Number(part)));
  return `#${channels.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

function colorScore(hex: string): number {
  const channels = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((part) => Number.parseInt(part, 16));
  const spread = Math.max(...channels) - Math.min(...channels);
  const lightness = channels.reduce((sum, part) => sum + part, 0) / 3;
  return spread - Math.abs(lightness - 128) * 0.15;
}

export function extractBrandColors(css: string, preferred?: string): [string | undefined, string | undefined] {
  const candidates = [preferred ?? "", ...(css.match(/#[\da-f]{3,8}\b|rgba?\([^)]*\)/gi) ?? [])]
    .map(normalizeCssColor)
    .filter((color): color is string => Boolean(color))
    .filter((color) => !["#ffffff", "#000000", "#f0f0f0"].includes(color));
  const counts = new Map<string, number>();
  for (const color of candidates) counts.set(color, (counts.get(color) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => {
    if (preferred && a[0] === normalizeCssColor(preferred)) return -1;
    if (preferred && b[0] === normalizeCssColor(preferred)) return 1;
    return (b[1] + colorScore(b[0]) / 100) - (a[1] + colorScore(a[0]) / 100);
  }).map(([color]) => color);
  return [ranked[0], ranked.find((color) => color !== ranked[0])];
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  return values.find((value) => Boolean(value?.trim()))?.trim() ?? "";
}

function publicAssetUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return parsePublicHttpUrl(url.toString()).toString();
  } catch {
    return undefined;
  }
}

function jsonLdLogoUrls($: ReturnType<typeof load>): string[] {
  const result: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    const logo = object.logo;
    if (typeof logo === "string") result.push(logo);
    else if (logo && typeof logo === "object") {
      const logoObject = logo as Record<string, unknown>;
      const url = logoObject.url ?? logoObject.contentUrl;
      if (typeof url === "string") result.push(url);
    }
    if (object["@graph"]) visit(object["@graph"]);
  };
  $("script[type='application/ld+json']").each((_, node) => {
    try { visit(JSON.parse($(node).text())); } catch { /* invalid JSON-LD is ignored */ }
  });
  return result;
}

export interface WebsiteIdentity {
  companyName: string;
  description: string;
  headings: string[];
  industry: string;
  logoUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
  productImages: string[];
}

/** Pure parser used by the network collector and deterministic fixture tests. */
export function extractWebsiteIdentity(html: string, finalUrl: string, externalCss = ""): WebsiteIdentity {
  const $ = load(html);
  const headings = $("h1,h2,h3").map((_, node) => $(node).text()).get();
  const industry = inferIndustry($, headings);
  const inlineCss = $("style").map((_, node) => $(node).text()).get().join("\n");
  const themeColor = clean($("meta[name='theme-color']").attr("content") ?? "", 30);
  const [primaryColor, extractedSecondary] = extractBrandColors(
    `${inlineCss}\n${externalCss}\n${$("[style]").map((_, node) => $(node).attr("style") ?? "").get().join("\n")}`,
    themeColor,
  );
  const hostname = new URL(finalUrl).hostname.replace(/^www\./, "");
  const titleName = $("title").text().split(/\s+[|—–-]\s+|\|/)[0];
  const discoveredName = firstNonEmpty(
    $("meta[property='og:site_name']").attr("content"),
    $("meta[name='application-name']").attr("content"),
    $("h1").first().text(),
    titleName,
  );
  const companyName = clean(
    `${discoveredName} ${$("title").text()}`.toLowerCase().includes(hostname.toLowerCase())
      ? `${hostname.charAt(0).toUpperCase()}${hostname.slice(1)}`
      : discoveredName,
    120,
  ) || hostname;
  const description = clean(firstNonEmpty(
    $("meta[name='description']").attr("content"),
    $("meta[property='og:description']").attr("content"),
    $("main").first().text(),
    $("body").text(),
  ), 900);
  const logoCandidates = [
    ...jsonLdLogoUrls($),
    $("img[itemprop='logo']").first().attr("src"),
    $("img[class*='logo' i], [class*='logo' i] img, header img").first().attr("src"),
    $("meta[itemprop='logo']").attr("content"),
    $("meta[property='og:image']").attr("content"),
    $("link[rel='apple-touch-icon']").attr("href"),
    $("link[rel='icon']").attr("href"),
    $("link[rel='shortcut icon']").attr("href"),
  ];
  const logoUrl = logoCandidates.map((value) => publicAssetUrl(value, finalUrl)).find(Boolean);
  const productImages = dedupe($("main img[src], section img[src]").map((_, node) => (
    publicAssetUrl($(node).attr("src"), finalUrl) ?? ""
  )).get().filter((url) => url !== logoUrl), 4);

  return {
    companyName,
    description: description || "Описание на официальном сайте не найдено.",
    headings: dedupe(headings, 12),
    industry,
    logoUrl,
    primaryColor,
    secondaryColor: extractedSecondary ?? (primaryColor ? adjustColor(primaryColor, 0.82) : undefined),
    productImages,
  };
}

export function isRelatedCompanyPage(href: string, label: string): boolean {
  let pathname = "";
  try { pathname = new URL(href, "https://example.com").pathname.toLowerCase(); } catch { return false; }
  const pathMatch = /(?:^|\/)(?:about|company|contacts?|team|management|o-nas|o-kompanii)(?:\/|$)/i.test(pathname);
  const textMatch = /(?:^|\s)(?:о нас|о компании|контакты|команда|руководство)(?:\s|$)/i.test(clean(label, 160));
  return pathMatch || textMatch;
}

function inferIndustry($: ReturnType<typeof load>, headings: string[]): string {
  const schemaIndustries: string[] = [];
  $("script[type='application/ld+json']").each((_, node) => {
    try {
      const parsed = JSON.parse($(node).text()) as Record<string, unknown>;
      const values = Array.isArray(parsed) ? parsed : [parsed];
      for (const value of values) {
        if (typeof value.industry === "string") schemaIndustries.push(value.industry);
      }
    } catch { /* некорректный JSON-LD не мешает анализу сайта */ }
  });
  const keywords = ($("meta[name='keywords']").attr("content") ?? "").split(",");
  const categories = [
    $("meta[name='category']").attr("content") ?? "",
    $("meta[property='article:section']").attr("content") ?? "",
  ];
  const explicit = dedupe([...schemaIndustries, ...keywords, ...categories], 1)[0];
  if (explicit) return explicit;
  // Only high-confidence category terms are accepted from free text. A generic
  // h1 (for example, a company name) must not start unrelated web research.
  const corpus = clean([
    $("title").text(),
    $("meta[name='description']").attr("content") ?? "",
    ...headings.slice(0, 4),
  ].join(" "), 2_000).toLocaleLowerCase("ru");
  const inferred: Array<[RegExp, string]> = [
    [/интернет[-\s]?аптек|\bаптек[аиуы]?\b|лекарств/i, "фармацевтический рынок и интернет-аптеки"],
    [/стоматолог/i, "стоматология"],
    [/недвижимост|риелтор|застройщик/i, "рынок недвижимости"],
    [/логистик|грузоперевоз/i, "логистика и грузоперевозки"],
    [/строительств|стройматериал/i, "строительный рынок"],
  ];
  return inferred.find(([pattern]) => pattern.test(corpus))?.[1] ?? "отрасль компании";
}

function normalizeFactUnit(rawUnit: string, currency: string): string {
  const unit = rawUnit.toLocaleLowerCase("ru").replace(/\.$/, "").trim();
  const normalizedCurrency = currency.toLocaleLowerCase("ru");
  const money = /₽|руб|rub/.test(normalizedCurrency);
  const dollars = /\$|usd|доллар/.test(normalizedCurrency);
  const euros = /€|eur|евро/.test(normalizedCurrency);
  const currencySuffix = money ? "₽" : dollars ? "$" : euros ? "€" : "";
  if (unit === "%" || /процент/.test(unit)) return "%";
  if (/трлн|триллион|trillion|\btn\b/.test(unit)) return `трлн${currencySuffix ? ` ${currencySuffix}` : ""}`;
  if (/млрд|миллиард|billion|\bbn\b/.test(unit)) return `млрд${currencySuffix ? ` ${currencySuffix}` : ""}`;
  if (/млн|миллион|million|\bmn\b/.test(unit)) return `млн${currencySuffix ? ` ${currencySuffix}` : ""}`;
  if (/тыс|тысяч|thousand|\bk\b/.test(unit)) return `тыс${currencySuffix ? ` ${currencySuffix}` : ""}`;
  return unit;
}

export function sourceQualityScore(sourceUrl: string): number {
  const hostname = new URL(sourceUrl).hostname.replace(/^www\./, "").toLowerCase();
  if (/\.gov\.ru$|^rosstat\.gov\.ru$|^cbr\.ru$|^minzdrav\.gov\.ru$|^fedstat\.ru$|^data\.gov\.ru$/.test(hostname)) return 45;
  if (/\.edu$|\.edu\.ru$|\.ac\.|eec\.eaeunion\.org$|worldbank\.org$|who\.int$|oecd\.org$/.test(hostname)) return 38;
  if (/dsm\.ru$|rbc\.ru$|vedomosti\.ru$|kommersant\.ru$|tadviser\.ru$/.test(hostname)) return 30;
  if (/wikipedia\.org$|wikidata\.org$/.test(hostname)) return 18;
  if (/youtube|vk\.com$|tiktok|instagram|facebook|pinterest/.test(hostname)) return -30;
  return 22;
}

export function parseVerifiedNumericFacts(html: string, sourceUrl: string): IndustryFact[] {
  const page = load(html);
  page("script,style,noscript,svg").remove();
  const title = clean(page("h1").first().text() || page("title").text(), 120);
  const facts: IndustryFact[] = [];
  const currentYear = new Date().getUTCFullYear();
  page("p,td,li,dd,figcaption").each((_, node) => {
    const sentence = clean(page(node).text(), 300);
    if (sentence.length < 20) return;
    const marketContext = /рынок|об[ъь][её]м|продаж|выручк|оборот|аудитор|покупател|клиент|потребител|спрос|заказ|посещаем|насчитыва|количеств|число\s+(?:компан|аптек|клиник|магазин)|рост|вырос|снизил|динамик|доля\s+(?:рынка|продаж|онлайн)/i.test(sentence);
    const ownershipContext = /дол[яю]\s+(?:в\s+)?(?:компани|капитал)|акци[йи]|акционер|консолидирова|владеет|структур[аы]\s+капитала|результат[еы]?\s+сделк|инвестици[йи]\s+в\s+компани/i.test(sentence);
    const sectorContext = /рынок|отрасл|сегмент|росси[ияй]|по\s+стране|совокупн|общ(?:ий|ая)\s+об[ъь][её]м|насчитыва|количеств|число\s+(?:компан|аптек|клиник|магазин)|доля\s+(?:рынка|продаж|онлайн)/i.test(sentence);
    const companyFinancialContext = /\b(?:ООО|АО|ПАО|ЗАО)\b|выручка\s+(?:компании|сервис|ООО|АО)|оборот\s+[«"]?[\p{L}\d.-]+[»"]?/iu.test(sentence);
    const catalogContext = /ассортимент|каталог|товар(?:ов|а)|лекарственн(?:ых|ые)\s+средств|sku|наименовани[йя]/i.test(sentence);
    const industryScopeContext = /рынок|отрасл|сегмент|совокупн|общ(?:ий|ая)\s+об[ъь][её]м|доля\s+(?:рынка|продаж|онлайн)/i.test(sentence);
    if (!marketContext || ownershipContext || (companyFinancialContext && !sectorContext) || (catalogContext && !industryScopeContext)) return;
    const pattern = /(?:^|[\s(])(?:(₽|руб(?:лей|ля|\.)?|rub|\$|usd|доллар(?:ов|а)?|€|eur|евро)\s*)?(\d{1,3}(?:[\s.](?:\d{3})(?!\d))*(?:[,.]\d+)?)\s*(%|процент(?:а|ов)?|трлн\.?|млрд\.?|млн\.?|тыс\.?|триллион(?:ов|а)?|миллион(?:ов|а)?|миллиард(?:ов|а)?|тысяч(?:а|и)?|trillion|billion|million|thousand|tn|bn|mn|k)\s*(₽|руб(?:лей|ля|\.)?|rub|\$|usd|доллар(?:ов|а)?|€|eur|евро)?/gi;
    for (const match of sentence.matchAll(pattern)) {
      const normalized = match[2]?.replace(/[\s.](?=\d{3}(?:\D|$))/g, "").replace(",", ".") ?? "";
      const value = Number.parseFloat(normalized);
      if (!Number.isFinite(value) || value < 0) continue;
      const unit = normalizeFactUnit(match[3] ?? "", `${match[1] ?? ""} ${match[4] ?? ""}`);
      const yearMatch = sentence.match(/\b(20\d{2})\b/);
      const parsedYear = yearMatch ? Number(yearMatch[1]) : undefined;
      const year = parsedYear && parsedYear >= 2018 && parsedYear <= currentYear + 1 ? parsedYear : undefined;
      const recency = year ? Math.max(0, 18 - Math.max(0, currentYear - year) * 3) : 0;
      const contextScore = Math.min(20, Math.round(sentence.length / 20));
      facts.push({
        label: sentence,
        value,
        displayValue: `${match[2]} ${unit}`,
        unit,
        ...(year ? { year } : {}),
        qualityScore: sourceQualityScore(sourceUrl) + recency + contextScore,
        sourceUrl,
        sourceTitle: title || new URL(sourceUrl).hostname,
        origin: "research",
      });
    }
  });
  return facts.slice(0, 20);
}

function normalizeWebsiteStatisticUnit(rawUnit: string, currency: string): string {
  const numericUnit = normalizeFactUnit(rawUnit, currency);
  if (numericUnit !== rawUnit.toLocaleLowerCase("ru").replace(/\.$/, "").trim()) return numericUnit;
  const unit = rawUnit.toLocaleLowerCase("ru").replace(/\.$/, "").trim();
  if (/клиент|покупател|пользовател/.test(unit)) return "клиентов";
  if (/проект|заказ/.test(unit)) return "проектов";
  if (/сотрудник|специалист/.test(unit)) return "сотрудников";
  if (/партн[её]р/.test(unit)) return "партнёров";
  if (/офис|филиал|магазин|аптек|клиник/.test(unit)) return "точек";
  if (/стран|город|регион/.test(unit)) return "регионов";
  if (/лет|год/.test(unit)) return "лет";
  return unit;
}

/** Извлекает только подписанные показатели с официального сайта компании. */
export function parseWebsiteStatistics(html: string, sourceUrl: string): WebsiteFacts["statistics"] {
  const page = load(html);
  page("script,style,noscript,svg").remove();
  const results: WebsiteFacts["statistics"] = [];
  const seen = new Set<string>();
  const pattern = /(?:^|[\s(])(?:(₽|руб(?:лей|ля|\.)?|rub|\$|usd|€|eur)\s*)?(\d{1,3}(?:[\s.](?:\d{3})(?!\d))*(?:[,.]\d+)?)\s*(%|процент(?:а|ов)?|трлн\.?|млрд\.?|млн\.?|тыс\.?|клиент(?:ов|а)?|покупател(?:ей|я)?|пользовател(?:ей|я)?|проект(?:ов|а)?|заказ(?:ов|а)?|сотрудник(?:ов|а)?|специалист(?:ов|а)?|партн[её]р(?:ов|а)?|офис(?:ов|а)?|филиал(?:ов|а)?|магазин(?:ов|а)?|аптек(?:а|и)?|клиник(?:а|и)?|стран(?:а|ы)?|город(?:ов|а)?|регион(?:ов|а)?|лет|год(?:а|ов)?)\s*(₽|руб(?:лей|ля|\.)?|rub|\$|usd|€|eur)?/gi;

  page("h1,h2,h3,p,li,dd,[class*='stat'],[class*='number'],[class*='metric'],[class*='counter']").each((_, node) => {
    const sentence = clean(page(node).text(), 260);
    if (sentence.length < 6 || sentence.length > 260) return;
    for (const match of sentence.matchAll(pattern)) {
      const normalized = match[2]?.replace(/[\s.](?=\d{3}(?:\D|$))/g, "").replace(",", ".") ?? "";
      const value = Number.parseFloat(normalized);
      if (!Number.isFinite(value) || value < 0) continue;
      const unit = normalizeWebsiteStatisticUnit(match[3] ?? "", `${match[1] ?? ""} ${match[4] ?? ""}`);
      const key = `${value}|${unit}|${sentence.toLocaleLowerCase("ru").replace(/\d+/g, "#")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        label: sentence,
        value: String(value),
        displayValue: `${match[2]} ${unit}`.trim(),
        unit,
        sourceUrl,
      });
      if (results.length >= 10) return false;
    }
  });
  return results;
}

function dedupeWebsiteStatistics(
  statistics: WebsiteFacts["statistics"],
  limit: number,
): WebsiteFacts["statistics"] {
  const unique = new Map<string, WebsiteFacts["statistics"][number]>();
  for (const statistic of statistics) {
    const key = `${statistic.value}|${statistic.unit ?? ""}|${clean(statistic.label, 100).toLocaleLowerCase("ru").replace(/\d+/g, "#")}`;
    if (!unique.has(key)) unique.set(key, statistic);
  }
  return [...unique.values()].slice(0, limit);
}

function unwrapSearchResultUrl(href: string | undefined, baseUrl: string): string | undefined {
  if (!href) return undefined;
  try {
    const result = new URL(href, baseUrl);
    let unwrapped = result.hostname.endsWith("duckduckgo.com")
      ? result.searchParams.get("uddg") ?? result.toString()
      : result.toString();
    if (result.hostname.endsWith("bing.com")) {
      const encoded = result.searchParams.get("u");
      if (encoded?.startsWith("a1")) {
        try { unwrapped = Buffer.from(encoded.slice(2), "base64url").toString("utf8"); } catch { /* keep original */ }
      }
    }
    if (result.hostname.endsWith("google.com") && result.pathname === "/url") {
      unwrapped = result.searchParams.get("q") ?? result.searchParams.get("url") ?? result.toString();
    }
    const url = publicAssetUrl(unwrapped, baseUrl);
    if (!url) return undefined;
    return /(?:duckduckgo|google|bing)\./i.test(new URL(url).hostname) ? undefined : url;
  } catch {
    return undefined;
  }
}

export interface ResearchResult {
  url: string;
  title: string;
  snippet: string;
}

/** Читает и обычную HTML-выдачу, и RSS; сниппеты служат резервом, если страница источника недоступна. */
export function parseResearchResults(html: string, baseUrl: string): ResearchResult[] {
  const page = load(html);
  const xml = load(html, { xmlMode: true });
  const results = new Map<string, ResearchResult>();
  const add = (url: string | undefined, title: string, snippet: string): void => {
    if (!url || results.has(url)) return;
    const snippetText = snippet.includes("<") ? load(snippet).root().text() : snippet;
    results.set(url, { url, title: clean(title, 180), snippet: clean(snippetText, 600) });
  };

  page(".result, .b_algo, .g, .mw-search-result").each((_, node) => {
    const item = page(node);
    const anchor = item.find(".result__a[href], a[data-testid='result-title-a'][href], h2 a[href], h3 a[href], a:has(h3)").first();
    add(
      unwrapSearchResultUrl(anchor.attr("href"), baseUrl),
      anchor.text() || item.find("h2,h3").first().text(),
      item.find(".result__snippet, .b_caption p, .VwiC3b, p").first().text(),
    );
  });

  page(".result__a[href], a[data-testid='result-title-a'][href], .mw-search-result-heading a[href], .b_algo h2 a[href], .g a[href], a[data-ved][href], a:has(h3), a[href^='/url?']").each((_, node) => {
    const anchor = page(node);
    const container = anchor.closest(".result, .b_algo, .g, .mw-search-result");
    add(
      unwrapSearchResultUrl(anchor.attr("href"), baseUrl),
      anchor.text() || anchor.find("h3").text(),
      container.find(".result__snippet, .b_caption p, .VwiC3b, p").first().text(),
    );
  });

  xml("item").each((_, node) => {
    const item = xml(node);
    add(
      publicAssetUrl(item.find("link").first().text(), baseUrl),
      item.find("title").first().text(),
      item.find("description").first().text(),
    );
  });
  return [...results.values()].slice(0, 10);
}

export function parseResearchResultUrls(html: string, baseUrl: string): string[] {
  return parseResearchResults(html, baseUrl).map((result) => result.url).slice(0, 6);
}

export function buildResearchQueries(industry: string, companyName?: string): string[] {
  const normalizedIndustry = clean(industry, 160);
  const researchSubject = /аптек|фармацевт|лекарств/i.test(normalizedIndustry)
    ? `${normalizedIndustry} фармацевтический рынок ePharma`
    : normalizedIndustry;
  const currentYear = new Date().getUTCFullYear();
  const previousYear = currentYear - 1;
  const authoritativeDomains = /аптек|фармацевт|лекарств/i.test(normalizedIndustry)
    ? "site:dsm.ru OR site:rncph.ru OR site:minzdrav.gov.ru OR site:rosstat.gov.ru"
    : "site:rosstat.gov.ru OR site:fedstat.ru OR site:cbr.ru";
  const queries = [
    `${researchSubject} Россия объем рынка статистика ${previousYear} ${currentYear}`,
    `${researchSubject} Россия доля продажи аудитория исследование ${previousYear} ${currentYear} проценты`,
    `${researchSubject} Россия количество компаний клиентов динамика ${previousYear} ${currentYear} млн млрд`,
    `${researchSubject} ${authoritativeDomains} объем продажи ${previousYear} ${currentYear}`,
    ...(companyName ? [`"${clean(companyName, 100)}" показатели компания рынок ${previousYear} ${currentYear}`] : []),
  ];
  return dedupe(queries, 5);
}

export function buildFallbackResearchQueries(industry: string, companyName?: string): string[] {
  const normalizedIndustry = clean(industry, 160);
  const researchSubject = /аптек|фармацевт|лекарств/i.test(normalizedIndustry)
    ? `${normalizedIndustry} фармацевтический рынок ePharma`
    : normalizedIndustry;
  const currentYear = new Date().getUTCFullYear();
  const years = [currentYear - 3, currentYear - 2, currentYear - 1, currentYear].join(" ");
  return dedupe([
    `"${researchSubject}" Россия обзор рынка отчет filetype:pdf ${currentYear}`,
    `"${researchSubject}" динамика рынок продажи ${years}`,
    `"${researchSubject}" Росстат ЕМИСС статистика показатель`,
    `"${researchSubject}" исследование аудитория спрос доля рост`,
    ...(companyName ? [`"${clean(companyName, 100)}" отрасль исследование статистика`] : []),
  ], 5);
}

export function isResearchPageRelevant(html: string, industry: string): boolean {
  const page = load(html);
  const context = clean(firstNonEmpty(
    page("title").text(),
    page("h1").first().text(),
    page("meta[name='description']").attr("content"),
  ), 700).toLocaleLowerCase("ru").replace(/ё/g, "е");
  const ignored = new Set(["рынок", "статистика", "отрасль", "компания", "бизнес", "интернет", "онлайн"]);
  const keywords = [...new Set(industry.toLocaleLowerCase("ru").replace(/ё/g, "е")
    .split(/[^\p{L}\d]+/u)
    .filter((word) => word.length >= 4 && !ignored.has(word))
    .map((word) => word.replace(/(?:иями|ями|ами|ого|ему|ому|ыми|ими|ов|ев|ах|ях|ой|ый|ий|ая|яя|ое|ее|а|я|ы|и)$/u, ""))
    .map((word) => word.length > 7 ? word.slice(0, 6) : word)
    .filter((word) => word.length >= 4))];
  if (keywords.length === 0) return false;
  const matched = keywords.filter((keyword) => context.includes(keyword)).length;
  return matched >= 1;
}

function industryMetricKind(fact: IndustryFact): string {
  const label = fact.label.toLocaleLowerCase("ru");
  const unit = fact.unit?.toLocaleLowerCase("ru") ?? "";
  if (unit === "%") {
    if (/дол[яию]|удельн/.test(label)) return "share";
    if (/рост|вырос|увелич|сниз|сократ|динамик|темп/.test(label)) return "change";
    return "percentage";
  }
  if (/[₽$€]|руб|rub|usd|eur/.test(unit)) return "volume";
  if (/заказ|количеств|число|насчитыва|точек|аптек|магазин|клиник/.test(label)) return "count";
  if (/аудитор|клиент|покупател|пользовател|посещ/.test(label)) return "audience";
  if (/объем|объём|выруч|оборот|продаж|рынок/.test(label)) return "volume";
  if (/рост|вырос|увелич|сниз|сократ|динамик|темп/.test(label)) return "change";
  return "other";
}

function industryMetricPeriod(fact: IndustryFact): "period" | "year" | "unspecified" {
  const label = fact.label.toLocaleLowerCase("ru");
  if (/месяц|квартал|январ|феврал|март(?:а|е)?|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр|начал\s+год/.test(label)) return "period";
  if (/за\s+20\d{2}\s+год|в\s+20\d{2}\s+(?:году|г\.)|годов(?:ой|ая)|за\s+год/.test(label)) return "year";
  return "unspecified";
}

function comparableMetricPeriod(fact: IndustryFact): "period" | "year" | "unspecified" {
  return ["count", "volume", "audience"].includes(industryMetricKind(fact))
    ? industryMetricPeriod(fact)
    : "unspecified";
}

function selectIndustryFacts(facts: IndustryFact[]): IndustryFact[] {
  const unique = new Map<string, IndustryFact>();
  for (const fact of facts.sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0))) {
    const key = `${industryMetricKind(fact)}|${comparableMetricPeriod(fact)}|${fact.unit ?? ""}|${fact.value}|${fact.year ?? ""}`;
    if (!unique.has(key)) unique.set(key, fact);
  }
  const selected: IndustryFact[] = [];
  const perSource = new Map<string, number>();
  for (const fact of unique.values()) {
    const count = perSource.get(fact.sourceUrl) ?? 0;
    if (count >= 3) continue;
    selected.push(fact);
    perSource.set(fact.sourceUrl, count + 1);
    if (selected.length >= 14) break;
  }
  return selected;
}

async function searchIndustryFacts(queries: string[], industry: string): Promise<IndustryFact[]> {
  const requests = queries.flatMap((query) => {
    const encoded = encodeURIComponent(query);
    return [
      fetchPublicHtml(`https://html.duckduckgo.com/html/?q=${encoded}`),
      fetchPublicXml(`https://www.bing.com/search?format=rss&cc=ru&setlang=ru-RU&q=${encoded}`)
        .then((result) => ({ html: result.xml, finalUrl: result.finalUrl })),
      fetchPublicXml(`https://news.google.com/rss/search?q=${encoded}&hl=ru&gl=RU&ceid=RU:ru`)
        .then((result) => ({ html: result.xml, finalUrl: result.finalUrl })),
    ];
  });
  const searches = await Promise.allSettled(requests);
  const searchResults = searches.flatMap((result) => (
    result.status === "fulfilled" ? parseResearchResults(result.value.html, result.value.finalUrl) : []
  ));
  const snippetFacts = searchResults.flatMap((result) => {
    if (!result.snippet) return [];
    const snippetHtml = `<title>${escapeHtml(result.title)}</title><meta name="description" content="${escapeHtml(result.snippet)}"><p>${escapeHtml(result.snippet)}</p>`;
    return isResearchPageRelevant(snippetHtml, industry)
      ? parseVerifiedNumericFacts(snippetHtml, result.url).map((fact) => ({
          ...fact,
          qualityScore: (fact.qualityScore ?? 0) - 8,
        }))
      : [];
  });
  const resultUrls = dedupe(searchResults.map((result) => result.url), 40)
    .sort((a, b) => sourceQualityScore(b) - sourceQualityScore(a))
    .slice(0, 18);
  const pages = await Promise.allSettled(resultUrls.map((url) => fetchPublicHtml(url)));
  const pageFacts = pages.flatMap((result) => (
    result.status === "fulfilled" && isResearchPageRelevant(result.value.html, industry)
      ? parseVerifiedNumericFacts(result.value.html, result.value.finalUrl)
      : []
  ));
  return [...pageFacts, ...snippetFacts];
}

async function collectIndustryFacts(industry: string, companyName?: string): Promise<IndustryFact[]> {
  if (!industry || industry === "отрасль компании") return [];
  const relevanceTopic = /аптек|фармацевт|лекарств/i.test(industry)
    ? `${industry} фармацевтический рынок ePharma`
    : industry;
  const primaryFacts = await searchIndustryFacts(buildResearchQueries(industry, companyName), relevanceTopic);
  let selected = selectIndustryFacts(primaryFacts);
  const comparableGroups = groupComparableIndustryFacts(selected).filter((group) => group.length >= 2);
  if (selected.length < 6 || comparableGroups.length < 2) {
    const fallbackFacts = await searchIndustryFacts(buildFallbackResearchQueries(industry, companyName), relevanceTopic);
    selected = selectIndustryFacts([...primaryFacts, ...fallbackFacts]);
  }
  return selected.slice(0, 12);
}

export function parseBingWebsiteSnapshot(html: string, website: string): WebsiteFacts | undefined {
  const target = parsePublicHttpUrl(website);
  const targetHost = target.hostname.replace(/^www\./, "").toLowerCase();
  const page = load(html);
  const xml = load(html, { xmlMode: true });
  const matchesTarget = (url: string | undefined): url is string => {
    if (!url) return false;
    try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase() === targetHost; } catch { return false; }
  };
  const htmlItems = page(".b_algo").map((_, node) => {
    const item = page(node);
    const url = unwrapSearchResultUrl(item.find("h2 a[href]").first().attr("href"), "https://www.bing.com/search");
    return matchesTarget(url) ? { url, title: item.find("h2").first().text(), description: item.find("p, .b_caption").first().text() } : undefined;
  }).get().filter((item): item is { url: string; title: string; description: string } => Boolean(item));
  const rssItems = xml("item").map((_, node) => {
    const item = xml(node);
    const url = publicAssetUrl(item.find("link").first().text(), website);
    return matchesTarget(url) ? { url, title: item.find("title").first().text(), description: item.find("description").first().text() } : undefined;
  }).get().filter((item): item is { url: string; title: string; description: string } => Boolean(item));
  const items = [...htmlItems, ...rssItems];
  if (items.length === 0) return undefined;
  const resultUrls = dedupe(items.map((item) => item.url), 8);
  const titles = dedupe(items.map((item) => item.title), 10);
  const snippets = dedupe(items.map((item) => item.description), 12);
  const brand = targetHost.split(".")[0] ?? targetHost;
  const companyName = `${brand.charAt(0).toUpperCase()}${brand.slice(1)}.${targetHost.split(".").slice(1).join(".")}`;
  const description = clean(snippets.join(" "), 900) || "Описание получено из поискового индекса Bing; исходный сайт временно недоступен через DNS.";
  const industry = clean(titles[0] ?? "", 120) || "отрасль компании";
  const numberPattern = /(\d{1,3}(?:[\s.,]\d{3})*(?:[,.]\d+)?)\s*(лет|года?|проектов|клиентов|аптек|городов|стран|%)/gi;
  const statistics = [...description.matchAll(numberPattern)].slice(0, 6).map((match) => ({
    value: match[1]?.replace(/\s/g, "") ?? "",
    label: match[2] ?? "показатель из Bing",
  }));
  return {
    companyName,
    website: target.toString(),
    description,
    headings: titles,
    services: titles.slice(1, 9),
    contacts: [],
    sources: dedupe(resultUrls.length > 0 ? resultUrls : [target.toString()], 8),
    logoUrl: new URL("/favicon.ico", target).toString(),
    statistics,
    advantages: [],
    industry,
    industryFacts: [],
    productImages: [],
  };
}

async function collectWebsiteFactsFromBing(input: string, progress?: PresentationProgress): Promise<WebsiteFacts> {
  const website = normalizeWebsite(input);
  const host = new URL(website).hostname;
  await progress?.(18, `DNS сайта ${host} недоступен, ищу точный домен в Bing`);
  const query = encodeURIComponent(`site:${host}`);
  const searches = await Promise.allSettled([
    fetchPublicHtml(`https://www.bing.com/search?q=${query}`).then((result) => result.html),
    fetchPublicXml(`https://www.bing.com/search?format=rss&q=${query}`).then((result) => result.xml),
  ]);
  const snapshot = searches.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
    .map((document) => parseBingWebsiteSnapshot(document, website))
    .find((value): value is WebsiteFacts => Boolean(value));
  if (!snapshot) {
    throw new PublicWebError(`DNS сайта ${host} недоступен, и Bing не вернул данных по этому домену.`, { code: "DNS_LOOKUP" });
  }
  await progress?.(40, "Данные сайта восстановлены из поискового индекса Bing");
  const industryFacts = await collectIndustryFacts(snapshot.industry ?? "", snapshot.companyName);
  snapshot.industryFacts = industryFacts;
  snapshot.sources = dedupe([
    ...snapshot.sources,
    ...industryFacts.map((fact) => fact.sourceUrl),
  ], 8);
  await progress?.(52, "Факты и источники собраны");
  return snapshot;
}

async function collectWebsiteFacts(input: string, progress?: PresentationProgress): Promise<WebsiteFacts> {
  await progress?.(5, "Проверяю ссылку");
  const website = normalizeWebsite(input);
  let home: Awaited<ReturnType<typeof fetchPublicHtml>>;
  try {
    home = await fetchPublicHtml(website);
  } catch (error) {
    if (error instanceof PublicWebError && error.code === "FETCH_FAILED") {
      try {
        await progress?.(12, "Основной адрес временно недоступен, пробую вариант с www");
        const alternate = new URL(website);
        if (!alternate.hostname.startsWith("www.")) alternate.hostname = `www.${alternate.hostname}`;
        home = await fetchPublicHtml(alternate.toString());
      } catch (alternateError) {
        if (alternateError instanceof PublicWebError && ["DNS_LOOKUP", "FETCH_FAILED"].includes(alternateError.code ?? "")) {
          return collectWebsiteFactsFromBing(website, progress);
        }
        throw alternateError;
      }
    } else if (error instanceof PublicWebError && error.code === "DNS_LOOKUP") {
      return collectWebsiteFactsFromBing(website, progress);
    } else {
      throw error;
    }
  }
  await progress?.(20, "Главная страница загружена");
  const $ = load(home.html);
  const stylesheetUrls = dedupe($("link[rel~='stylesheet'][href]").map((_, node) => {
    return publicAssetUrl($(node).attr("href"), home.finalUrl) ?? "";
  }).get(), 3);
  const stylesheetResults = await Promise.allSettled(stylesheetUrls.map((url) => fetchPublicCss(url)));
  const externalCss = stylesheetResults.flatMap((result) => result.status === "fulfilled" ? [result.value.css] : []).join("\n");
  const identity = extractWebsiteIdentity(home.html, home.finalUrl, externalCss);
  const headings = [...identity.headings];
  const industry = identity.industry;
  const statistics = parseWebsiteStatistics(home.html, home.finalUrl);
  $("script, style, noscript, svg").remove();

  // Услуги – расширенный поиск
  const serviceSelectors = "main li, section li, [class*='service'], [class*='product'], .card, .feature";
  const services = $(serviceSelectors).map((_, node) => $(node).text()).get();

  // Контакты (уже было)
  const contacts = [
    ...$("a[href^='mailto:']").map((_, node) => ($(node).attr("href") ?? "").replace(/^mailto:/, "").split("?")[0] ?? "").get(),
    ...$("a[href^='tel:']").map((_, node) => clean($(node).text()) || ($(node).attr("href") ?? "").replace(/^tel:/, "")).get(),
    ...$("a[href*='t.me/']").map((_, node) => $(node).attr("href") ?? "").get(),
  ];

  // Связанные страницы (about, contact...)
  const relatedUrls = dedupe($("a[href]").map((_, node) => {
    const href = $(node).attr("href");
    if (!href || !isRelatedCompanyPage(href, $(node).text())) return "";
    try {
      const url = new URL(href, home.finalUrl);
      return url.hostname === new URL(home.finalUrl).hostname ? url.toString() : "";
    } catch { return ""; }
  }).get(), 4);

  const sources = [home.finalUrl];
  const relatedPages = await Promise.allSettled(relatedUrls.map((url) => fetchPublicHtml(url)));
  for (const [index, result] of relatedPages.entries()) {
    if (result.status !== "fulfilled") continue;
    const related = load(result.value.html);
    headings.push(...related("h1,h2,h3").map((_, node) => related(node).text()).get());
    services.push(...related(serviceSelectors).map((_, node) => related(node).text()).get());
    contacts.push(
      ...related("a[href^='mailto:']").map((_, node) => (related(node).attr("href") ?? "").replace(/^mailto:/, "").split("?")[0] ?? "").get(),
      ...related("a[href^='tel:']").map((_, node) => clean(related(node).text()) || (related(node).attr("href") ?? "").replace(/^tel:/, "")).get(),
      ...related("a[href*='t.me/']").map((_, node) => related(node).attr("href") ?? "").get(),
    );
    statistics.push(...parseWebsiteStatistics(result.value.html, result.value.finalUrl));
    sources.push(result.value.finalUrl);
    await progress?.(25 + Math.round(((index + 1) / Math.max(1, relatedPages.length)) * 24), "Анализирую услуги, контакты и разделы сайта");
  }

  const advantages: string[] = [];
  $("ul:contains('преимуществ'), ul:contains('почему'), ul:contains('выбирают'), ul:contains('отличие') li").each((_, el) => {
    advantages.push(clean($(el).text(), 200));
  });
  if (advantages.length === 0) {
    // fallback: выделяем строки с иконкой или маркером
    $("li").each((_, el) => {
      const txt = clean($(el).text(), 200);
      if (/преимущество|достоинство|гарантия|сертификат|опыт|качество/i.test(txt)) advantages.push(txt);
    });
  }

  const testimonial = $("blockquote, .testimonial, .review, [class*='отзыв']").first().text().trim() || undefined;

  await progress?.(50, "Ищу проверяемые отраслевые данные и источники");
  const industryFacts = await collectIndustryFacts(industry, identity.companyName);
  sources.push(...industryFacts.map((fact) => fact.sourceUrl));

  await progress?.(55, "Факты и источники собраны");

  return {
    companyName: identity.companyName,
    website: home.finalUrl,
    description: identity.description,
    headings: dedupe(headings, 12),
    services: dedupe(services, 10),
    contacts: dedupe(contacts, 12),
    // Keep the official site first, but reserve room for the external source
    // that actually backs the chart data. Related company pages must not push
    // the research source out of presentation.json/message history.
    sources: dedupe([
      home.finalUrl,
      ...industryFacts.map((fact) => fact.sourceUrl),
      ...sources,
    ], 8),
    accent: identity.primaryColor,
    logoUrl: identity.logoUrl,
    primaryColor: identity.primaryColor,
    secondaryColor: identity.secondaryColor,
    statistics: dedupeWebsiteStatistics(statistics, 8),
    advantages: dedupe(advantages, 8),
    testimonial: testimonial ? clean(testimonial, 300) : undefined,
    industry,
    industryFacts,
    productImages: identity.productImages,
  };
}

// Простейшая функция для осветления цвета (для вторичного)
function adjustColor(hex: string, amount: number): string {
  // если не hex, вернём серый
  if (!/^#[\da-f]{3,8}$/i.test(hex)) return "#f0f0f0";
  let r = 0, g = 0, b = 0;
  const h = hex.substring(1);
  if (h.length === 3) {
    r = parseInt((h[0] ?? "0") + (h[0] ?? "0"), 16);
    g = parseInt((h[1] ?? "0") + (h[1] ?? "0"), 16);
    b = parseInt((h[2] ?? "0") + (h[2] ?? "0"), 16);
  } else if (h.length === 6) {
    r = parseInt(h.substring(0, 2), 16);
    g = parseInt(h.substring(2, 4), 16);
    b = parseInt(h.substring(4, 6), 16);
  }
  r = Math.min(255, Math.round(r + (255 - r) * amount));
  g = Math.min(255, Math.round(g + (255 - g) * amount));
  b = Math.min(255, Math.round(b + (255 - b) * amount));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// Генерация простых индикаторов (полос) для статистики
function statsHtml(stats: WebsiteFacts["statistics"]): string {
  if (stats.length === 0) return "";
  const maxVal = Math.max(...stats.map(s => Number(s.value) || 1), 1);
  return stats.map(s => {
    const pct = Math.round((Number(s.value) / maxVal) * 100);
    return `<div class="stat-bar">
      <span class="stat-label">${escapeHtml(s.label)}: ${s.value}</span>
      <div class="bar-bg"><div class="bar-fill" style="width:${pct}%"></div></div>
    </div>`;
  }).join("");
}

function advantagesHtml(items: string[]): string {
  return items.map(i => `<li>${escapeHtml(i)}</li>`).join("");
}

function testimonialHtml(text?: string): string {
  return text ? `<blockquote>${escapeHtml(text)}</blockquote>` : "";
}

function accentForWebsite(facts: WebsiteFacts): string {
  if (facts.primaryColor) return facts.primaryColor;
  return "#44515c";
}

function listHtml(items: string[], fallback: string): string {
  const values = items.length > 0 ? items : [fallback];
  return values.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n");
}

function cardsHtml(items: string[], fallback: string): string {
  const values = items.length > 0 ? items : [fallback];
  return values.slice(0, 9).map((item, index) => `<div class="card"><div class="metric">${String(index + 1).padStart(2, "0")}</div><p>${escapeHtml(item)}</p></div>`).join("\n");
}

function itemAt(items: string[], index: number, fallback: string): string {
  return items[index] ?? items[0] ?? fallback;
}

function kpiHtml(value: string, label: string): string {
  return `<div class="kpi"><div class="n">${escapeHtml(value)}</div><div class="l">${escapeHtml(label)}</div></div>`;
}

function comparisonItems(items: string[], symbol: "+" | "−"): string {
  return items.map((item) => `<div class="vli"><span class="ic">${symbol}</span><span>${escapeHtml(item)}</span></div>`).join("\n");
}

function matrixSteps(items: string[]): string {
  const values = items.length > 0 ? items.slice(0, 4) : ["Знакомство", "Польза", "Доказательство", "Призыв к действию"];
  return values.map((item, index) => `<div class="stp"><div class="sn">${index + 1}</div><div class="st">${escapeHtml(item)}</div><div class="sd">Тема для проверки в первой серии материалов</div></div>`).join("\n");
}

function offerMetrics(facts: WebsiteFacts): string {
  return [
    [String(Math.max(1, facts.services.length)), "направлений для теста"],
    ["90 дней", "пилотный период"],
    ["1 сайт", "источник фактов"],
  ].map(([value, label]) => `<div><div class="n">${escapeHtml(value ?? "")}</div><div class="l">${escapeHtml(label ?? "")}</div></div>`).join("\n");
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

export function groupComparableIndustryFacts(facts: IndustryFact[]): IndustryFact[][] {
  const byUnit = new Map<string, IndustryFact[]>();
  for (const fact of facts) {
    const unit = fact.unit ?? (fact.displayValue.replace(String(fact.value), "").trim() || "показатель");
    const metric = industryMetricKind(fact);
    const key = `${metric}|${comparableMetricPeriod(fact)}|${unit.toLocaleLowerCase("ru")}`;
    const group = byUnit.get(key) ?? [];
    group.push(fact);
    byUnit.set(key, group);
  }
  const groups = [...byUnit.values()]
    .map((items) => items.sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0)))
    .sort((a, b) => b.length - a.length || (b[0]?.qualityScore ?? 0) - (a[0]?.qualityScore ?? 0));
  return groups.flatMap((items) => {
    const chunks: IndustryFact[][] = [];
    for (let index = 0; index < items.length; index += 4) chunks.push(items.slice(index, index + 4));
    return chunks;
  }).sort((a, b) => b.length - a.length);
}

export interface PresentationChart {
  title: string;
  sourceText: string;
  data: string;
}

function chartTitle(items: IndustryFact[], fromWebsite: boolean): string {
  if (items.length === 0) return "Проверяемые числовые данные не найдены";
  const prefix = fromWebsite ? "Данные официального сайта" : "Данные интернет-исследования";
  const metric = industryMetricKind(items[0]!);
  const period = comparableMetricPeriod(items[0]!);
  const suffix = period === "year" ? " за год" : period === "period" ? " за отдельный период" : "";
  if (metric === "share" || metric === "percentage") return `${prefix}: доли и проценты${suffix}`;
  if (metric === "change") return `${prefix}: динамика${suffix}`;
  if (metric === "volume") return `${prefix}: объём и продажи${suffix}`;
  if (metric === "audience") return `${prefix}: аудитория и клиенты${suffix}`;
  if (metric === "count") return `${prefix}: количество и заказы${suffix}`;
  return `${prefix}: открытые показатели`;
}

function chartSourceText(items: IndustryFact[]): string {
  const sources = dedupe(items.map((item) => (
    `${item.sourceTitle}${item.year ? ` (${item.year})` : ""}: ${item.sourceUrl}`
  )), 3);
  return sources.length > 0
    ? sources.join(" · ")
    : "После основного и расширенного интернет-поиска сопоставимые данные не найдены; значения не выдумываются.";
}

function chartData(items: IndustryFact[], primary: string, secondary: string): string {
  if (items.length === 0) {
    return safeJson({
      labels: ["Проверяемые числовые данные не найдены"],
      datasets: [{ data: [0], unit: "", sourceUrls: [], backgroundColor: [primary], borderColor: [primary], borderWidth: 1, borderRadius: 10 }],
    });
  }
  return safeJson({
    labels: items.map((item) => clean(`${item.year ? `${item.year}: ` : ""}${item.label}`, 80)),
    datasets: [{
      data: items.map((item) => item.value),
      unit: items[0]?.unit ?? "",
      sourceUrls: items.map((item) => item.sourceUrl),
      backgroundColor: items.map((_, index) => index % 2 === 0 ? primary : secondary),
      borderColor: items.map((_, index) => index % 2 === 0 ? primary : secondary),
      borderWidth: 1,
      borderRadius: 10,
    }],
  });
}

export function buildPresentationCharts(facts: WebsiteFacts, primary: string, secondary: string): PresentationChart[] {
  const researchGroups = groupComparableIndustryFacts(facts.industryFacts ?? []);
  const websiteFacts: IndustryFact[] = facts.statistics.flatMap((statistic) => {
    const value = Number.parseFloat(statistic.value.replace(",", "."));
    if (!Number.isFinite(value)) return [];
    return [{
      label: statistic.label,
      value,
      displayValue: statistic.displayValue ?? `${statistic.value} ${statistic.unit ?? ""}`.trim(),
      unit: statistic.unit,
      qualityScore: 35,
      sourceUrl: statistic.sourceUrl ?? facts.website,
      sourceTitle: `Официальный сайт ${facts.companyName}`,
      origin: "website" as const,
    }];
  });
  const websiteGroups = groupComparableIndustryFacts(websiteFacts);
  const groups = [
    ...researchGroups.map((items) => ({ items, fromWebsite: false })),
    ...websiteGroups.map((items) => ({ items, fromWebsite: true })),
  ];

  return Array.from({ length: 7 }, (_, index) => {
    const group = groups[index];
    const items = group?.items ?? [];
    return {
      title: chartTitle(items, group?.fromWebsite ?? false),
      sourceText: chartSourceText(items),
      data: chartData(items, primary, secondary),
    };
  });
}

function industrySourceText(facts: WebsiteFacts): string {
  const sources = dedupe((facts.industryFacts ?? []).map((fact) => (
    `${fact.sourceTitle}${fact.year ? ` (${fact.year})` : ""}: ${fact.sourceUrl}`
  )), 6);
  return sources.length > 0 ? sources.join(" · ") : "Внешний проверяемый источник с числовыми данными не найден; график показывает нулевой fallback.";
}

function contactHref(contact: string | undefined, website: string): string {
  if (!contact) return website;
  if (/^https:\/\//i.test(contact)) return contact;
  if (contact.includes("@")) return `mailto:${contact}`;
  if (/^\+?[\d\s()-]{6,}$/.test(contact)) return `tel:${contact.replace(/[^\d+]/g, "")}`;
  return website;
}

/** Заполняет как компактный, так и расширенный Generic-шаблон. */
export function renderPresentationTemplate(
  template: string,
  facts: WebsiteFacts,
  context?: PresentationContext,
  generatedAt = new Date(),
  preferencesInput?: Partial<PresentationPreferences>,
): string {
  const preferences = defaultPreferences(preferencesInput);
  const theme = resolveTheme(facts, preferences);
  const charts = buildPresentationCharts(facts, theme.primary, theme.secondary);
  const services = facts.services.length > 0 ? facts.services : facts.headings;
  const industry = facts.industry ?? itemAt(services, 0, "направление компании");
  const fallbackLogo = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="96"><rect width="100%" height="100%" rx="16" fill="${theme.secondary}"/><text x="50%" y="56%" text-anchor="middle" font-family="Arial" font-size="24" font-weight="700" fill="${theme.primary}">${escapeHtml(clean(facts.companyName, 28))}</text></svg>`)}`;
  const logoUrl = escapeHtml(facts.logoUrl ?? fallbackLogo);
  const advantages = facts.advantages.length > 0
    ? facts.advantages
    : ["Единый визуальный образ", "Серийный выпуск материалов"];
  const statistic = (index: number) => facts.statistics[index];
  const generated = new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeZone: "Europe/Moscow" }).format(generatedAt);
  const relevance = context?.leadRelevance ?? "Компания выбрана для персонального предложения после анализа её публичного сайта.";

  const values: Record<string, string> = {
    COMPANY: escapeHtml(facts.companyName),
    WEBSITE: escapeHtml(facts.website),
    DESCRIPTION: escapeHtml(facts.description),
    ACCENT: theme.primary,
    PRIMARY_COLOR: theme.primary,
    SECONDARY_COLOR: theme.secondary,
    THEME_BACKGROUND: theme.background,
    THEME_BACKGROUND_END: theme.backgroundEnd,
    THEME_INK: theme.ink,
    THEME_MUTED: theme.muted,
    THEME_LINE: theme.line,
    THEME_SOFT: theme.soft,
    THEME_PAPER: theme.paper,
    THEME_PANEL: theme.panel,
    THEME_MODE: theme.mode,
    FONT_FAMILY: escapeHtml(preferences.fontFamily),
    FONT_FAMILY_JSON: JSON.stringify(`${preferences.fontFamily}, Arial, sans-serif`),
    LOGO_URL: logoUrl,
    HEADINGS: listHtml(facts.headings, "Основные направления на сайте не выделены"),
    SERVICES: listHtml(facts.services, "Перечень услуг на главной странице не найден"),
    SERVICE_CARDS: cardsHtml(facts.services, "Перечень услуг на страницах сайта не найден"),
    CONTACTS: listHtml(facts.contacts, "Публичные контакты на главной странице не найдены"),
    SOURCES: listHtml(facts.sources, facts.website),
    STATISTICS: statsHtml(facts.statistics),
    ADVANTAGES: advantagesHtml(facts.advantages),
    TESTIMONIAL: testimonialHtml(facts.testimonial),
    GENERATED_AT: generated,
    LEAD_RELEVANCE: escapeHtml(relevance),

    CONTENTS_TITLE: "Содержание",
    CONTENTS_1: "1. Общая характеристика · стр. 4",
    CONTENTS_1_1: "1.1. Общие сведения о предприятии · стр. 4 · 1.2. Общая характеристика информационного проекта · стр. 4 · 1.3. Структура команды для разработки и реализации проекта · стр. 6",
    CONTENTS_2: "2. Характеристика и описание информационных инструментов, использованных в течение практики",
    CONTENTS_3: "3. Характеристика и описание разделов и подразделов информационного проекта · стр. 8",
    CONTENTS_4: "4. Индивидуальное задание · стр. 10 · Заключение · стр. 11",
    INTRO_TITLE: "Введение",

    INDUSTRY: escapeHtml(industry),
    PRODUCT_HINT: escapeHtml(industry),
    ABOUT_HEADING: "1. Общая характеристика информационного проекта",
    ABOUT_LEAD: escapeHtml(facts.description),
    ABOUT_CARDS: cardsHtml(facts.headings, "Публичные направления компании требуют уточнения"),
    MARKET_HEADING: `Проверяемые открытые данные по теме «${escapeHtml(industry)}»`,
    MARKET_LEAD: (facts.industryFacts?.length ?? 0) > 0
      ? "В графиках использованы только числа, найденные в открытом источнике. Подписи и ссылка на источник сохранены ниже."
      : "Автоматический поиск не нашёл подходящих числовых данных. Нулевой график явно обозначает отсутствие данных, а не оценку рынка.",
    MARKET_NOTE_TITLE: "Важно.",
    MARKET_NOTE_TEXT: "Числа и бенчмарки следует добавить после согласования источников.",
    TOOLS_HEADING: `2. Характеристика и описание информационных инструментов, использованных для проекта ${escapeHtml(facts.companyName)}`,
    BLOGGER_LEAD: `Для анализа использованы публичные страницы ${escapeHtml(facts.website)}, HTML-метаданные, CSS-палитра, структурированные данные, связанные разделы сайта и открытые отраслевые источники. Сравнение форматов ниже является проектной гипотезой.`,
    LIVE_BLOGGER_CONS: comparisonItems(["Зависимость от графика исполнителя", "Сложнее поддерживать единый стиль", `Необходимы повторные согласования материалов для сферы «${industry}»`], "−"),
    AI_BLOGGER_PROS: comparisonItems(["Управляемый сценарий и визуальный стиль", "Возможность серийного тестирования", `Темы строятся по направлениям сайта ${facts.companyName}`], "+"),
    PROJECT_SECTIONS_HEADING: "3. Характеристика и описание разделов и подразделов информационного проекта",
    MATRIX_LEAD: `Структура сформирована из фактических разделов и направлений, найденных на сайте ${escapeHtml(facts.companyName)}.`,
    MATRIX_STEPS: matrixSteps(services),
    MATRIX_ASSUME_TITLE: "Гипотеза.",
    MATRIX_ASSUME_TEXT: "Очередность и форматы уточняются после интервью с командой.",
    BENCHMARK_LEAD: `Индивидуальная задача: исследовать ${escapeHtml(facts.website)}, выделить сведения о предприятии и его разделах, извлечь фирменную палитру и подготовить проверяемые данные для графиков по теме «${escapeHtml(industry)}».`,
    BENCHMARK_NAME: "4. Индивидуальное задание",
    BENCHMARK_TAG: "стр. 10",
    BENCHMARK_METRICS: "",
    BENCHMARK_NOTE_TITLE: "Нет данных.",
    BENCHMARK_NOTE_TEXT: "Блок намеренно не содержит вымышленных показателей.",
    OFFER_HEADING: "Заключение",
    OFFER_LEAD: `В результате проанализирован сайт ${escapeHtml(facts.companyName)}, определены его основные направления, контакты и визуальная палитра, сформирована структура информационного проекта и подготовлены графики на основе доступных проверяемых источников. ${escapeHtml(relevance)}`,
    OFFER_METRICS: offerMetrics(facts),
    OFFER_CTA: `<a class="cta" href="${escapeHtml(facts.website)}">Перейти на сайт компании</a>`,
    ADVANTAGE_1: escapeHtml(itemAt(advantages, 0, "Единый стиль")),
    ADVANTAGE_2: escapeHtml(itemAt(advantages, 1, "Серийный контент")),
    MARKET_CHART_DATA: charts[0]!.data,
    MARKET_CHART_TITLE: escapeHtml(charts[0]!.title),
    MARKET_CHART_SOURCE: escapeHtml(charts[0]!.sourceText),
    CHANNEL_CHART_DATA: charts[1]!.data,
    CHANNEL_CHART_TITLE: escapeHtml(charts[1]!.title),
    CHANNEL_CHART_SOURCE: escapeHtml(charts[1]!.sourceText),
    MARKET_SOURCE: escapeHtml(industrySourceText(facts)),
    ECONOMY_CHART_DATA: charts[2]!.data,
    ECONOMY_CHART_TITLE: escapeHtml(charts[2]!.title),
    ECONOMY_CHART_SOURCE: escapeHtml(charts[2]!.sourceText),
    VOLUME_CHART_DATA: charts[3]!.data,
    VOLUME_CHART_TITLE: escapeHtml(charts[3]!.title),
    VOLUME_CHART_SOURCE: escapeHtml(charts[3]!.sourceText),
    TRUST_CHART_DATA: charts[4]!.data,
    TRUST_CHART_TITLE: escapeHtml(charts[4]!.title),
    TRUST_CHART_SOURCE: escapeHtml(charts[4]!.sourceText),
    REACH_CHART_DATA: charts[5]!.data,
    REACH_CHART_TITLE: escapeHtml(charts[5]!.title),
    REACH_CHART_SOURCE: escapeHtml(charts[5]!.sourceText),
    ROADMAP_CHART_DATA: charts[6]!.data,
    ROADMAP_CHART_TITLE: escapeHtml(charts[6]!.title),
    ROADMAP_CHART_SOURCE: escapeHtml(charts[6]!.sourceText),
    CONTACT_1_HREF: escapeHtml(contactHref(facts.contacts[0], facts.website)),
    CONTACT_1_TEXT: escapeHtml(facts.contacts[0] ?? facts.website),
    CONTACT_2_HREF: escapeHtml(contactHref(facts.contacts[1], facts.website)),
    CONTACT_2_TEXT: escapeHtml(facts.contacts[1] ?? "Открыть сайт"),
    VIDEO_HEADING: `Примеры видеоформата для ${escapeHtml(facts.companyName)}`,
    VIDEO_LEAD: `Видеофайлы сохранены из исходного шаблона. Темы и подписи адаптированы под направление «${escapeHtml(industry)}» и данные сайта ${escapeHtml(facts.website)}.`,
    VIDEO_1_TAG: escapeHtml(itemAt(services, 0, industry)),
    VIDEO_1_TITLE: escapeHtml(itemAt(services, 0, `Знакомство с ${industry}`)),
    VIDEO_1_DESC: `Краткое объяснение направления и переход на сайт ${escapeHtml(facts.companyName)}.`,
    VIDEO_2_TAG: escapeHtml(itemAt(services, 1, industry)),
    VIDEO_2_TITLE: escapeHtml(itemAt(services, 1, `Выбор в сфере «${industry}»`)),
    VIDEO_2_DESC: "Практический сценарий, основанный на услугах и материалах компании.",
    VIDEO_3_TAG: escapeHtml(itemAt(services, 2, industry)),
    VIDEO_3_TITLE: escapeHtml(itemAt(services, 2, `Предложение ${facts.companyName}`)),
    VIDEO_3_DESC: "Сценарий с понятным следующим шагом и переходом к официальному сайту.",
    VIDEO_NOTE: `Каждый ролик связан с реальным направлением сайта ${escapeHtml(facts.companyName)} и не подменяет проверяемые сведения рекламными обещаниями.`,
  };

  const editablePageFields = [
    "DESCRIPTION", "ABOUT_LEAD", "MARKET_LEAD", "BLOGGER_LEAD",
    "VIDEO_LEAD", "MATRIX_LEAD", "BENCHMARK_LEAD", "OFFER_LEAD",
  ] as const;
  for (let page = 1; page <= 8; page += 1) {
    const edit = preferences.pageEdits[String(page)];
    values[`PAGE_${page}_EDIT`] = edit
      ? `<aside class="page-edit"><b>Основной текст страницы ${page} отредактирован пользователем</b></aside>`
      : "";
    if (edit) values[editablePageFields[page - 1]!] = escapeHtml(edit);
  }

  for (let index = 0; index < 4; index += 1) {
    const product = itemAt(services, index, `Направление ${index + 1} требует уточнения`);
    values[`PRODUCT_${index + 1}_TITLE`] = escapeHtml(product);
    values[`PRODUCT_${index + 1}_DESC`] = "Тема для проверки в контенте";
    values[`PRODUCT_${index + 1}_IMAGE`] = escapeHtml(preferences.productImages[String(index + 1)] ?? facts.productImages?.[index] ?? facts.logoUrl ?? fallbackLogo);
    const stat = statistic(index);
    values[`KPI_${index + 1}`] = stat
      ? kpiHtml(stat.value, stat.label)
      : kpiHtml(index === 0 ? String(facts.services.length) : "—", index === 0 ? "направлений найдено" : "нет подтверждённых данных");
  }

  for (let index = 0; index < 6; index += 1) {
    values[`ABOUT_${index + 1}_TITLE`] = escapeHtml(itemAt(facts.headings, index, itemAt(services, index, `Факт ${index + 1}`)));
    values[`ABOUT_${index + 1}_DESC`] = escapeHtml(itemAt(services, index, "Требует уточнения по публичным материалам компании"));
  }

  values.ABOUT_1_TITLE = "1.1. Общие сведения о предприятии";
  values.ABOUT_1_DESC = escapeHtml(`${facts.companyName}: ${facts.description}`);
  values.ABOUT_2_TITLE = "1.2. Общая характеристика информационного проекта";
  values.ABOUT_2_DESC = escapeHtml(`Проект основан на анализе сайта ${facts.website} и направления «${industry}»; данные сайта используются для содержимого и визуализации.`);
  values.ABOUT_3_TITLE = "1.3. Структура команды для разработки и реализации проекта";
  values.ABOUT_3_DESC = "Аналитик исследует сайт и источники, редактор проверяет содержание, дизайнер применяет фирменную палитру, разработчик формирует HTML и графики.";

  for (let index = 0; index < 4; index += 1) {
    const fact = facts.industryFacts?.[index];
    values[`BENCH_${index + 1}_VALUE`] = escapeHtml(fact?.displayValue ?? "—");
    values[`BENCH_${index + 1}_LABEL`] = escapeHtml(fact ? clean(fact.label, 120) : "проверяемый показатель не найден");
    values[`MATRIX_${index + 1}_TITLE`] = escapeHtml(itemAt(services, index, `Направление ${index + 1}`));
    values[`MATRIX_${index + 1}_DESC`] = "Сценарий и KPI согласуются после проверки приоритета направления";
  }

  const html = Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, value), template);
  const missing = [...new Set(html.match(/\{\{[A-Z0-9_]+\}\}/g) ?? [])];
  if (missing.length > 0) {
    throw new Error(`Шаблон презентации содержит незаполненные маркеры: ${missing.join(", ")}`);
  }
  return html;
}

async function renderHtml(
  facts: WebsiteFacts,
  targetDir: string,
  context?: PresentationContext,
  preferences?: PresentationPreferences,
): Promise<string> {
  const templatePath = path.join(await templateRoot(), "index.html");
  const template = await readFile(templatePath, "utf8");

  const html = renderPresentationTemplate(template, facts, context, new Date(), preferences);
  const htmlPath = path.join(targetDir, "index.html");
  await writeFile(htmlPath, html, "utf8");
  return htmlPath;
}

async function existingBrowsers(): Promise<string[]> {
  const candidates = [
    process.env.EDGE_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ].filter((value): value is string => Boolean(value));
  const available: string[] = [];
  for (const candidate of candidates) {
    try { await access(candidate); available.push(candidate); } catch { /* пробуем следующий браузер */ }
  }
  return [...new Set(available)];
}

async function renderWithBrowser(browser: string, htmlPath: string, pdfPath: string): Promise<boolean> {
  const profilePath = path.join(tmpdir(), `botpresent-pdf-profile-${randomUUID().slice(0, 8)}`);
  return await new Promise((resolve) => {
    let settled = false;
    let diagnostics = "";
    const finish = async (result: boolean, cleanup = true): Promise<void> => {
      if (settled) return;
      settled = true;
      if (cleanup) await rm(profilePath, { recursive: true, force: true }).catch(() => undefined);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(browser, [
        "--headless", "--disable-gpu", "--disable-background-networking", "--no-first-run", "--disable-extensions",
        "--run-all-compositor-stages-before-draw", "--virtual-time-budget=5000", "--no-pdf-header-footer",
        "--allow-file-access-from-files",
        `--user-data-dir=${profilePath}`,
        `--print-to-pdf=${pdfPath}`, new URL(`file:///${htmlPath.replace(/\\/g, "/")}`).toString(),
      ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (error) {
      console.warn(`PDF browser ${path.basename(browser)} could not start.`, error);
      void finish(false);
      return;
    }
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { diagnostics = `${diagnostics}${chunk}`.slice(-4_000); });
    const terminate = async (): Promise<void> => {
      if (process.platform === "win32" && child.pid) {
        try {
          const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          await new Promise<void>((done) => {
            const fallback = setTimeout(done, 5_000);
            killer.once("error", () => { clearTimeout(fallback); done(); });
            killer.once("exit", () => { clearTimeout(fallback); done(); });
          });
        } catch { child.kill(); }
      } else {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      console.warn(`PDF browser ${path.basename(browser)} exceeded the 45 second timeout.`);
      void terminate().finally(() => {
        child.stderr?.destroy();
        child.unref();
        void finish(false, false);
      });
    }, 45_000);
    child.once("error", () => { clearTimeout(timer); void finish(false); });
    child.once("exit", async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.warn(`PDF browser ${path.basename(browser)} exited with code ${code}.${diagnostics ? ` ${diagnostics.trim()}` : ""}`);
        return void finish(false);
      }
      try {
        const info = await stat(pdfPath);
        await finish(info.isFile() && info.size > 1_000);
      } catch { await finish(false); }
    });
  });
}

export async function renderPresentationPdf(htmlPath: string, pdfPath: string): Promise<boolean> {
  const browsers = await existingBrowsers();
  if (browsers.length === 0) {
    console.warn("Не найден headless браузер, PDF не будет создан");
    return false;
  }
  for (const browser of browsers) {
    if (await renderWithBrowser(browser, htmlPath, pdfPath)) return true;
  }
  console.error("Не удалось создать PDF ни одним браузером");
  return false;
}

function userRoot(userId: number): string {
  return path.join(PRESENTATIONS_ROOT, String(userId));
}

export async function listPresentations(userId: number): Promise<PresentationRecord[]> {
  const root = userRoot(userId);
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const records = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    try { return JSON.parse(await readFile(path.join(root, entry.name, "presentation.json"), "utf8")) as PresentationRecord; }
    catch { return undefined; }
  }));
  return records.filter((record): record is PresentationRecord => Boolean(record)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createWebsitePresentation(
  userId: number,
  website: string,
  recordId?: string,
  progress?: PresentationProgress,
  context?: PresentationContext,
  editOptions?: PresentationEditOptions,
): Promise<PresentationRecord> {
  const existing = recordId ? (await listPresentations(userId)).find((record) => record.id === recordId) : undefined;
  await progress?.(0, "Начинаю создание презентации");
  const requestedWebsite = normalizeWebsite(website || existing?.website || "");
  const preferences = applyEditOptions(defaultPreferences(existing?.preferences), editOptions);
  let facts: WebsiteFacts | undefined;
  if (existing && normalizeWebsite(existing.website) === requestedWebsite) {
    try {
      facts = JSON.parse(await readFile(path.join(userRoot(userId), existing.id, "facts.json"), "utf8")) as WebsiteFacts;
      await progress?.(45, "Использую сохранённые данные сайта");
    } catch { /* старую презентацию пересоберём с сайта */ }
  }
  facts ??= await collectWebsiteFacts(requestedWebsite, progress);
  const id = existing?.id ?? `${safeFilePart(new URL(facts.website).hostname)}-${randomUUID().slice(0, 8)}`;
  const targetDir = path.join(userRoot(userId), id);
  await mkdir(targetDir, { recursive: true });
  // Копируем шаблонные ассеты (css, js, шрифты), но index.html перезапишем
  await cp(await templateRoot(), targetDir, { recursive: true, force: true }).catch(() => undefined);
  await progress?.(60, "Заполняю шаблон");
  const htmlPath = await renderHtml(facts, targetDir, context, preferences);
  await progress?.(72, "HTML-версия готова");
  const pdfPath = path.join(targetDir, `${safeFilePart(facts.companyName)}.pdf`);
  await progress?.(78, "Создаю PDF-версию");
  const pdfCreated = await renderPresentationPdf(htmlPath, pdfPath);
  await progress?.(94, pdfCreated ? "PDF-версия готова" : "PDF недоступен (сохранён только HTML)");
  const now = new Date().toISOString();
  const record: PresentationRecord = {
    id, userId, companyName: facts.companyName, website: facts.website,
    createdAt: existing?.createdAt ?? now, updatedAt: now, htmlPath,
    ...(pdfCreated ? { pdfPath } : {}),
    sources: facts.sources,
    researchStatus: (facts.industryFacts?.length ?? 0) > 0 ? "verified" : "not-found",
    preferences,
  };
  await writeFile(path.join(targetDir, "facts.json"), JSON.stringify(facts, null, 2), "utf8");
  await writeFile(path.join(targetDir, "presentation.json"), JSON.stringify(record, null, 2), "utf8");
  await progress?.(100, "Презентация готова");
  return record;
}

// Совместимость со старым API
export async function createPresentation(website: string): Promise<PresentationFile> {
  const record = await createWebsitePresentation(0, website);
  return { path: record.htmlPath, name: "index.html" };
}
