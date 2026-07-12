import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  renderPresentationPdf,
  renderPresentationTemplate,
  type WebsiteFacts,
} from "../src/services/presentation";

function count(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

const templatePath = path.resolve(import.meta.dir, "..", "Generic", "index.html");
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
    { label: "Доля внедрений составила 42 %", value: 42, displayValue: "42 %", sourceUrl: "https://research.example/report", sourceTitle: "Research report" },
    { label: "Объём рынка достиг 18 млн", value: 18, displayValue: "18 млн", sourceUrl: "https://research.example/report", sourceTitle: "Research report" },
  ],
};
const html = renderPresentationTemplate(template, facts, undefined, new Date("2026-07-12T00:00:00Z"), {
  themeId: "3",
});

const checks: Array<[boolean, string]> = [
  [!html.match(/\{\{[A-Z0-9_]+\}\}/), "остались незаполненные маркеры"],
  [count(html, /<section\b/g) === count(template, /<section\b/g), "изменилась структура секций"],
  [count(html, /<video\b/g) === count(template, /<video\b/g), "изменилась структура видео"],
  [html.includes("https://fixture.example/assets/logo.svg"), "не подставлена ссылка на логотип"],
  [html.includes("--green:#6d4cc3"), "не применена выбранная палитра"],
  [html.includes('"backgroundColor":["#6d4cc3","#ebe4ff"]'), "палитра не применена к графику"],
];
for (const [passed, message] of checks) {
  if (!passed) throw new Error(`Проверка HTML не пройдена: ${message}.`);
}

await writeFile(htmlPath, html, "utf8");
if (!await renderPresentationPdf(htmlPath, pdfPath)) {
  throw new Error("PDF не создан. Установите Microsoft Edge/Chrome или задайте EDGE_PATH.");
}
const [htmlInfo, pdfInfo] = await Promise.all([stat(htmlPath), stat(pdfPath)]);
const pdfText = (await readFile(pdfPath)).toString("latin1");
const pdfPages = count(pdfText, /\/Type\s*\/Page(?!s)/g);
if (pdfPages !== count(template, /<section\b/g)) {
  throw new Error(`PDF содержит ${pdfPages} страниц вместо ${count(template, /<section\b/g)}.`);
}
console.log(JSON.stringify({
  templatePath,
  outputDir,
  htmlPath,
  htmlBytes: htmlInfo.size,
  pdfPath,
  pdfBytes: pdfInfo.size,
  pdfPages,
  sections: count(html, /<section\b/g),
  videos: count(html, /<video\b/g),
  unresolvedMarkers: count(html, /\{\{[A-Z0-9_]+\}\}/g),
  palette: "3",
  logoUrl: facts.logoUrl,
}, null, 2));
