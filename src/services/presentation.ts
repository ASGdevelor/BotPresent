import { createHash, randomUUID } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
}

const APP_ROOT = path.resolve(import.meta.dir, "..", "..");
const PRESENTATIONS_ROOT = path.join(APP_ROOT, "data", "presentations");
const TEMPLATE_ROOT = path.join(APP_ROOT, "TestSite", "Generic");

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

async function collectWebsiteFacts(input: string): Promise<WebsiteFacts> {
  const website = normalizeWebsite(input);
  const home = await fetchPublicHtml(website);
  const $ = load(home.html);
  $("script, style, noscript, svg").remove();
  const companyName = clean(
    $("meta[property='og:site_name']").attr("content")
      ?? $("meta[name='application-name']").attr("content")
      ?? $("h1").first().text()
      ?? $("title").text().split(/[|—–-]/)[0],
    120,
  ) || new URL(home.finalUrl).hostname.replace(/^www\./, "");
  const description = clean(
    $("meta[name='description']").attr("content")
      ?? $("meta[property='og:description']").attr("content")
      ?? $("main").first().text()
      ?? $("body").text(),
    900,
  );
  const headings = $("h1,h2,h3").map((_, node) => $(node).text()).get();
  const services = $("main li, section li, [class*='service'], [class*='product']").map((_, node) => $(node).text()).get();
  const contacts = [
    ...$("a[href^='mailto:']").map((_, node) => ($(node).attr("href") ?? "").replace(/^mailto:/, "").split("?")[0] ?? "").get(),
    ...$("a[href^='tel:']").map((_, node) => clean($(node).text()) || ($(node).attr("href") ?? "").replace(/^tel:/, "")).get(),
    ...$("a[href*='t.me/']").map((_, node) => $(node).attr("href") ?? "").get(),
  ];
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
  for (const result of relatedPages) {
    if (result.status !== "fulfilled") continue;
    const related = load(result.value.html);
    headings.push(...related("h1,h2,h3").map((_, node) => related(node).text()).get());
    services.push(...related("main li, section li, [class*='service'], [class*='product']").map((_, node) => related(node).text()).get());
    contacts.push(
      ...related("a[href^='mailto:']").map((_, node) => (related(node).attr("href") ?? "").replace(/^mailto:/, "").split("?")[0] ?? "").get(),
      ...related("a[href^='tel:']").map((_, node) => clean(related(node).text()) || (related(node).attr("href") ?? "").replace(/^tel:/, "")).get(),
      ...related("a[href*='t.me/']").map((_, node) => related(node).attr("href") ?? "").get(),
    );
    sources.push(result.value.finalUrl);
  }

  return {
    companyName,
    website: home.finalUrl,
    description: description || "Описание на официальном сайте не найдено.",
    headings: dedupe(headings, 12),
    services: dedupe(services, 10),
    contacts: dedupe(contacts, 12),
    sources: dedupe(sources, 5),
  };
}

function accentForWebsite(website: string): string {
  const digest = createHash("sha256").update(new URL(website).hostname).digest();
  const hue = ((digest[0]! << 8) | digest[1]!) % 360;
  return `hsl(${hue} 68% 42%)`;
}

function listHtml(items: string[], fallback: string): string {
  const values = items.length > 0 ? items : [fallback];
  return values.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n");
}

async function renderHtml(facts: WebsiteFacts, targetDir: string): Promise<string> {
  const templatePath = path.join(TEMPLATE_ROOT, "index.html");
  const template = await readFile(templatePath, "utf8");
  const values: Record<string, string> = {
    COMPANY: escapeHtml(facts.companyName),
    WEBSITE: escapeHtml(facts.website),
    DESCRIPTION: escapeHtml(facts.description),
    ACCENT: accentForWebsite(facts.website),
    HEADINGS: listHtml(facts.headings, "Основные направления на сайте не выделены"),
    SERVICES: listHtml(facts.services, "Перечень услуг на главной странице не найден"),
    CONTACTS: listHtml(facts.contacts, "Публичные контакты на главной странице не найдены"),
    SOURCES: listHtml(facts.sources, facts.website),
    GENERATED_AT: new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeZone: "Europe/Moscow" }).format(new Date()),
  };
  const html = Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, value), template);
  const htmlPath = path.join(targetDir, "index.html");
  await writeFile(htmlPath, html, "utf8");
  return htmlPath;
}

async function existingBrowser(): Promise<string | undefined> {
  const candidates = [
    process.env.EDGE_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* пробуем следующий браузер */ }
  }
  return undefined;
}

async function renderPdf(htmlPath: string, pdfPath: string): Promise<boolean> {
  const browser = await existingBrowser();
  if (!browser) return false;
  return await new Promise((resolve) => {
    const child = spawn(browser, [
      "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
      `--print-to-pdf=${pdfPath}`, new URL(`file:///${htmlPath.replace(/\\/g, "/")}`).toString(),
    ], { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 45_000);
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("exit", async (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(false);
      try { await access(pdfPath); resolve(true); } catch { resolve(false); }
    });
  });
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

export async function createWebsitePresentation(userId: number, website: string, recordId?: string): Promise<PresentationRecord> {
  const existing = recordId ? (await listPresentations(userId)).find((record) => record.id === recordId) : undefined;
  const facts = await collectWebsiteFacts(website || existing?.website || "");
  const id = existing?.id ?? `${safeFilePart(new URL(facts.website).hostname)}-${randomUUID().slice(0, 8)}`;
  const targetDir = path.join(userRoot(userId), id);
  await mkdir(targetDir, { recursive: true });
  await cp(TEMPLATE_ROOT, targetDir, { recursive: true, force: false }).catch(() => undefined);
  const htmlPath = await renderHtml(facts, targetDir);
  const pdfPath = path.join(targetDir, `${safeFilePart(facts.companyName)}.pdf`);
  const pdfCreated = await renderPdf(htmlPath, pdfPath);
  const now = new Date().toISOString();
  const record: PresentationRecord = {
    id, userId, companyName: facts.companyName, website: facts.website,
    createdAt: existing?.createdAt ?? now, updatedAt: now, htmlPath,
    ...(pdfCreated ? { pdfPath } : {}),
  };
  await writeFile(path.join(targetDir, "presentation.json"), JSON.stringify(record, null, 2), "utf8");
  return record;
}

// Совместимость со старым API: теперь аргументом должен быть сайт.
export async function createPresentation(website: string): Promise<PresentationFile> {
  const record = await createWebsitePresentation(0, website);
  return { path: record.htmlPath, name: "index.html" };
}
