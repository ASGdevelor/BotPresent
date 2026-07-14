import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildFallbackResearchQueries,
  buildBusinessAnalysis,
  buildPresentationCharts,
  buildResearchQueries,
  extractWebsiteIdentity,
  groupComparableIndustryFacts,
  isResearchPageRelevant,
  isRelatedCompanyPage,
  parseBingWebsiteSnapshot,
  parseCompetitorProfiles,
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
    expect(queries).toHaveLength(6);
    expect(queries.join(" ")).toContain("2025 2026");
    expect(queries.join(" ")).toContain("Apteka.ru");
    expect(queries.join(" ")).toContain("site:dsm.ru");
    expect(queries.join(" ")).toContain("ePharma");
  });

  test("builds a broader fallback search with the current year", () => {
    const queries = buildFallbackResearchQueries("рынок корпоративного обучения", "Example");
    expect(queries).toHaveLength(6);
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

  test("builds market, audience and brand charts without exposing source URLs", () => {
    const charts = buildPresentationCharts({
      ...facts,
      statistics: [{ label: "Компания обслуживает 120 клиентов", value: "120", displayValue: "120 клиентов", unit: "клиентов", sourceUrl: facts.website }],
    }, "#123456", "#abcdef");
    expect(charts).toHaveLength(7);
    expect(charts[0]!.title).toContain("Динамика и масштаб рынка");
    expect(charts[0]!.sourceText).not.toContain("wikipedia.org");
    expect(charts[1]!.title).toContain("Структура целевой аудитории");
    expect(charts[1]!.kind).toBe("doughnut");
    expect(charts[0]!.svg).toContain("<svg");
    expect(charts[1]!.svg).toContain("<circle");
  });

  test("extracts real competitor candidates from Bing results", () => {
    const profiles = parseCompetitorProfiles(`
      <li class="b_algo"><h2><a href="https://alpha.example/">Alpha — сервис для бизнеса</a></h2><div class="b_caption"><p>Помогает компаниям автоматизировать процессы.</p></div></li>
      <li class="b_algo"><h2><a href="https://example.com/about">Example &amp; Co</a></h2><div class="b_caption"><p>Собственный сайт.</p></div></li>
    `, "https://www.bing.com/search", "Example & Co", "https://example.com/");
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ name: "Alpha", website: "https://alpha.example/" });
  });

  test("builds strengths, weaknesses and audience scores instead of source counts", () => {
    const analysis = buildBusinessAnalysis(facts);
    expect(analysis.strengths).toHaveLength(3);
    expect(analysis.weaknesses).toHaveLength(3);
    expect(analysis.audience.reduce((sum, item) => sum + item.value, 0)).toBe(100);
    expect(Object.values(analysis.scores).every((value) => value >= 18 && value <= 96)).toBeTrue();
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
    expect(html).toContain("Я разобрал example.com");
    expect(html).toContain("Решение — не абстрактный «AI»");
    expect(html).toContain("12.5");
    expect(html).toContain("https://ru.wikipedia.org/wiki/Example");
    expect(html).toContain("Запустить 90-дневный пилот AI-блогеров");
  });

  test("keeps AI-blogger content static in sales mode and supports a business-only mode", async () => {
    const template = await readFile(path.resolve(import.meta.dir, "..", "Generic", "index.html"), "utf8");
    const sectionsBefore = template.match(/<section\b/g) ?? [];
    const html = renderPresentationTemplate(template, facts);
    const businessHtml = renderPresentationTemplate(template, facts, undefined, new Date(), { sellAiBloggers: false });

    expect(html).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
    expect(html.match(/class="ai-blogger-gif"/g) ?? []).toHaveLength(3);
    expect(html.match(/data:image\/gif;base64,/g) ?? []).toHaveLength(3);
    expect(html).toContain("управляемый цифровой эксперт");
    expect(html).not.toContain("fito.roky.video");
    expect(businessHtml.match(/<video\b/g) ?? []).toHaveLength(0);
    expect(businessHtml.match(/<img\b/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(businessHtml).not.toContain("data:image/gif;base64,");
    expect(businessHtml).not.toContain("fito.roky.video");
    expect(html.match(/<section\b/g)).toHaveLength(sectionsBefore.length);
    expect(html).toContain("--green:#123456");
    expect(html).toContain('window.__BOT_PRESENT_READY__=true');
    expect(html).toContain("Содержание");
    expect(html).toContain("Персональная стратегия роста");
    expect(html).toContain("Где Example &amp; Co уже силён");
    expect(html).toContain("Рынок «Консалтинг»");
    expect(html).toContain("Контент-матрица AI-блогеров для Example &amp; Co");
    expect(html).toContain("Конкурентное поле Example &amp; Co");
    expect(html).toContain("Запустить AI-блогеров для Example &amp; Co");
    expect(businessHtml).toContain("Выводы по Example &amp; Co");
    expect(html).not.toContain("публичных источников изучено");
    expect(html.match(/<svg class="business-chart"/g) ?? []).toHaveLength(7);
  });

  test("keeps avatar variants stable for one presentation ID and changes them for another", () => {
    const template = "{{VIDEO_1_MEDIA}}|{{VIDEO_2_MEDIA}}|{{VIDEO_3_MEDIA}}";
    const first = renderPresentationTemplate(template, facts, undefined, new Date("2026-01-01T00:00:00Z"), { avatarSeed: "presentation-a" });
    const edited = renderPresentationTemplate(template, facts, undefined, new Date("2027-05-05T00:00:00Z"), { avatarSeed: "presentation-a" });
    const another = renderPresentationTemplate(template, facts, undefined, new Date("2026-01-01T00:00:00Z"), { avatarSeed: "presentation-b" });
    const gifs = (html: string) => html.match(/data:image\/gif;base64,[A-Za-z0-9+/=]+/g) ?? [];

    expect(gifs(first)).toEqual(gifs(edited));
    expect(gifs(first)).not.toEqual(gifs(another));
    expect(gifs(first)).toHaveLength(3);
  });

  test("applies isolated heading, text and photo overrides to one section", async () => {
    const template = await readFile(path.resolve(import.meta.dir, "..", "Generic", "index3.html"), "utf8");
    const html = renderPresentationTemplate(template, facts, undefined, new Date("2026-07-11T00:00:00Z"), {
      sectionEdits: {
        "3": {
          heading: "Новый <заголовок> рынка",
          text: "Локальный текст только для третьего раздела.",
          imageUrl: "https://images.example.com/market.jpg",
        },
        "5": { heading: "Реалистичные ведущие бренда" },
      },
    });

    expect(html).toContain("Новый &lt;заголовок&gt; рынка");
    expect(html).toContain("Локальный текст только для третьего раздела.");
    expect(html).toContain("Реалистичные ведущие бренда");
    expect(html).toContain('class="section-edit-image"');
    expect(html).toContain('src="https://images.example.com/market.jpg"');
    expect(html.match(/class="section-edit-image"/g) ?? []).toHaveLength(1);
    expect(html).toContain("Где Example &amp; Co уже силён");
    expect(html).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
  });

  test("uses the user-selected palette in CSS and chart datasets", async () => {
    const template = await readFile(path.resolve(import.meta.dir, "..", "Generic", "index.html"), "utf8");
    const html = renderPresentationTemplate(template, facts, undefined, new Date("2026-07-11T00:00:00Z"), {
      themeId: "3",
    });

    expect(html).toContain("--green:#6d4cc3");
    expect(html).toContain('fill="#6d4cc3"');
    expect(html).not.toContain('fill="#123456"');
    const chartJson = html.match(/<script type="application\/json" id="chartAudienceData">([^<]+)<\/script>/)?.[1];
    expect(chartJson).toBeTruthy();
    const colors = (JSON.parse(chartJson!) as { datasets: Array<{ backgroundColor: string[] }> }).datasets[0]!.backgroundColor;
    expect(new Set(colors).size).toBeGreaterThan(1);
    expect(colors.every((color) => color.startsWith("#"))).toBeTrue();
  });

  test("reports unknown markers by name", () => {
    expect(() => renderPresentationTemplate("{{UNKNOWN_FIELD}}", facts)).toThrow("{{UNKNOWN_FIELD}}");
  });
});
