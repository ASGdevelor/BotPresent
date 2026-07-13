import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import {
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

function chartPayloads(html: string): Array<{ labels: string[]; datasets: Array<{ data: number[] }> }> {
  return [...html.matchAll(/\r?\n data:(\{[^\r\n]+\}),\r?\n options:/g)].map((match) => JSON.parse(match[1]!) as {
    labels: string[];
    datasets: Array<{ data: number[] }>;
  });
}

describe("Generic template visual and data quality", () => {
  test("renders eight ordered 16:9 slides with required visual styles", async () => {
    const html = await renderQualityTemplate();
    const $ = load(html);
    const pages = $("section[data-page]").map((_, node) => Number($(node).attr("data-page"))).get();

    expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(html).toContain("@page{size:16in 9in");
    expect(html).toContain("linear-gradient");
    expect(html).toContain("border-radius");
    expect(html).toContain("box-shadow");
    expect(html).toContain("@media(max-width:900px)");
    expect(html).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
  });

  test("places brand data and selected palette without replacing static contacts", async () => {
    const html = await renderQualityTemplate();

    expect(html).toContain("Quality Brand");
    expect(html).toContain(qualityFacts.description);
    expect(html).toContain(qualityFacts.logoUrl!);
    expect(html).toContain("--green:#a85c00");
    expect(html).toContain('font:16px/1.6 "Montserrat"');
    expect(html).toContain("https://t.me/heilen18");
    expect(html).toContain("+375 44 555 6636");
    expect(html).not.toContain("customer@quality.example");
    expect(html).not.toContain("+7 000 000-00-00");
  });

  test("connects every canvas to chart code and produces finite comparable datasets", async () => {
    const html = await renderQualityTemplate();
    const $ = load(html);
    const canvasIds = $("canvas[id]").map((_, node) => $(node).attr("id")!).get();
    const charts = chartPayloads(html);

    expect(canvasIds).toHaveLength(7);
    expect(charts).toHaveLength(canvasIds.length);
    for (const id of canvasIds) expect(html.match(new RegExp(id, "g"))?.length ?? 0).toBeGreaterThanOrEqual(2);
    for (const chart of charts) {
      expect(chart.labels.length).toBe(chart.datasets[0]!.data.length);
      expect(chart.datasets[0]!.data.every(Number.isFinite)).toBeTrue();
    }
    expect(charts[0]!.datasets[0]!.data).toEqual([51, 42]);
    expect(charts[1]!.datasets[0]!.data).toEqual([22, 18]);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
  });

  test("contains an offline canvas fallback and exposes render readiness for PDF", async () => {
    const html = await renderQualityTemplate();
    expect(html).toContain("Offline/PDF fallback");
    expect(html).toContain("canvas.getContext('2d')");
    expect(html).toContain("window.__BOT_PRESENT_READY__=true");
  });

  test("keeps every uploaded Generic example visually complete", async () => {
    const files = (await readdir(genericRoot)).filter((name) => /^index\d*\.html$/i.test(name));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const html = await readFile(path.join(genericRoot, file), "utf8");
      const canvasIds = [...html.matchAll(/<canvas\s+id=["']([^"']+)["']/gi)].map((match) => match[1]!);
      expect(html.match(/<section\b/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
      expect(html.match(/<video\b/g)?.length ?? 0).toBe(3);
      expect(canvasIds.length).toBeGreaterThanOrEqual(6);
      expect(html.match(/new Chart\(/g)?.length ?? 0).toBe(canvasIds.length);
      expect(html).toContain("<style");
      expect(html).toContain("linear-gradient");
      expect(html).toContain("border-radius");
      for (const id of canvasIds) expect(html.match(new RegExp(id, "g"))?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
