import { readFile, stat } from "node:fs/promises";
import {
  createWebsitePresentation,
  type PresentationProgress,
} from "../src/services/presentation";

const website = process.argv[2] ?? "https://example.com/";
const progressLog: Array<{ percent: number; stage: string }> = [];
const progress: PresentationProgress = (percent, stage) => {
  progressLog.push({ percent, stage });
};
const record = await createWebsitePresentation(
  999_006,
  website,
  undefined,
  progress,
  { leadRelevance: "Сквозная тестовая генерация по публичной ссылке." },
  { themeId: "3" },
);
const html = await readFile(record.htmlPath, "utf8");
if (/\{\{[A-Z0-9_]+\}\}/.test(html)) throw new Error("В HTML остались незаполненные маркеры.");
if (!html.includes(record.website)) throw new Error("В HTML не подставлена итоговая ссылка сайта.");
if (!html.includes("--green:#6d4cc3") && !html.includes("--primary:#6d4cc3")) throw new Error("В HTML не подставлена выбранная палитра.");
if ((html.match(/class="ai-blogger-gif"/g)?.length ?? 0) !== 3) throw new Error("В HTML нет трёх тематических GIF AI-блогеров.");
if (!html.includes('data-botpresent-runtime="chart.js@4.5.1"')) throw new Error("Chart.js не встроен в автономный HTML.");
if (!record.pdfPath) throw new Error("Сквозная проверка не создала PDF.");
const [htmlInfo, pdfInfo] = await Promise.all([stat(record.htmlPath), stat(record.pdfPath)]);
const pdfText = (await readFile(record.pdfPath)).toString("latin1");
const pdfPages = pdfText.match(/\/Type\s*\/Page(?!s)/g)?.length ?? 0;
if (pdfPages !== 1) throw new Error(`PDF содержит ${pdfPages} страниц; ожидается один непрерывный лист.`);
const pdfImages = pdfText.match(/\/Subtype\s*\/Image/g)?.length ?? 0;
if (pdfImages < 3) throw new Error(`PDF содержит только ${pdfImages} изображений вместо трёх кадров GIF AI-блогеров.`);

console.log(JSON.stringify({
  website: record.website,
  companyName: record.companyName,
  htmlPath: record.htmlPath,
  htmlBytes: htmlInfo.size,
  pdfPath: record.pdfPath,
  pdfBytes: pdfInfo.size,
  pdfPages,
  pdfImages,
  sources: record.sources,
  researchStatus: record.researchStatus,
  preferences: record.preferences,
  progress: progressLog,
}, null, 2));
