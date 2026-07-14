import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  inlinePresentationImages,
  inlinePresentationRuntime,
  renderPresentationPdf,
  renderPresentationTemplate,
  type WebsiteFacts,
} from "../src/services/presentation";

function count(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

const requestedTemplate = path.basename(process.argv[2] ?? "index.html");
const genericRoot = path.resolve(import.meta.dir, "..", "Generic");
const templatePath = path.join(genericRoot, requestedTemplate);
const outputDir = await mkdtemp(path.join(tmpdir(), "botpresent-verification-"));
const htmlPath = path.join(outputDir, "index.html");
const pdfPath = path.join(outputDir, "fixture-company.pdf");
const template = await readFile(templatePath, "utf8");
const facts: WebsiteFacts = {
  companyName: "Fixture Company",
  website: "https://fixture.example/",
  description: "Тестовая компания для проверки полного цикла HTML и PDF.",
  headings: ["О компании", "Решения", "Контакты"],
  services: ["Аналитика", "Автоматизация", "Интеграция", "Поддержка"],
  contacts: ["hello@fixture.example", "+7 999 000-00-00"],
  sources: ["https://fixture.example/", "https://research.example/report"],
  logoUrl: "https://fixture.example/assets/logo.svg",
  primaryColor: "#114477",
  secondaryColor: "#d9e8f5",
  statistics: [{ label: "проектов", value: "120" }],
  advantages: ["Проверяемые данные", "Единый шаблон"],
  industry: "автоматизация бизнеса",
  industryFacts: [
    { label: "Доля внедрений", value: 42, displayValue: "42 %", unit: "%", year: 2024, sourceUrl: "https://research.example/report", sourceTitle: "Research report" },
    { label: "Доля повторных заказов", value: 51, displayValue: "51 %", unit: "%", year: 2025, sourceUrl: "https://research.example/report", sourceTitle: "Research report" },
    { label: "Объём рынка", value: 18, displayValue: "18 млрд ₽", unit: "млрд ₽", year: 2024, sourceUrl: "https://research.example/report-2", sourceTitle: "Research report 2" },
    { label: "Объём онлайн-сегмента", value: 22, displayValue: "22 млрд ₽", unit: "млрд ₽", year: 2025, sourceUrl: "https://research.example/report-2", sourceTitle: "Research report 2" },
  ],
};
const html = renderPresentationTemplate(template, facts, undefined, new Date("2026-07-12T00:00:00Z"), {
  themeId: "3",
});

const checks: Array<[boolean, string]> = [
  [!html.match(/\{\{[A-Z0-9_]+\}\}/), "остались незаполненные маркеры"],
  [count(html, /<section\b/g) === count(template, /<section\b/g), "изменилась структура секций"],
  [count(html, /class="ai-blogger-gif"/g) === 3, "режим AI-блогеров должен содержать три тематических GIF"],
  [count(html, /data:image\/gif;base64,/g) === 3, "GIF AI-блогеров должны быть автономными"],
  [count(html, /<video\b/g) === 0, "старые удалённые видео не должны попадать в презентацию"],
  [html.includes("https://fixture.example/assets/logo.svg"), "не подставлена ссылка на логотип"],
  [html.includes("--green:#6d4cc3") || html.includes("--primary:#6d4cc3"), "не применена выбранная палитра"],
  [count(html, /<svg class="business-chart"/g) === 7, "должно быть семь векторных диаграмм"],
  [count(html, /<canvas\b/g) === 7, "должно быть семь интерактивных Chart.js-диаграмм"],
  [html.includes("<!-- BOT_PRESENT_CHART_JS -->"), "отсутствует маркер локального Chart.js"],
  [html.includes('fill="#6d4cc3"'), "палитра не применена к SVG-графику"],
  [html.includes("<circle"), "не создана круговая SVG-диаграмма"],
];
if (requestedTemplate === "index3.html") {
  checks.push(
    [html.includes("Шаг 1 · что я изучил"), "в AI-шаблоне отсутствует шаг персонального разбора"],
    [html.includes("Шаг 6 · так это уже работает"), "в AI-шаблоне отсутствует блок рыночного доказательства"],
    [html.includes("AI-блогеры для аудитории СНГ"), "в AI-шаблоне отсутствует блок для рынка СНГ"],
  );
}
for (const [passed, message] of checks) {
  if (!passed) throw new Error(`Проверка HTML не пройдена: ${message}.`);
}

const standaloneHtml = await inlinePresentationImages(await inlinePresentationRuntime(html), genericRoot);
if (standaloneHtml.includes("assets/ai-blogger-roster.png")) {
  throw new Error("Удалённый локальный roster AI-блогеров попал в автономный HTML.");
}
if (!standaloneHtml.includes('data-botpresent-runtime="chart.js@4.5.1"') || standaloneHtml.includes("<!-- BOT_PRESENT_CHART_JS -->")) {
  throw new Error("Chart.js не встроен в автономный HTML.");
}
await writeFile(htmlPath, standaloneHtml, "utf8");
if (!await renderPresentationPdf(htmlPath, pdfPath)) {
  throw new Error("PDF не создан. Установите Microsoft Edge/Chrome или задайте EDGE_PATH.");
}
const [htmlInfo, pdfInfo] = await Promise.all([stat(htmlPath), stat(pdfPath)]);
const pdfText = (await readFile(pdfPath)).toString("latin1");
const pdfPages = count(pdfText, /\/Type\s*\/Page(?!s)/g);
if (pdfPages !== 1) throw new Error(`PDF содержит ${pdfPages} страниц; ожидается один непрерывный лист.`);
const pdfImages = count(pdfText, /\/Subtype\s*\/Image/g);
if (pdfImages < 3) throw new Error(`PDF содержит только ${pdfImages} изображений; ожидаются три GIF AI-блогеров.`);
const mediaBox = pdfText.match(/\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/);
if (!mediaBox || Number(mediaBox[2]) <= Number(mediaBox[1])) {
  throw new Error("PDF не получил формат одного вертикального листа высотой с HTML-презентацию.");
}
console.log(JSON.stringify({
  templatePath,
  outputDir,
  htmlPath,
  htmlBytes: htmlInfo.size,
  pdfPath,
  pdfBytes: pdfInfo.size,
  pdfPages,
  pdfImages,
  mediaBox: mediaBox.slice(1).map(Number),
  sections: count(html, /<section\b/g),
  gifs: count(html, /class="ai-blogger-gif"/g),
  vectorCharts: count(html, /<svg class="business-chart"/g),
  unresolvedMarkers: count(html, /\{\{[A-Z0-9_]+\}\}/g),
  palette: "3",
  logoUrl: facts.logoUrl,
}, null, 2));
