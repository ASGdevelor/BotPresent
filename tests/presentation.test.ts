import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  extractWebsiteIdentity,
  isResearchPageRelevant,
  isRelatedCompanyPage,
  parseBingWebsiteSnapshot,
  parseResearchResultUrls,
  renderPresentationTemplate,
  type WebsiteFacts,
} from "../src/services/presentation";

const facts: WebsiteFacts = {
  companyName: "Example & Co",
  website: "https://example.com/",
  description: "Публичное <описание>",
  headings: ["О компании", "Услуги"],
  services: ["Аудит", "Презентации"],
  contacts: ["hello@example.com"],
  sources: ["https://example.com/"],
  primaryColor: "#123456",
  secondaryColor: "#abcdef",
  statistics: [],
  advantages: [],
  industry: "Консалтинг",
  industryFacts: [{
    label: "Объём отрасли составил 12,5 млн",
    value: 12.5,
    displayValue: "12,5 млн",
    sourceUrl: "https://ru.wikipedia.org/wiki/Example",
    sourceTitle: "Example",
  }],
};

describe("presentation template", () => {
  test("extracts public research pages from search results", () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fresearch.example%2Freport">Report</a>
      <a class="result__a" href="javascript:alert(1)">Bad</a>
    `;
    expect(parseResearchResultUrls(html, "https://html.duckduckgo.com/html/")).toEqual([
      "https://research.example/report",
    ]);
  });

  test("builds a website snapshot from exact-domain Bing results after DNS failure", () => {
    const target = "https://apteka.ru/about/";
    const encoded = Buffer.from(target).toString("base64url");
    const snapshot = parseBingWebsiteSnapshot(`
      <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1${encoded}">Интернет-аптека Apteka.ru</a></h2>
      <div class="b_caption"><p>Заказ лекарств с получением в 35000 аптек в 95 городах.</p></div></li>
    `, "https://apteka.ru/");
    expect(snapshot?.companyName).toBe("Apteka.ru");
    expect(snapshot?.description).toContain("35000 аптек");
    expect(snapshot?.sources).toContain(target);
    expect(snapshot?.logoUrl).toBe("https://apteka.ru/favicon.ico");
  });

  test("builds the same snapshot from Bing RSS output", () => {
    const snapshot = parseBingWebsiteSnapshot(`<?xml version="1.0"?>
      <rss><channel><item><title>Посторонний сайт</title><link>https://other.example/</link><description>Чужое описание.</description></item>
      <item><title>Интернет-аптека Apteka.ru</title>
      <link>https://apteka.ru/</link><description>Заказ лекарств и товаров для здоровья.</description></item></channel></rss>
    `, "https://apteka.ru/");
    expect(snapshot?.companyName).toBe("Apteka.ru");
    expect(snapshot?.sources).toEqual(["https://apteka.ru/"]);
    expect(snapshot?.description).toContain("Заказ лекарств");
    expect(snapshot?.description).not.toContain("Чужое описание");
  });

  test("rejects numeric research pages unrelated to the explicit industry", () => {
    expect(isResearchPageRelevant(
      "<title>Статистика стоматологии России</title><p>Рынок вырос на 12 %</p>",
      "стоматология",
    )).toBeTrue();
    expect(isResearchPageRelevant(
      "<title>Cookie и доменные имена</title><p>Доля файлов 42 %</p>",
      "стоматология",
    )).toBeFalse();
    expect(isResearchPageRelevant(
      "<title>Интернет — глобальная сеть</title><p>Доступ имеют 67 % жителей.</p>",
      "фармацевтический рынок и интернет-аптеки",
    )).toBeFalse();
  });

  test("extracts title, body, brand palette and the real logo from site HTML", () => {
    const identity = extractWebsiteIdentity(`
      <html><head>
        <title>Fixture Company — официальный сайт</title>
        <meta property="og:image" content="/hero.jpg">
        <style>:root{--brand:#13579b;--accent:rgb(240, 180, 20)}</style>
        <script type="application/ld+json">{"@type":"Organization","logo":{"url":"/assets/logo.svg"}}</script>
      </head><body><p>Описание из body без элемента main.</p></body></html>
    `, "https://fixture.example/catalog/");

    expect(identity.companyName).toBe("Fixture Company");
    expect(identity.description).toContain("Описание из body");
    expect(identity.logoUrl).toBe("https://fixture.example/assets/logo.svg");
    expect(identity.logoUrl).not.toContain("hero.jpg");
    expect(identity.primaryColor).toBeDefined();
    expect(identity.secondaryColor).toBeDefined();
    expect(identity.industry).toBe("отрасль компании");
  });

  test("keeps hyphenated brand names and does not treat contact lenses as contacts", () => {
    const identity = extractWebsiteIdentity(
      "<title>Интернет-аптека Apteka.ru в Москве - заказ лекарств</title>",
      "https://apteka.ru/",
    );
    expect(identity.companyName).toBe("Apteka.ru");
    expect(identity.industry).toBe("фармацевтический рынок и интернет-аптеки");
    expect(isRelatedCompanyPage("/product/lenses", "Контактные линзы")).toBeFalse();
    expect(isRelatedCompanyPage("/about/contacts/", "Наши контакты")).toBeTrue();
  });

  test("fills compact and extended Generic markers without inventing market data", () => {
    const template = [
      "{{COMPANY}}", "{{DESCRIPTION}}", "{{SERVICE_CARDS}}", "{{CONTACTS}}",
      "{{INDUSTRY}}", "{{PRODUCT_1_TITLE}}", "{{KPI_1}}", "{{ABOUT_CARDS}}",
      "{{MARKET_CHART_DATA}}", "{{MARKET_SOURCE}}", "{{MATRIX_STEPS}}", "{{OFFER_CTA}}",
    ].join("|");
    const html = renderPresentationTemplate(template, facts, { leadRelevance: "Точное совпадение" }, new Date("2026-07-11T00:00:00Z"));
    expect(html).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
    expect(html).toContain("Example &amp; Co");
    expect(html).toContain("Публичное &lt;описание&gt;");
    expect(html).toContain("12.5");
    expect(html).toContain("https://ru.wikipedia.org/wiki/Example");
    expect(html).toContain("Перейти на сайт компании");
  });

  test("fills the repository template while preserving all video elements exactly", async () => {
    const template = await readFile(path.resolve(import.meta.dir, "..", "Generic", "index.html"), "utf8");
    const videosBefore = template.match(/<video\b[^>]*><\/video>/g) ?? [];
    const videoSourcesBefore = template.match(/https:\/\/fito\.roky\.video\/[^\"']+/g) ?? [];
    const sectionsBefore = template.match(/<section\b/g) ?? [];
    const html = renderPresentationTemplate(template, facts);
    const videosAfter = html.match(/<video\b[^>]*><\/video>/g) ?? [];
    const videoSourcesAfter = html.match(/https:\/\/fito\.roky\.video\/[^\"']+/g) ?? [];

    expect(html).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
    expect(videosBefore).toHaveLength(3);
    expect(videosAfter).toEqual(videosBefore);
    expect(videoSourcesAfter).toEqual(videoSourcesBefore);
    expect(html.match(/<section\b/g)).toHaveLength(sectionsBefore.length);
    expect(html).toContain("--green:#123456");
    expect(html).toContain('window.__BOT_PRESENT_READY__=true');
    expect(html).toContain("Содержание");
    expect(html).toContain("Введение");
    expect(html).toContain("1.1. Общие сведения о предприятии");
    expect(html).toContain("2. Характеристика и описание информационных инструментов");
    expect(html).toContain("3. Характеристика и описание разделов и подразделов");
    expect(html).toContain("4. Индивидуальное задание");
    expect(html).toContain("Заключение");
    expect(html).toContain("Список использованных источников информации");
  });

  test("uses the user-selected palette in CSS and chart datasets", async () => {
    const template = await readFile(path.resolve(import.meta.dir, "..", "Generic", "index.html"), "utf8");
    const html = renderPresentationTemplate(template, facts, undefined, new Date("2026-07-11T00:00:00Z"), {
      themeId: "3",
    });

    expect(html).toContain("--green:#6d4cc3");
    expect(html).toContain('"backgroundColor":["#6d4cc3"]');
    expect(html).not.toContain('"backgroundColor":["#123456"]');
  });

  test("reports unknown markers by name", () => {
    expect(() => renderPresentationTemplate("{{UNKNOWN_FIELD}}", facts)).toThrow("{{UNKNOWN_FIELD}}");
  });
});
