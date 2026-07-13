import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildFallbackResearchQueries,
  buildPresentationCharts,
  buildResearchQueries,
  extractWebsiteIdentity,
  groupComparableIndustryFacts,
  isResearchPageRelevant,
  isRelatedCompanyPage,
  parseBingWebsiteSnapshot,
  parseResearchResults,
  parseResearchResultUrls,
  parseVerifiedNumericFacts,
  parseWebsiteStatistics,
  renderPresentationTemplate,
  sourceQualityScore,
  type IndustryFact,
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
    unit: "млн",
    sourceUrl: "https://ru.wikipedia.org/wiki/Example",
    sourceTitle: "Example",
  }],
};

describe("presentation template", () => {
  test("builds several focused research queries", () => {
    const queries = buildResearchQueries("фармацевтический рынок", "Apteka.ru");
    expect(queries).toHaveLength(5);
    expect(queries.join(" ")).toContain("2025 2026");
    expect(queries.join(" ")).toContain("Apteka.ru");
    expect(queries.join(" ")).toContain("site:dsm.ru");
    expect(queries.join(" ")).toContain("ePharma");
  });

  test("builds a broader fallback search with the current year", () => {
    const queries = buildFallbackResearchQueries("рынок корпоративного обучения", "Example");
    expect(queries).toHaveLength(5);
    expect(queries.join(" ")).toContain(String(new Date().getUTCFullYear()));
    expect(queries.join(" ")).toContain("filetype:pdf");
    expect(queries.join(" ")).toContain("Росстат ЕМИСС");
  });

  test("extracts year, unit and quality from numeric facts", () => {
    const parsed = parseVerifiedNumericFacts(`
      <title>Исследование фармацевтического рынка</title>
      <p>В 2025 году доля онлайн-продаж достигла 42,5 % от общего объёма рынка.</p>
      <p>Объём фармацевтического рынка в 2024 году составил 18,7 млрд рублей.</p>
    `, "https://rosstat.gov.ru/report");
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ value: 42.5, unit: "%", year: 2025 });
    expect(parsed[1]).toMatchObject({ value: 18.7, unit: "млрд ₽", year: 2024 });
    expect(parsed[0]!.qualityScore).toBeGreaterThan(40);
  });

  test("rejects ownership percentages that are not market indicators", () => {
    const parsed = parseVerifiedNumericFacts(`
      <title>Еаптека</title>
      <p>В 2025 году инвесторы консолидировали 100 % акций компании.</p>
      <p>В 2025 году доля онлайн-продаж на фармацевтическом рынке достигла 21 %.</p>
    `, "https://ru.wikipedia.org/wiki/Test");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.value).toBe(21);
  });

  test("rejects one competitor revenue from an industry chart", () => {
    const parsed = parseVerifiedNumericFacts(`
      <title>Еаптека</title>
      <p>В 2020 году выручка ООО «Еаптека» составила 5,1 млрд рублей.</p>
      <p>Объём российского фармацевтического рынка в 2025 году достиг 3,2 млрд рублей.</p>
    `, "https://ru.wikipedia.org/wiki/Test");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.value).toBe(3.2);
  });

  test("rejects a competitor catalog size presented as an industry metric", () => {
    const parsed = parseVerifiedNumericFacts(`
      <title>Интернет-аптека</title>
      <p>Заказ лекарств онлайн: более 20 тысяч лекарственных средств и товаров с доставкой по всей России.</p>
    `, "https://competitor.example/catalog");
    expect(parsed).toEqual([]);
  });

  test("never mixes percentages and money in one chart group", () => {
    const comparable: IndustryFact[] = [
      { label: "Доля A", value: 42, displayValue: "42 %", unit: "%", sourceUrl: "https://a.example", sourceTitle: "A" },
      { label: "Доля B", value: 51, displayValue: "51 %", unit: "%", sourceUrl: "https://b.example", sourceTitle: "B" },
      { label: "Объём", value: 18, displayValue: "18 млрд ₽", unit: "млрд ₽", sourceUrl: "https://c.example", sourceTitle: "C" },
    ];
    const groups = groupComparableIndustryFacts(comparable);
    expect(groups[0]!.map((fact) => fact.unit)).toEqual(["%", "%"]);
    expect(groups[1]!.map((fact) => fact.unit)).toEqual(["млрд ₽"]);
  });

  test("prefers official statistics over encyclopedias and social media", () => {
    expect(sourceQualityScore("https://rosstat.gov.ru/report")).toBeGreaterThan(sourceQualityScore("https://ru.wikipedia.org/wiki/Test"));
    expect(sourceQualityScore("https://ru.wikipedia.org/wiki/Test")).toBeGreaterThan(sourceQualityScore("https://vk.com/test"));
  });

  test("extracts public research pages from search results", () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fresearch.example%2Freport">Report</a>
      <a class="result__a" href="javascript:alert(1)">Bad</a>
    `;
    expect(parseResearchResultUrls(html, "https://html.duckduckgo.com/html/")).toEqual([
      "https://research.example/report",
    ]);
    expect(parseResearchResultUrls(
      '<a href="/url?q=https%3A%2F%2Frosstat.gov.ru%2Fmarket"><h3>Official report</h3></a>',
      "https://www.google.com/search?q=test",
    )).toEqual(["https://rosstat.gov.ru/market"]);
  });

  test("keeps numeric search snippets as a fallback when a result page cannot be opened", () => {
    const results = parseResearchResults(`<?xml version="1.0"?>
      <rss><channel><item><title>Фармацевтический рынок России</title>
      <link>https://research.example/report.pdf</link>
      <description>В 2026 году объем фармацевтического рынка достиг 2,4 трлн рублей.</description>
      </item></channel></rss>`, "https://www.bing.com/search?format=rss&q=test");
    expect(results).toEqual([{
      url: "https://research.example/report.pdf",
      title: "Фармацевтический рынок России",
      snippet: "В 2026 году объем фармацевтического рынка достиг 2,4 трлн рублей.",
    }]);
  });

  test("extracts informative statistics from the official company site", () => {
    const statistics = parseWebsiteStatistics(`
      <section><h2>Нам доверяют 12 500 клиентов в 34 городах</h2>
      <p>За 10 лет команда завершила 860 проектов.</p></section>
    `, "https://company.example/about");
    expect(statistics.map((item) => item.displayValue)).toEqual([
      "12 500 клиентов", "34 регионов", "10 лет", "860 проектов",
    ]);
    expect(statistics.every((item) => item.sourceUrl === "https://company.example/about")).toBeTrue();
  });

  test("does not mix market share and growth percentages in one chart", () => {
    const comparable: IndustryFact[] = [
      { label: "Доля онлайн-продаж", value: 42, displayValue: "42 %", unit: "%", sourceUrl: "https://a.example", sourceTitle: "A" },
      { label: "Доля офлайн-продаж", value: 58, displayValue: "58 %", unit: "%", sourceUrl: "https://b.example", sourceTitle: "B" },
      { label: "Рост рынка за год", value: 12, displayValue: "12 %", unit: "%", sourceUrl: "https://c.example", sourceTitle: "C" },
      { label: "Темп увеличения спроса", value: 9, displayValue: "9 %", unit: "%", sourceUrl: "https://d.example", sourceTitle: "D" },
    ];
    const groups = groupComparableIndustryFacts(comparable);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.every((item) => /Доля/.test(item.label))).toBeTrue();
    expect(groups[1]!.every((item) => /Рост|Темп/.test(item.label))).toBeTrue();
  });

  test("does not compare annual order totals with one-month totals", () => {
    const comparable: IndustryFact[] = [
      { label: "В 2026 году рынок достигнет 379 млн заказов", value: 379, displayValue: "379 млн", unit: "млн", year: 2026, sourceUrl: "https://a.example", sourceTitle: "A" },
      { label: "В 2025 году количество составило 290 млн заказов", value: 290, displayValue: "290 млн", unit: "млн", year: 2025, sourceUrl: "https://b.example", sourceTitle: "B" },
      { label: "В декабре рынок показал 30 млн заказов", value: 30, displayValue: "30 млн", unit: "млн", sourceUrl: "https://c.example", sourceTitle: "C" },
      { label: "Рынок начал год с 27,7 млн заказов", value: 27.7, displayValue: "27,7 млн", unit: "млн", sourceUrl: "https://d.example", sourceTitle: "D" },
    ];
    const groups = groupComparableIndustryFacts(comparable);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.map((item) => item.value))).toEqual([[379, 290], [30, 27.7]]);
  });

  test("builds separate sourced charts for research and official-site figures", () => {
    const charts = buildPresentationCharts({
      ...facts,
      statistics: [{ label: "Компания обслуживает 120 клиентов", value: "120", displayValue: "120 клиентов", unit: "клиентов", sourceUrl: facts.website }],
    }, "#123456", "#abcdef");
    expect(charts).toHaveLength(7);
    expect(charts[0]!.title).toContain("интернет-исследования");
    expect(charts[0]!.sourceText).toContain("wikipedia.org");
    expect(charts[1]!.title).toContain("официального сайта");
    expect(charts[1]!.sourceText).toContain(facts.website);
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
    expect(isResearchPageRelevant(
      "<title>Рынок интернет-аптек начал год с 27,7 млн заказов</title>",
      "интернет аптека",
    )).toBeTrue();
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
    expect(html).not.toContain("Список использованных источников информации");
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
