import { createHash, randomUUID } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { load } from "cheerio";
import { fetchPublicHtml, parsePublicHttpUrl } from "./public-web";
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
}

interface WebsiteFacts {
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
  statistics: { label: string; value: string }[];
  advantages: string[];
  testimonial?: string;      // одна цитата-отзыв
}

export interface PresentationContext {
  leadRelevance?: string;
}

export type PresentationProgress = (percent: number, stage: string) => void | Promise<void>;

// Путь к шаблону теперь можно переопределить через переменную окружения
const APP_ROOT = path.resolve(import.meta.dir, "..", "..");
const PRESENTATIONS_ROOT = path.join(APP_ROOT, "data", "presentations");
const BUNDLED_TEMPLATE_ROOT = path.join(APP_ROOT, "TestSite", "Generic");
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
  // 3. Рабочее окружение (рядом), если репозиторный шаблон отсутствует.
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

function dedupe(values: string[], limit: number): string[] {
  return [...new Set(values.map((value) => clean(value)).filter((value) => value.length >= 3))].slice(0, limit);
}

async function collectWebsiteFacts(input: string, progress?: PresentationProgress): Promise<WebsiteFacts> {
  await progress?.(5, "Проверяю ссылку");
  const website = normalizeWebsite(input);
  const home = await fetchPublicHtml(website);
  await progress?.(20, "Главная страница загружена");
  const $ = load(home.html);
  $("script, style, noscript, svg").remove();

  // Название компании
  const companyName = clean(
    $("meta[property='og:site_name']").attr("content")
      ?? $("meta[name='application-name']").attr("content")
      ?? $("h1").first().text()
      ?? $("title").text().split(/[|—–-]/)[0],
    120,
  ) || new URL(home.finalUrl).hostname.replace(/^www\./, "");

  // Описание
  const description = clean(
    $("meta[name='description']").attr("content")
      ?? $("meta[property='og:description']").attr("content")
      ?? $("main").first().text()
      ?? $("body").text(),
    900,
  );

  // Цвета: theme-color и дополнительно ищем в CSS-переменных (упрощённо)
  const themeColor = clean($("meta[name='theme-color']").attr("content") ?? "", 30);
  let primaryColor = themeColor;
  if (!primaryColor) {
    // Ищем в inline style body или :root
    const bodyStyle = $("body").attr("style") ?? "";
    const match = bodyStyle.match(/--primary(?:-color)?:\s*([#\w()]+)/) ||
                  bodyStyle.match(/background(?:-color)?:\s*([#\w()]+)/);
    primaryColor = match?.[1] ?? "";
  }
  // Вторичный цвет – или более светлый оттенок, или просто нейтральный
  const secondaryColor = primaryColor ? adjustColor(primaryColor, 0.2) : "#f0f0f0";

  // Логотип
  const logoUrl = $("meta[property='og:image']").attr("content")
    ?? $("link[rel='icon']").attr("href")
    ?? $("link[rel='shortcut icon']").attr("href");
  const absoluteLogo = logoUrl ? new URL(logoUrl, home.finalUrl).toString() : undefined;

  // Заголовки (уже было)
  const headings = $("h1,h2,h3").map((_, node) => $(node).text()).get();

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
    const hint = `${href ?? ""} ${$(node).text()}`;
    if (!href || !/about|company|contact|team|management|о нас|о компании|контакт|команда|руковод/i.test(hint)) return "";
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
    sources.push(result.value.finalUrl);
    await progress?.(25 + Math.round(((index + 1) / Math.max(1, relatedPages.length)) * 25), "Анализирую услуги, контакты и разделы сайта");
  }

  // --- Новые блоки: статистика, преимущества, отзыв ---
  const numbersPattern = /(\d{1,3}(?:[\s.,]\d{3})*(?:[,.]\d+)?)\s*(?:лет|года?|проектов|клиентов|сотрудников|партнёров|офисов|стран|городов|филиалов|заказов|отзывов|рейтинг|баллов?)/gi;
  const statMatches = $("body").text().matchAll(numbersPattern);
  const statistics = [];
  for (const m of statMatches) {
    statistics.push({ label: m[0].replace(/\d[\d\s.,]*/, "").trim(), value: m[0].replace(/[^\d]/g, "") });
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

  await progress?.(52, "Факты и источники собраны");

  return {
    companyName,
    website: home.finalUrl,
    description: description || "Описание на официальном сайте не найдено.",
    headings: dedupe(headings, 12),
    services: dedupe(services, 10),
    contacts: dedupe(contacts, 12),
    sources: dedupe(sources, 5),
    accent: primaryColor,
    logoUrl: absoluteLogo,
    primaryColor,
    secondaryColor,
    statistics: statistics.slice(0, 6),
    advantages: dedupe(advantages, 8),
    testimonial: testimonial ? clean(testimonial, 300) : undefined,
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
  const hue = createHash("sha256").update(new URL(facts.website).hostname).digest().readUInt16BE(0) % 360;
  return `hsl(${hue} 68% 42%)`;
}

function listHtml(items: string[], fallback: string): string {
  const values = items.length > 0 ? items : [fallback];
  return values.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n");
}

function cardsHtml(items: string[], fallback: string): string {
  const values = items.length > 0 ? items : [fallback];
  return values.slice(0, 9).map((item, index) => `<div class="card"><div class="metric">${String(index + 1).padStart(2, "0")}</div><p>${escapeHtml(item)}</p></div>`).join("\n");
}

async function renderHtml(facts: WebsiteFacts, targetDir: string, context?: PresentationContext): Promise<string> {
  const templatePath = path.join(await templateRoot(), "index.html");
  const template = await readFile(templatePath, "utf8");

  const values: Record<string, string> = {
    COMPANY: escapeHtml(facts.companyName),
    WEBSITE: escapeHtml(facts.website),
    DESCRIPTION: escapeHtml(facts.description),
    ACCENT: accentForWebsite(facts),
    PRIMARY_COLOR: facts.primaryColor || "#2a5c8e",
    SECONDARY_COLOR: facts.secondaryColor || "#f0f0f0",
    LOGO_URL: facts.logoUrl ? escapeHtml(facts.logoUrl) : "",
    HEADINGS: listHtml(facts.headings, "Основные направления на сайте не выделены"),
    SERVICES: listHtml(facts.services, "Перечень услуг на главной странице не найден"),
    SERVICE_CARDS: cardsHtml(facts.services, "Перечень услуг на страницах сайта не найден"),
    CONTACTS: listHtml(facts.contacts, "Публичные контакты на главной странице не найдены"),
    SOURCES: listHtml(facts.sources, facts.website),
    STATISTICS: statsHtml(facts.statistics),
    ADVANTAGES: advantagesHtml(facts.advantages),
    TESTIMONIAL: testimonialHtml(facts.testimonial),
    GENERATED_AT: new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeZone: "Europe/Moscow" }).format(new Date()),
    LEAD_RELEVANCE: escapeHtml(context?.leadRelevance ?? "Компания выбрана для персонального предложения после анализа её публичного сайта."),
  };

  const html = Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, value), template);
  if (/\{\{[A-Z0-9_]+\}\}/.test(html)) {
    throw new Error("Шаблон презентации содержит незаполненные маркеры");
  }
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
  const profilePath = path.join(path.dirname(pdfPath), ".pdf-browser-profile");
  return await new Promise((resolve) => {
    const child = spawn(browser, [
      "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
      `--user-data-dir=${profilePath}`,
      `--print-to-pdf=${pdfPath}`, new URL(`file:///${htmlPath.replace(/\\/g, "/")}`).toString(),
    ], { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 45_000);
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("exit", async (code) => {
      clearTimeout(timer);
      await rm(profilePath, { recursive: true, force: true }).catch(() => undefined);
      if (code !== 0) return resolve(false);
      try { await access(pdfPath); resolve(true); } catch { resolve(false); }
    });
  });
}

async function renderPdf(htmlPath: string, pdfPath: string): Promise<boolean> {
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
): Promise<PresentationRecord> {
  const existing = recordId ? (await listPresentations(userId)).find((record) => record.id === recordId) : undefined;
  await progress?.(0, "Начинаю создание презентации");
  const facts = await collectWebsiteFacts(website || existing?.website || "", progress);
  const id = existing?.id ?? `${safeFilePart(new URL(facts.website).hostname)}-${randomUUID().slice(0, 8)}`;
  const targetDir = path.join(userRoot(userId), id);
  await mkdir(targetDir, { recursive: true });
  // Копируем шаблонные ассеты (css, js, шрифты), но index.html перезапишем
  await cp(await templateRoot(), targetDir, { recursive: true, force: false }).catch(() => undefined);
  await progress?.(60, "Заполняю шаблон");
  const htmlPath = await renderHtml(facts, targetDir, context);
  await progress?.(72, "HTML-версия готова");
  const pdfPath = path.join(targetDir, `${safeFilePart(facts.companyName)}.pdf`);
  await progress?.(78, "Создаю PDF-версию");
  const pdfCreated = await renderPdf(htmlPath, pdfPath);
  await progress?.(94, pdfCreated ? "PDF-версия готова" : "PDF недоступен (сохранён только HTML)");
  const now = new Date().toISOString();
  const record: PresentationRecord = {
    id, userId, companyName: facts.companyName, website: facts.website,
    createdAt: existing?.createdAt ?? now, updatedAt: now, htmlPath,
    ...(pdfCreated ? { pdfPath } : {}),
  };
  await writeFile(path.join(targetDir, "presentation.json"), JSON.stringify(record, null, 2), "utf8");
  await progress?.(100, "Презентация готова");
  return record;
}

// Совместимость со старым API
export async function createPresentation(website: string): Promise<PresentationFile> {
  const record = await createWebsitePresentation(0, website);
  return { path: record.htmlPath, name: "index.html" };
}
