import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;
const MAX_HTML_SIZE = 2_000_000;

export class PublicWebError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PublicWebError";
  }
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;

  const [a, b] = parts as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
}

export function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  const version = isIP(normalized);
  if (version === 4) return isPrivateIpv4(normalized);
  if (version !== 6) return true;

  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpv4(normalized.slice("::ffff:".length));
  }

  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("2001:db8:");
}

export function parsePublicHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new PublicWebError("Некорректный URL сайта.", { cause: error });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PublicWebError("Разрешены только HTTP- и HTTPS-сайты.");
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new PublicWebError("Локальные адреса запрещены.");
  }
  if (isIP(hostname) && isPrivateIp(hostname)) {
    throw new PublicWebError("Приватные и служебные IP-адреса запрещены.");
  }

  url.username = "";
  url.password = "";
  return url;
}

async function assertPublicDns(url: URL): Promise<void> {
  if (isIP(url.hostname)) return;

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new PublicWebError(`Не удалось определить адрес сайта ${url.hostname}.`, { cause: error });
  }

  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new PublicWebError(`Сайт ${url.hostname} ведёт на запрещённый сетевой адрес.`);
  }
}

export async function fetchPublicHtml(input: string): Promise<{ html: string; finalUrl: string }> {
  let url = parsePublicHttpUrl(input);

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await assertPublicDns(url);

    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "ru,en;q=0.8",
          "User-Agent": "BotPresent/1.1 (+https://github.com/ASGdevelor/BotPresent)",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new PublicWebError(`Не удалось загрузить ${url.hostname}.`, { cause: error });
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new PublicWebError(`Сайт ${url.hostname} вернул пустой редирект.`);
      if (redirect === MAX_REDIRECTS) throw new PublicWebError("Слишком много перенаправлений.");
      url = parsePublicHttpUrl(new URL(location, url).toString());
      continue;
    }

    if (!response.ok) {
      throw new PublicWebError(`Сайт ${url.hostname} вернул HTTP ${response.status}.`);
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new PublicWebError(`Сайт ${url.hostname} вернул не HTML-документ.`);
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_HTML_SIZE) {
      throw new PublicWebError(`HTML сайта ${url.hostname} превышает допустимый размер.`);
    }

    const html = await response.text();
    if (html.length > MAX_HTML_SIZE) {
      throw new PublicWebError(`HTML сайта ${url.hostname} превышает допустимый размер.`);
    }

    return { html, finalUrl: url.toString() };
  }

  throw new PublicWebError("Не удалось завершить загрузку сайта.");
}
