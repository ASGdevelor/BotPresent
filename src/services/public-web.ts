import { isIP } from "node:net";
import { lookup, Resolver } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;
const MAX_RESOURCE_SIZE = 2_000_000;
const MAX_HTML_SIZE = 6_000_000;
const MAX_IMAGE_SIZE = 10_000_000;

export class PublicWebError extends Error {
  readonly code?: "DNS_LOOKUP" | "FETCH_FAILED" | "HTTP_ERROR" | "INVALID_RESPONSE";

  constructor(message: string, options?: ErrorOptions & { code?: PublicWebError["code"] }) {
    super(message, options);
    this.name = "PublicWebError";
    this.code = options?.code;
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

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

function assertAddressesPublic(url: URL, addresses: ResolvedAddress[]): void {
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new PublicWebError(`Сайт ${url.hostname} ведёт на запрещённый сетевой адрес.`);
  }
}

async function resolveWithPublicDns(url: URL): Promise<ResolvedAddress[]> {
  const resolver = new Resolver();
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  const [ipv4, ipv6] = await Promise.allSettled([
    resolver.resolve4(url.hostname),
    resolver.resolve6(url.hostname),
  ]);
  return [
    ...(ipv4.status === "fulfilled" ? ipv4.value.map((address) => ({ address, family: 4 as const })) : []),
    ...(ipv6.status === "fulfilled" ? ipv6.value.map((address) => ({ address, family: 6 as const })) : []),
  ];
}

/** Returns a pinned public address only when the operating-system resolver failed. */
async function assertPublicDns(url: URL): Promise<ResolvedAddress | undefined> {
  if (isIP(url.hostname)) return undefined;

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch (error) {
    try {
      const fallback = await resolveWithPublicDns(url);
      assertAddressesPublic(url, fallback);
      return fallback[0];
    } catch (fallbackError) {
      throw new PublicWebError(`Не удалось определить адрес сайта ${url.hostname}.`, {
        cause: fallbackError instanceof Error ? fallbackError : error,
        code: "DNS_LOOKUP",
      });
    }
  }
  assertAddressesPublic(url, addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 })));
  return undefined;
}

async function fetchPinnedResource(url: URL, resolved: ResolvedAddress, accept: string, maxSize: number): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      headers: {
        Accept: accept,
        "Accept-Encoding": "identity",
        "Accept-Language": "ru,en;q=0.8",
        "User-Agent": "BotPresent/1.2 (+https://github.com/ASGdevelor/BotPresent)",
      },
      lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options?.all) callback(null, [resolved]);
        else callback(null, resolved.address, resolved.family);
      }) as never,
    }, (incoming) => {
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxSize) {
          request.destroy(new PublicWebError(`Ответ сайта ${url.hostname} превышает допустимый размер.`));
          return;
        }
        chunks.push(chunk);
      });
      incoming.once("error", reject);
      incoming.once("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
          else if (value !== undefined) headers.set(name, value);
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: incoming.statusCode ?? 500,
          statusText: incoming.statusMessage,
          headers,
        }));
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("Request timeout")));
    request.once("error", reject);
    request.end();
  });
}

async function fetchPublicResource(
  input: string,
  accept: string,
  allowedTypes: string[],
  maxSize = MAX_RESOURCE_SIZE,
): Promise<{ body: Uint8Array; contentType: string; finalUrl: string }> {
  let url = parsePublicHttpUrl(input);

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const pinnedAddress = await assertPublicDns(url);

    let response: Response;
    try {
      response = pinnedAddress ? await fetchPinnedResource(url, pinnedAddress, accept, maxSize) : await fetch(url, {
        redirect: "manual",
        headers: {
          Accept: accept,
          "Accept-Language": "ru,en;q=0.8",
          "User-Agent": "BotPresent/1.1 (+https://github.com/ASGdevelor/BotPresent)",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new PublicWebError(`Не удалось загрузить ${url.hostname}.`, { cause: error, code: "FETCH_FAILED" });
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new PublicWebError(`Сайт ${url.hostname} вернул пустой редирект.`);
      if (redirect === MAX_REDIRECTS) throw new PublicWebError("Слишком много перенаправлений.");
      url = parsePublicHttpUrl(new URL(location, url).toString());
      continue;
    }

    if (!response.ok) {
      throw new PublicWebError(`Сайт ${url.hostname} вернул HTTP ${response.status}.`, { code: "HTTP_ERROR" });
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !allowedTypes.some((type) => contentType.includes(type))) {
      throw new PublicWebError(`Сайт ${url.hostname} вернул неподдерживаемый тип данных.`);
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > maxSize) {
      throw new PublicWebError(`Ответ сайта ${url.hostname} превышает допустимый размер.`);
    }

    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maxSize) {
      throw new PublicWebError(`Ответ сайта ${url.hostname} превышает допустимый размер.`);
    }

    return { body, contentType, finalUrl: url.toString() };
  }

  throw new PublicWebError("Не удалось завершить загрузку сайта.");
}

export async function fetchPublicHtml(input: string): Promise<{ html: string; finalUrl: string }> {
  const result = await fetchPublicResource(
    input,
    "text/html,application/xhtml+xml",
    ["text/html", "application/xhtml+xml"],
    MAX_HTML_SIZE,
  );
  return { html: new TextDecoder().decode(result.body), finalUrl: result.finalUrl };
}

/** Загружает публичный CSS с теми же SSRF-, redirect- и size-проверками, что и HTML. */
export async function fetchPublicCss(input: string): Promise<{ css: string; finalUrl: string }> {
  const result = await fetchPublicResource(input, "text/css,*/*;q=0.1", ["text/css"]);
  return { css: new TextDecoder().decode(result.body), finalUrl: result.finalUrl };
}

/** Загружает публичный RSS/XML, например серверную выдачу Bing. */
export async function fetchPublicXml(input: string): Promise<{ xml: string; finalUrl: string }> {
  const result = await fetchPublicResource(
    input,
    "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.1",
    ["application/rss+xml", "application/xml", "text/xml"],
  );
  return { xml: new TextDecoder().decode(result.body), finalUrl: result.finalUrl };
}

/** Загружает публичное изображение с теми же DNS-, redirect- и size-проверками, что и HTML. */
export async function fetchPublicImage(input: string): Promise<{
  body: Uint8Array;
  contentType: string;
  finalUrl: string;
}> {
  const result = await fetchPublicResource(
    input,
    "image/avif,image/webp,image/svg+xml,image/png,image/jpeg,image/gif,*/*;q=0.1",
    ["image/avif", "image/webp", "image/svg+xml", "image/png", "image/jpeg", "image/gif", "image/x-icon"],
    MAX_IMAGE_SIZE,
  );
  return {
    body: result.body,
    contentType: result.contentType.split(";", 1)[0] || "application/octet-stream",
    finalUrl: result.finalUrl,
  };
}
