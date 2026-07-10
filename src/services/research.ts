const WIKIPEDIA_API = "https://ru.wikipedia.org/w/api.php";
const REQUEST_TIMEOUT_MS = 12_000;

export interface ResearchSource {
  title: string;
  extract: string;
  url: string;
}

interface WikipediaPage {
  pageid: number;
  title: string;
  extract?: string;
  fullurl?: string;
}

interface WikipediaResponse {
  query?: {
    pages?: Record<string, WikipediaPage>;
  };
}

export function formatResearchReport(topic: string, sources: ResearchSource[]): string {
  const createdAt = new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Moscow",
  }).format(new Date());

  const sections = sources.map((source, index) => [
    `## ${index + 1}. ${source.title}`,
    "",
    source.extract || "В источнике нет краткого описания.",
    "",
    `Источник: ${source.url}`,
  ].join("\n"));

  return [
    `# Исследование: ${topic}`,
    "",
    `Сформировано: ${createdAt}`,
    "",
    "> Автоматическая справка по открытым материалам Wikipedia. Проверяйте важные факты по первичным источникам.",
    "",
    ...sections,
    "",
    "## Рекомендуемые следующие шаги",
    "",
    "- Сформулировать конкретный исследовательский вопрос.",
    "- Сверить ключевые утверждения с первичными и актуальными источниками.",
    "- Дополнить материал отраслевыми данными и мнениями экспертов.",
  ].join("\n");
}

export async function conductResearch(topic: string): Promise<string> {
  const url = new URL(WIKIPEDIA_API);
  url.search = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: topic,
    gsrlimit: "5",
    prop: "extracts|info",
    exintro: "1",
    explaintext: "1",
    exsectionformat: "plain",
    inprop: "url",
    format: "json",
    origin: "*",
  }).toString();

  const response = await fetch(url, {
    headers: { "User-Agent": "BotPresent/1.0 (Telegram research bot)" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Wikipedia вернула HTTP ${response.status}`);
  }

  const data = await response.json() as WikipediaResponse;
  const pages = Object.values(data.query?.pages ?? {});
  const sources = pages
    .sort((a, b) => a.pageid - b.pageid)
    .map((page): ResearchSource => ({
      title: page.title,
      extract: page.extract?.trim() || "",
      url: page.fullurl || `https://ru.wikipedia.org/?curid=${page.pageid}`,
    }));

  if (sources.length === 0) {
    throw new Error("По этой теме не найдено подходящих материалов.");
  }

  return formatResearchReport(topic, sources);
}

