import { describe, expect, test } from "bun:test";
import {
  buildLeadSearchQueries,
  extractExplicitUrls,
  extractTelegramContacts,
  formatLeadCsv,
  formatLeadHtml,
  formatLeadReport,
  inferContactRole,
  parseBingRssResults,
  parseSearchResults,
  scoreCompany,
} from "../src/services/lead-generation";
import type { LeadGenerationResult } from "../src/types/lead";

describe("lead generation parsing", () => {
  test("ranks exact, partial and similar niche matches", () => {
    const criteria = {
      whoCanBuy: "сети частных стоматологий",
      whoToFind: "стоматологические клиники имплантация ортодонтия",
      whereToSearch: "Москва",
      offer: "AI-видеоконтент",
      exclusions: "нет",
    };
    const exact = scoreCompany("Сеть частных стоматологических клиник: имплантация и ортодонтия", criteria, true, 2);
    const similar = scoreCompany("Медицинский информационный портал", criteria, false, 0);
    expect(exact.score).toBeGreaterThan(similar.score);
    expect(exact.matchKind).toBe("exact");
    expect(similar.matchKind).toBe("similar");
  });

  test("does not downgrade an exact company match when buyer role is absent", () => {
    const criteria = {
      whoCanBuy: "владелец сайта",
      whoToFind: "Example Domain",
      whereToSearch: "https://example.com",
      offer: "создание презентации",
      exclusions: "нет",
    };
    const result = scoreCompany("Example Domain is reserved for documentation", criteria, true, 0);
    expect(result.matchKind).toBe("exact");
    expect(result.matchedKeywords).toEqual(["exam", "domain"]);
  });
  test("extracts explicit sites from the search field", () => {
    expect(extractExplicitUrls("Москва: example.com, https://acme.ru/contacts")).toEqual([
      "https://example.com/",
      "https://acme.ru/contacts",
    ]);
  });

  test("parses and unwraps DuckDuckGo result URLs", () => {
    const target = encodeURIComponent("https://company.example/contacts");
    const html = `<a class="result__a" href="//duckduckgo.com/l/?uddg=${target}">Компания</a>`;
    expect(parseSearchResults(html)).toEqual(["https://company.example/contacts"]);
  });

  test("parses and unwraps Bing result URLs", () => {
    const target = Buffer.from("https://company.example/sales", "utf8").toString("base64url");
    const html = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1${target}">Компания</a></h2></li>`;
    expect(parseSearchResults(html)).toEqual(["https://company.example/sales"]);
  });

  test("parses official sites from Bing RSS", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>Acme dental clinic</title><description>Dentistry</description><link>https://acme.example/about</link></item>
      <item><title>Unrelated download</title><description>Movies</description><link>https://random.example/</link></item>
      <item><title>Search</title><link>https://www.bing.com/search?q=acme</link></item>
    </channel></rss>`;
    expect(parseBingRssResults(xml, ["dental"])).toEqual(["https://acme.example/about"]);
  });

  test("uses every questionnaire answer in search and applies exclusions", () => {
    const queries = buildLeadSearchQueries({
      whoCanBuy: "владельцы сетей клиник",
      whoToFind: "стоматологические клиники",
      whereToSearch: "Россия Москва",
      offer: "AI-видео для записи пациентов",
      exclusions: "агрегаторы, франшизы",
    }).join("\n");
    expect(queries).toContain("владельцы сетей клиник");
    expect(queries).toContain("стоматологические клиники");
    expect(queries).toContain("Россия Москва");
    expect(queries).toContain("AI-видео для записи пациентов");
    expect(queries).toContain("-агрегаторы");
    expect(queries).toContain("-франшизы");
  });

  test("rejects a buyer-only match without target-company evidence", () => {
    const result = scoreCompany("Владельцы бизнеса и отдел продаж", {
      whoCanBuy: "владельцы бизнеса",
      whoToFind: "производители медицинского оборудования",
      whereToSearch: "Москва",
      offer: "AI-видео",
      exclusions: "нет",
    }, true, 2);
    expect(result.matchKind).toBe("similar");
  });

  test("extracts only public Telegram handles and excludes bots", () => {
    const html = `
      <body>
        <a href="https://t.me/sales_manager">Анна, отдел продаж</a>
        <a href="https://t.me/support_bot">Поддержка</a>
        <a href="https://t.me/+privateInvite">Закрытая группа</a>
        Telegram: @business_owner
      </body>
    `;
    expect(extractTelegramContacts(html)).toEqual([
      {
        handle: "@business_owner",
        url: "https://t.me/business_owner",
        role: "director",
      },
      {
        handle: "@sales_manager",
        url: "https://t.me/sales_manager",
        role: "sales",
        label: "Анна, отдел продаж",
      },
    ]);
  });

  test("classifies decision-maker roles from public context", () => {
    expect(inferContactRole("Иван — генеральный директор")).toBe("director");
    expect(inferContactRole("Анна, менеджер отдела продаж")).toBe("sales");
    expect(inferContactRole("Официальный канал компании")).toBe("company");
    expect(inferContactRole("Связаться в Telegram")).toBe("unknown");
  });

  test("formats a report with company and contact", () => {
    const result: LeadGenerationResult = {
      criteria: {
        whoCanBuy: "компании с отделом продаж",
        whoToFind: "интеграторы CRM",
        whereToSearch: "Москва",
        offer: "автоматизацию отчётности",
        exclusions: "фрилансеры",
      },
      analyzedSites: 3,
      warnings: [],
      leads: [{
        companyName: "Acme",
        siteName: "acme.example",
        website: "https://acme.example/",
        description: "CRM-интегратор",
        relevance: "Подходит по отрасли",
        telegramContacts: [{
          handle: "@acme_sales",
          url: "https://t.me/acme_sales",
          role: "sales",
          sourceUrl: "https://acme.example/contacts",
        }],
      }],
    };

    const report = formatLeadReport(result);
    expect(report).toContain("## 1. Acme");
    expect(report).toContain("@acme_sales");
    expect(report).toContain("Проанализировано сайтов: 3");
    expect(report).toContain("продажи / развитие бизнеса");
    expect(report).toContain("источник: https://acme.example/contacts");
  });

  test("includes a company even when Telegram contacts are absent", () => {
    const result: LeadGenerationResult = {
      criteria: {
        whoCanBuy: "компании",
        whoToFind: "производители",
        whereToSearch: "example.com",
        offer: "автоматизацию",
        exclusions: "нет",
      },
      analyzedSites: 1,
      warnings: [],
      leads: [{
        companyName: "Factory",
        siteName: "example.com",
        website: "https://example.com/",
        description: "Производитель",
        relevance: "Подходит по отрасли",
        telegramContacts: [],
      }],
    };

    const report = formatLeadReport(result);
    const html = formatLeadHtml(result);
    expect(report).toContain("Название сайта: example.com");
    expect(report).not.toContain("не найдены");
    expect(report).not.toContain("Telegram-контакты");
    expect(html).not.toContain(">—<");
    expect(html).toContain("https://example.com/");
    expect(formatLeadCsv(result)).toContain("Тип совпадения,Релевантность %");
  });
});
