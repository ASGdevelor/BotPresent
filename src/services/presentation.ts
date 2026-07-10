import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import pptxgen from "pptxgenjs";
import { safeFilePart } from "../utils";

const NAVY = "132238";
const BLUE = "2563EB";
const CYAN = "38BDF8";
const LIGHT = "F8FAFC";
const SLATE = "475569";

interface SlideContent {
  title: string;
  points: string[];
}

export interface PresentationFile {
  path: string;
  name: string;
}

function addHeader(slide: pptxgen.Slide, title: string, number: number): void {
  slide.background = { color: LIGHT };
  slide.addShape("rect", { x: 0, y: 0, w: 0.16, h: 7.5, fill: { color: BLUE }, line: { color: BLUE } });
  slide.addText(title, {
    x: 0.72,
    y: 0.62,
    w: 11.7,
    h: 0.6,
    fontFace: "Aptos Display",
    fontSize: 28,
    bold: true,
    color: NAVY,
    margin: 0,
  });
  slide.addText(String(number).padStart(2, "0"), {
    x: 11.85,
    y: 6.9,
    w: 0.7,
    h: 0.3,
    fontSize: 10,
    color: SLATE,
    align: "right",
    margin: 0,
  });
}

function addContentSlide(pptx: pptxgen, content: SlideContent, number: number): void {
  const slide = pptx.addSlide();
  addHeader(slide, content.title, number);

  content.points.forEach((point, index) => {
    const y = 1.65 + index * 1.15;
    slide.addShape("ellipse", {
      x: 0.8,
      y: y + 0.04,
      w: 0.34,
      h: 0.34,
      fill: { color: index === 0 ? CYAN : BLUE },
      line: { color: index === 0 ? CYAN : BLUE },
    });
    slide.addText(point, {
      x: 1.4,
      y,
      w: 10.8,
      h: 0.7,
      fontFace: "Aptos",
      fontSize: 21,
      color: NAVY,
      breakLine: false,
      margin: 0,
      valign: "middle",
    });
  });
}

export async function createPresentation(topic: string): Promise<PresentationFile> {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "BotPresent";
  pptx.subject = topic;
  pptx.title = topic;
  pptx.company = "BotPresent";
  pptx.theme = {
    headFontFace: "Aptos Display",
    bodyFontFace: "Aptos",
  };

  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: NAVY };
  titleSlide.addShape("rect", {
    x: 0,
    y: 0,
    w: 13.333,
    h: 0.16,
    fill: { color: CYAN },
    line: { color: CYAN },
  });
  titleSlide.addText(topic, {
    x: 0.85,
    y: 2.1,
    w: 11.65,
    h: 1.65,
    fontFace: "Aptos Display",
    fontSize: 32,
    bold: true,
    color: "FFFFFF",
    margin: 0,
    valign: "middle",
    fit: "shrink",
  });
  titleSlide.addText("Краткая презентация · создано BotPresent", {
    x: 0.88,
    y: 4.2,
    w: 8,
    h: 0.35,
    fontFace: "Aptos",
    fontSize: 14,
    color: "CBD5E1",
    margin: 0,
  });

  const slides: SlideContent[] = [
    {
      title: "Контекст и актуальность",
      points: [
        `Что важно знать о теме «${topic}»`,
        "Почему тема заслуживает внимания сейчас",
        "Для кого особенно важны результаты",
      ],
    },
    {
      title: "Ключевые аспекты",
      points: [
        "Основные понятия и участники",
        "Факторы, которые влияют на результат",
        "Связи между причиной, действием и эффектом",
      ],
    },
    {
      title: "Возможности и ограничения",
      points: [
        "Практическая ценность и ожидаемые преимущества",
        "Риски, ограничения и спорные вопросы",
        "Условия успешного применения",
      ],
    },
    {
      title: "План действий",
      points: [
        "Определить цель и критерии успеха",
        "Собрать данные и проверить гипотезы",
        "Запустить пилот и оценить результат",
      ],
    },
    {
      title: "Выводы",
      points: [
        `Тема «${topic}» требует предметной проверки`,
        "Решения стоит принимать на основе данных",
        "Следующий шаг — адаптировать структуру под аудиторию",
      ],
    },
  ];

  slides.forEach((slide, index) => addContentSlide(pptx, slide, index + 2));

  const outputDir = path.join(process.cwd(), "tmp");
  await mkdir(outputDir, { recursive: true });
  const fileName = `${safeFilePart(topic)}-${randomUUID().slice(0, 8)}.pptx`;
  const filePath = path.join(outputDir, fileName);
  await pptx.writeFile({ fileName: filePath, compression: true });

  return { path: filePath, name: `${safeFilePart(topic)}.pptx` };
}
