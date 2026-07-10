import { describe, expect, test } from "bun:test";
import {
  extractExplicitUrls,
  extractTelegramContacts,
  formatLeadReport,
  parseSearchResults,
} from "../src/services/lead-generation";
import type { LeadGenerationResult } from "../src/types/lead";

describe("lead generation parsing", () => {
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
        handle: "@sales_manager",
        url: "https://t.me/sales_manager",
        label: "Анна, отдел продаж",
      },
      {
        handle: "@business_owner",
        url: "https://t.me/business_owner",
      },
    ]);
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
        website: "https://acme.example/",
        description: "CRM-интегратор",
        relevance: "Подходит по отрасли",
        telegramContacts: [{ handle: "@acme_sales", url: "https://t.me/acme_sales" }],
      }],
    };

    const report = formatLeadReport(result);
    expect(report).toContain("## 1. Acme");
    expect(report).toContain("@acme_sales");
    expect(report).toContain("Проанализировано сайтов: 3");
  });
});
