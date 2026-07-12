import { afterEach, describe, expect, test } from "bun:test";
import { formatHistoryReport, MessageHistory } from "../src/services/message-history";

const stores: MessageHistory[] = [];

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});
function createStore(maxMessagesPerUser = 200): MessageHistory {
  const store = new MessageHistory(":memory:", { maxMessagesPerUser });
  stores.push(store);
  return store;
}

describe("message history", () => {
  test("stores messages separately for each user", () => {
    const store = createStore();
    store.record(10, 100, "user", "Кого ищем?");
    store.record(10, 100, "bot", "Опишите тип компаний");
    store.record(10, 200, "user", "Другое сообщение");

    const messages = store.list(10, 100);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.direction)).toEqual(["user", "bot"]);
    expect(messages.map((message) => message.text)).toEqual([
      "Кого ищем?",
      "Опишите тип компаний",
    ]);
  });

  test("keeps only the configured number of recent messages", () => {
    const store = createStore(2);
    store.record(10, 100, "user", "Первое");
    store.record(10, 100, "bot", "Второе");
    store.record(10, 100, "user", "Третье");

    expect(store.list(10, 100).map((message) => message.text)).toEqual(["Второе", "Третье"]);
  });

  test("exports and clears history", () => {
    const store = createStore();
    store.record(10, 100, "user", "Привет", new Date("2026-07-10T10:00:00Z"));

    expect(formatHistoryReport(store.list(10, 100))).toContain("Пользователь:** Привет");
    expect(store.clear(10, 100)).toBe(1);
    expect(store.list(10, 100)).toEqual([]);
  });

  test("records presentation result with research status and source URLs", () => {
    const store = createStore();
    store.recordPresentationResult(10, 100, {
      id: "example-1",
      companyName: "Example",
      website: "https://example.com/",
      sources: ["https://example.com/", "https://ru.wikipedia.org/wiki/Example"],
      researchStatus: "verified",
    });

    const [message] = store.list(10, 100);
    expect(message?.direction).toBe("system");
    expect(message?.text).toContain("example-1");
    expect(message?.text).toContain("проверяемые отраслевые данные найдены");
    expect(message?.text).toContain("https://ru.wikipedia.org/wiki/Example");
  });
});
