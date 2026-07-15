import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { fetchPublicImage } from "./public-web";

const OPENAI_VIDEO_ENDPOINT = "https://api.openai.com/v1/videos";
const MAX_VIDEO_BYTES = 120_000_000;

export interface AiVideoBusinessContext {
  companyName: string;
  website: string;
  industry: string;
  services: string[];
  productImageUrl?: string;
  primaryColor: string;
  secondaryColor: string;
  presentationSeed: string;
}

interface VideoProviderConfig {
  apiKey: string;
  model: "sora-2" | "sora-2-pro";
  seconds: "4" | "8" | "12";
  size: "720x1280" | "1024x1792";
  timeoutMs: number;
  pollIntervalMs: number;
  useProductReference: boolean;
}

interface VideoJob {
  id: string;
  status: "queued" | "in_progress" | "completed" | "failed";
  progress?: number;
  error?: { message?: string };
}

interface CachedRole {
  role: number;
  promptHash: string;
  gif: string;
  mp4: string;
}

interface CacheManifest {
  provider: "openai";
  model: string;
  roles: CachedRole[];
}

export type AiVideoProgress = (message: string) => void | Promise<void>;

function cleanPromptText(value: string, maxLength = 240): string {
  return value.replace(/\s+/g, " ").replace(/[<>]/g, "").trim().slice(0, maxLength);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function providerConfig(env: NodeJS.ProcessEnv = process.env): VideoProviderConfig | undefined {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return undefined;
  const model = env.OPENAI_VIDEO_MODEL === "sora-2-pro" ? "sora-2-pro" : "sora-2";
  const seconds = (["4", "8", "12"] as const).includes(env.OPENAI_VIDEO_SECONDS as "4" | "8" | "12")
    ? env.OPENAI_VIDEO_SECONDS as "4" | "8" | "12"
    : "4";
  const size = env.OPENAI_VIDEO_SIZE === "1024x1792" ? "1024x1792" : "720x1280";
  const requestedTimeout = Number(env.OPENAI_VIDEO_TIMEOUT_MS ?? "720000");
  return {
    apiKey,
    model,
    seconds,
    size,
    timeoutMs: Number.isFinite(requestedTimeout) ? Math.max(120_000, Math.min(requestedTimeout, 1_800_000)) : 720_000,
    pollIntervalMs: 10_000,
    useProductReference: env.OPENAI_VIDEO_USE_PRODUCT_REFERENCE === "1",
  };
}

function businessScene(industry: string, service: string): string {
  const subject = `${industry} ${service}`.toLocaleLowerCase("ru");
  if (/пицц|ресторан|кафе|доставк.*ед|food/.test(subject)) {
    return "an authentic modern pizzeria with a stone oven and warm practical lighting; the presenter naturally holds a freshly baked pizza on a wooden serving board, with visible realistic toppings and steam";
  }
  if (/медиц|клиник|стомат|аптек|фарма|здоров/.test(subject)) {
    return "a clean contemporary clinic or pharmacy consultation space; the presenter holds a safe non-branded professional product or anatomical teaching model appropriate to the service";
  }
  if (/строит|ремонт|недвиж|архитект/.test(subject)) {
    return "a modern construction or architectural project setting; the presenter wears appropriate clean safety equipment and holds a blueprint or material sample";
  }
  if (/авто|транспорт|логист/.test(subject)) {
    return "a bright modern automotive showroom or logistics facility; the presenter stands beside relevant equipment and holds a tablet showing no readable text";
  }
  if (/финанс|банк|инвест|страх|юрист|право/.test(subject)) {
    return "a premium modern office with subtle financial or legal context; the presenter holds a neutral document folder or tablet with no readable text";
  }
  if (/beauty|космет|салон|мода|fashion|одежд/.test(subject)) {
    return "a refined beauty, fashion or product studio; the presenter naturally demonstrates one relevant non-branded product with elegant shelves in the background";
  }
  if (/технолог|software|saas|digital|автоматизац|интеграц|\bit\b/.test(subject)) {
    return "a contemporary technology studio with softly glowing screens containing only abstract interface shapes; the presenter demonstrates the service on a tablet";
  }
  if (/образован|школ|курс|обучен/.test(subject)) {
    return "a welcoming modern learning studio; the presenter holds a relevant teaching object and gestures toward an abstract board without readable text";
  }
  if (/производ|завод|оборудован/.test(subject)) {
    return "a clean modern production facility relevant to the business; the presenter safely demonstrates a representative material or product sample";
  }
  return `a realistic contemporary workplace directly related to ${cleanPromptText(industry, 100)}; the presenter naturally demonstrates a tangible object or tool connected with ${cleanPromptText(service, 100)}`;
}

const ROLE_DIRECTIONS = [
  "brand guide introducing the main product and making friendly direct eye contact",
  "hands-on presenter demonstrating how the product or service is used",
  "expert consultant answering a common customer question and inviting the next step",
] as const;

const PERSON_VARIANTS = [
  "a confident woman in her early thirties with natural features and dark shoulder-length hair",
  "a friendly man in his late thirties with natural features and short dark hair",
  "a confident woman in her forties with natural features and softly styled brown hair",
  "a friendly man in his early thirties with natural features and short curly hair",
  "a confident woman in her late twenties with natural features and long dark hair",
  "a friendly man in his forties with natural features and salt-and-pepper hair",
] as const;

export function buildAiVideoPrompt(context: AiVideoBusinessContext, role: number): string {
  const service = cleanPromptText(context.services[role] ?? context.services[0] ?? context.industry, 120);
  const variant = Number.parseInt(hash(`${context.presentationSeed}|${role}`).slice(0, 8), 16) % PERSON_VARIANTS.length;
  const person = PERSON_VARIANTS[variant]!;
  return [
    "Create a photorealistic vertical talking-head marketing video for a business presentation.",
    `Business: ${cleanPromptText(context.companyName, 100)}. Industry: ${cleanPromptText(context.industry, 140)}. Featured direction: ${service}.`,
    `Scene: ${businessScene(context.industry, service)}.`,
    `Presenter: ${person}, acting as a ${ROLE_DIRECTIONS[role] ?? ROLE_DIRECTIONS[0]}.`,
    `Wardrobe and set accents use ${context.primaryColor} and ${context.secondaryColor}, while skin tone and product colours remain natural.`,
    "Medium shot, realistic hands and object interaction, subtle speaking mouth movement, natural blinking and small gestures, stationary camera, soft cinematic commercial lighting, believable textures.",
    "The final pose should visually connect to the opening pose for a smooth short loop.",
    "No captions, no readable text, no logos, no watermark, no distorted hands, no duplicate objects, no camera cuts, no famous or identifiable real person.",
  ].join(" ");
}

async function apiJson<T>(url: string, apiKey: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(45_000),
  });
  const body = await response.text();
  if (!response.ok) {
    let message = body.slice(0, 500);
    try { message = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? message; } catch {}
    throw new Error(`OpenAI Videos API: HTTP ${response.status}: ${message}`);
  }
  return JSON.parse(body) as T;
}

async function createVideoJob(
  config: VideoProviderConfig,
  prompt: string,
  reference?: { body: Uint8Array; contentType: string },
): Promise<VideoJob> {
  const form = new FormData();
  form.set("model", config.model);
  form.set("prompt", prompt);
  form.set("seconds", config.seconds);
  form.set("size", config.size);
  if (reference) {
    form.set("input_reference", new Blob([Buffer.from(reference.body)], { type: reference.contentType }), "site-product-reference");
  }
  return apiJson<VideoJob>(OPENAI_VIDEO_ENDPOINT, config.apiKey, { method: "POST", body: form });
}

async function waitForVideo(config: VideoProviderConfig, job: VideoJob, progress?: AiVideoProgress): Promise<VideoJob> {
  const deadline = Date.now() + config.timeoutMs;
  let current = job;
  while (Date.now() < deadline) {
    if (current.status === "completed") return current;
    if (current.status === "failed") throw new Error(current.error?.message ?? "AI-video generation failed");
    await progress?.(`AI-video ${current.progress ?? 0}%`);
    await delay(config.pollIntervalMs);
    current = await apiJson<VideoJob>(`${OPENAI_VIDEO_ENDPOINT}/${encodeURIComponent(current.id)}`, config.apiKey);
  }
  throw new Error("AI-video generation timeout");
}

async function downloadVideo(config: VideoProviderConfig, id: string): Promise<Uint8Array> {
  const response = await fetch(`${OPENAI_VIDEO_ENDPOINT}/${encodeURIComponent(id)}/content`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`OpenAI video download: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_VIDEO_BYTES) throw new Error("AI-video exceeds the allowed size");
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_VIDEO_BYTES) throw new Error("AI-video exceeds the allowed size");
  return body;
}

async function runFfmpeg(inputPath: string, outputPath: string, seconds: string): Promise<void> {
  const clip = Math.max(3.2, Math.min(Number(seconds) - .2, 4.8)).toFixed(1);
  const filter = "[0:v]fps=5,scale=256:454:force_original_aspect_ratio=increase:flags=lanczos,crop=256:454,split[s0][s1];[s0]palettegen=max_colors=192:stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH?.trim() || ffmpegInstaller.path, [
      "-hide_banner", "-loglevel", "warning", "-ss", "0.15", "-t", clip,
      "-i", inputPath, "-filter_complex", filter, "-loop", "0", "-y", outputPath,
    ], { windowsHide: true });
    let errorText = "";
    child.stderr.on("data", chunk => { if (errorText.length < 4000) errorText += String(chunk); });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`FFmpeg exited with ${code}: ${errorText.slice(-1000)}`)));
  });
}

async function prepareProductReference(inputUrl: string, mediaDir: string, size: string): Promise<{
  body: Uint8Array;
  contentType: string;
}> {
  const image = await fetchPublicImage(inputUrl);
  const inputPath = path.join(mediaDir, "product-reference-source");
  const outputPath = path.join(mediaDir, `product-reference-${size}.png`);
  await writeFile(inputPath, image.body);
  const [width, height] = size.split("x").map(Number) as [number, number];
  const filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=white`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH?.trim() || ffmpegInstaller.path, [
      "-hide_banner", "-loglevel", "warning", "-i", inputPath,
      "-vf", filter, "-frames:v", "1", "-y", outputPath,
    ], { windowsHide: true });
    let errorText = "";
    child.stderr.on("data", chunk => { if (errorText.length < 4000) errorText += String(chunk); });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`FFmpeg image conversion exited with ${code}: ${errorText.slice(-1000)}`)));
  });
  return { body: new Uint8Array(await readFile(outputPath)), contentType: "image/png" };
}

async function fileExists(filePath: string): Promise<boolean> {
  try { return (await stat(filePath)).isFile(); } catch { return false; }
}

async function readManifest(filePath: string): Promise<CacheManifest | undefined> {
  try { return JSON.parse(await readFile(filePath, "utf8")) as CacheManifest; } catch { return undefined; }
}

async function gifDataUri(filePath: string): Promise<string> {
  return `data:image/gif;base64,${(await readFile(filePath)).toString("base64")}`;
}

/**
 * Создаёт и кэширует три полноценных AI-видео для одной презентации.
 * При отсутствии OPENAI_API_KEY возвращает undefined, чтобы презентация
 * использовала автономные реалистичные GIF без сетевой ошибки.
 */
export async function generateBusinessAiVideoGifs(
  context: AiVideoBusinessContext,
  presentationDir: string,
  progress?: AiVideoProgress,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[] | undefined> {
  const config = providerConfig(env);
  if (!config) return undefined;
  const mediaDir = path.join(presentationDir, "ai-video");
  const manifestPath = path.join(mediaDir, "manifest.json");
  await mkdir(mediaDir, { recursive: true });
  const prompts = Array.from({ length: 3 }, (_, role) => buildAiVideoPrompt(context, role));
  const referenceKey = config.useProductReference ? context.productImageUrl ?? "" : "";
  const promptHashes = prompts.map(prompt => hash(`${config.model}|${config.seconds}|${config.size}|${referenceKey}|${prompt}`));
  const manifest = await readManifest(manifestPath);
  const cached = await Promise.all(promptHashes.map(async (promptHash, role) => {
    const item = manifest?.roles.find(entry => entry.role === role && entry.promptHash === promptHash);
    if (!item) return undefined;
    const gifPath = path.join(mediaDir, item.gif);
    return await fileExists(gifPath) ? gifDataUri(gifPath) : undefined;
  }));
  if (cached.every((value): value is string => Boolean(value))) {
    await progress?.("Использую сохранённые AI-видео презентации");
    return cached;
  }

  let reference: { body: Uint8Array; contentType: string } | undefined;
  if (config.useProductReference && context.productImageUrl) {
    try {
      reference = await prepareProductReference(context.productImageUrl, mediaDir, config.size);
    } catch { /* текстовый prompt остаётся достаточным */ }
  }

  const settledRoles = await Promise.allSettled(prompts.map(async (prompt, role): Promise<CachedRole> => {
    const gifName = `role-${role + 1}.gif`;
    const mp4Name = `role-${role + 1}.mp4`;
    const gifPath = path.join(mediaDir, gifName);
    const mp4Path = path.join(mediaDir, mp4Name);
    const matching = manifest?.roles.find(item => item.role === role && item.promptHash === promptHashes[role]);
    if (matching && await fileExists(gifPath) && await fileExists(mp4Path)) return matching;
    await progress?.(`Создаю AI-видео ${role + 1}/3 для сферы «${cleanPromptText(context.industry, 80)}»`);
    let job: VideoJob;
    try {
      job = await createVideoJob(config, prompt, reference);
    } catch (error) {
      if (!reference) throw error;
      await progress?.(`Роль ${role + 1}/3 · продуктовый референс отклонён, повторяю по описанию сайта`);
      job = await createVideoJob(config, prompt);
    }
    const completed = await waitForVideo(config, job, message => progress?.(`Роль ${role + 1}/3 · ${message}`));
    const video = await downloadVideo(config, completed.id);
    await writeFile(mp4Path, video);
    await runFfmpeg(mp4Path, gifPath, config.seconds);
    return { role, promptHash: promptHashes[role]!, gif: gifName, mp4: mp4Name };
  }));
  const roles = settledRoles
    .filter((result): result is PromiseFulfilledResult<CachedRole> => result.status === "fulfilled")
    .map(result => result.value)
    .sort((first, second) => first.role - second.role);
  const nextManifest: CacheManifest = { provider: "openai", model: config.model, roles };
  await writeFile(manifestPath, JSON.stringify(nextManifest, null, 2), "utf8");
  if (roles.length !== 3) {
    const failures = settledRoles
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(result => result.reason instanceof Error ? result.reason.message : String(result.reason));
    throw new Error(`Не удалось создать все три AI-видео: ${failures.join("; ").slice(0, 800)}`);
  }
  return Promise.all(roles.map(role => gifDataUri(path.join(mediaDir, role.gif))));
}
