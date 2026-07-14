import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import {
  inlinePresentationRuntime,
  renderPresentationTemplate,
  type WebsiteFacts,
} from "../src/services/presentation";

const genericRoot = path.resolve(import.meta.dir, "..", "Generic");

const qualityFacts: WebsiteFacts = {
  companyName: "Quality Brand",
  website: "https://quality.example/",
  description: "Проверенное описание компании для персонального маркетингового исследования.",
  headings: ["О компании", "Продукты", "Преимущества", "Клиентам"],
  services: ["Аналитика", "Автоматизация", "Поддержка", "Интеграция"],
  contacts: ["customer@quality.example", "+7 000 000-00-00"],
  sources: ["https://quality.example/", "https://rosstat.gov.ru/quality-report"],
  logoUrl: "https://quality.example/assets/logo.svg",
  primaryColor: "#114477",
  secondaryColor: "#d9e8f5",
  statistics: [{ label: "проектов", value: "120" }],
  advantages: ["Проверенные данные", "Единый стиль"],
  industry: "фармацевтический рынок",
  industryFacts: [
    { label: "Доля онлайн-продаж", value: 42, displayValue: "42 %", unit: "%", year: 2024, qualityScore: 70, sourceUrl: "https://rosstat.gov.ru/a", sourceTitle: "Росстат" },
    { label: "Доля повторных покупок", value: 51, displayValue: "51 %", unit: "%", year: 2025, qualityScore: 72, sourceUrl: "https://rosstat.gov.ru/b", sourceTitle: "Росстат" },
    { label: "Объём рынка", value: 18, displayValue: "18 млрд ₽", unit: "млрд ₽", year: 2024, qualityScore: 65, sourceUrl: "https://dsm.ru/a", sourceTitle: "DSM Group" },
    { label: "Объём онлайн-сегмента", value: 22, displayValue: "22 млрд ₽", unit: "млрд ₽", year: 2025, qualityScore: 68, sourceUrl: "https://dsm.ru/b", sourceTitle: "DSM Group" },
  ],
};

async function renderQualityTemplate(): Promise<string> {
  const template = await readFile(path.join(genericRoot, "index.html"), "utf8");
  return renderPresentationTemplate(template, qualityFacts, undefined, new Date("2026-07-12T00:00:00Z"), {
    themeId: "4",
    fontFamily: "Montserrat",
  });
}

describe("Generic template visual and data quality", () => {
  test("renders eight ordered sections in a continuous single-page layout", async () => {
    const html = await renderQualityTemplate();
    const $ = load(html);
    const pages = $("section[data-page]").map((_, node) => Number($(node).attr("data-page"))).get();

    expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(html).toContain("dataset.pdfLayout='single-page-screen'");
    expect(html).not.toContain("@page{size:A4 landscape");
    expect(html).not.toContain("break-before:page");
    expect(html).toContain(".wrap{max-width:1180px");
    expect(html).not.toContain("section,section:last-of-type{width:auto;height:auto");
    expect(html).toContain("linear-gradient");
    expect(html).toContain("border-radius");
    expect(html).toContain("box-shadow");
    expect(html).toContain("@media(max-width:900px)");
    expect(html).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
  });

  test("places brand data, selected palette and the company CTA", async () => {
    const html = await renderQualityTemplate();

    expect(html).toContain("Quality Brand");
    expect(html).toContain("Я разобрал quality.example");
    expect(html).toContain("Решение — не абстрактный «AI»");
    expect(html).toContain(qualityFacts.logoUrl!);
    expect(html).toContain("--green:#a85c00");
    expect(html).toContain('font:16px/1.6 "Montserrat"');
    expect(html).toContain('href="mailto:customer@quality.example"');
    expect(html).toContain("стать понятным голосом здоровья с помощью AI-блогеров");
    expect(html).not.toContain("https://t.me/heilen18");
    expect(html).not.toContain("+375 44 555 6636");
  });

  test("renders seven Chart.js canvases with print-safe vector fallbacks", async () => {
    const html = await renderQualityTemplate();
    const $ = load(html);
    const charts = $("svg.business-chart");

    expect(charts).toHaveLength(7);
    expect($("svg.business-chart rect").length).toBeGreaterThan(12);
    expect($("svg.business-chart circle").length).toBeGreaterThan(3);
    expect($("canvas")).toHaveLength(7);
    expect(html).toContain("<!-- BOT_PRESENT_CHART_JS -->");
    expect(html).not.toContain("cdn.jsdelivr.net");
    const markupWithoutEmbeddedMedia = html.replace(/data:image\/gif;base64,[A-Za-z0-9+/=]+/g, "data:image/gif;base64,MEDIA");
    expect(markupWithoutEmbeddedMedia).not.toContain("NaN");
    expect(markupWithoutEmbeddedMedia).not.toContain("Infinity");
    expect(html).not.toContain("≈");
    expect(html).not.toContain("businessValueLabels");
    expect($("svg.business-chart .svg-value")).toHaveLength(0);
  });

  test("uses print-safe SVG and exposes render readiness for PDF", async () => {
    const html = await renderQualityTemplate();
    expect(html).toContain("preserveAspectRatio=\"xMidYMid meet\"");
    expect(html).toContain(".business-chart{display:block;width:100%;height:100%");
    expect(html).toContain("window.__BOT_PRESENT_READY__=true");
    expect(html).toContain("dataset.pdfLayout='single-page-screen'");
    expect(html.match(/class="ai-blogger-gif"/g) ?? []).toHaveLength(3);
    expect(html.match(/data:image\/gif;base64,/g) ?? []).toHaveLength(3);
  });

  test("keeps every uploaded Generic example visually complete", async () => {
    const files = (await readdir(genericRoot)).filter((name) => /^index\d*\.html$/i.test(name));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const html = await readFile(path.join(genericRoot, file), "utf8");
      const canvasIds = [...html.matchAll(/<canvas\s+id=["']([^"']+)["']/gi)].map((match) => match[1]!);
      const svgMarkers = html.match(/\{\{[A-Z_]+_CHART_SVG\}\}/g) ?? [];
      expect(html.match(/<section\b/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
      const mediaCount = (html.match(/<video\b/g)?.length ?? 0)
        + (html.match(/<div class="phone-screen">\s*<img\b/g)?.length ?? 0)
        + (html.match(/\{\{VIDEO_\d_MEDIA\}\}/g)?.length ?? 0);
      expect(mediaCount).toBe(3);
      expect(canvasIds.length + svgMarkers.length).toBeGreaterThanOrEqual(6);
      if (canvasIds.length > 0) {
        if (html.includes("<!-- BOT_PRESENT_CHART_JS -->")) expect(html).toContain("new Chart(");
        else expect(html.match(/new Chart\(/g)?.length ?? 0).toBe(canvasIds.length);
      }
      expect(html).toContain("<style");
      expect(html).toContain("linear-gradient");
      expect(html).toContain("border-radius");
      for (const id of canvasIds) expect(html.match(new RegExp(id, "g"))?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });

  test("renders the dedicated AI-blogger sales template with all requested steps", async () => {
    const template = await readFile(path.join(genericRoot, "index3.html"), "utf8");
    const html = renderPresentationTemplate(template, qualityFacts, undefined, new Date("2026-07-12T00:00:00Z"), {
      themeId: "8",
      fontFamily: "Montserrat",
      sellAiBloggers: true,
    });
    const $ = load(html);

    expect($("section[data-page]").map((_, node) => Number($(node).attr("data-page"))).get()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(html).toContain("Персональный разбор");
    expect(html).toContain("Шаг 1 · что я изучил");
    expect(html).toContain("Шаг 2 · разбор ниши покупателей");
    expect(html).toContain("Шаг 3 · почему обычные блогеры — это боль");
    expect(html).toContain("Шаг 4 · что получает бренд");
    expect(html).toContain("Шаг 5 · первая серия под вашу сеть");
    expect(html).toContain("Шаг 6 · так это уже работает");
    expect(html).toContain("--primary:#a98aff;--secondary:#392d5f");
    expect(html).toContain("linear-gradient(145deg,color-mix(in srgb,var(--panel) 82%,var(--primary))");
    expect(html).not.toContain("IAB · 2025 Creator Economy");
    expect($("#proof > .proof > .chartcard")).toHaveLength(2);
    expect($("#proof .proof-metric")).toHaveLength(0);
    expect(html).not.toContain("assets/ai-blogger-roster.png");
    expect(html).toContain("AI-блогеры для аудитории СНГ");
    expect(html.match(/class="ai-blogger-gif"/g) ?? []).toHaveLength(3);
    expect(html.match(/data:image\/gif;base64,/g) ?? []).toHaveLength(3);
    expect(html.match(/<svg class="business-chart"/g) ?? []).toHaveLength(7);
    expect(html.match(/<canvas\b/g) ?? []).toHaveLength(7);
    expect(html.match(/type="application\/json"/g) ?? []).toHaveLength(7);
    const audiencePayload = JSON.parse($("#chartAudienceData").text()) as { datasets: Array<{ backgroundColor: string[] }> };
    expect(new Set(audiencePayload.datasets[0]!.backgroundColor).size).toBeGreaterThanOrEqual(3);
    expect(audiencePayload.datasets[0]!.backgroundColor[0]).toBe("#a98aff");
    expect(html).toContain("<!-- BOT_PRESENT_CHART_JS -->");
    expect(html).not.toContain("cdn.jsdelivr.net");
    expect(html.match(/<video\b/g) ?? []).toHaveLength(0);
    expect(html).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);

    const standalone = await inlinePresentationRuntime(html);
    expect(standalone).toContain('data-botpresent-runtime="chart.js@4.5.1"');
    expect(standalone).not.toContain("<!-- BOT_PRESENT_CHART_JS -->");
  });
});
