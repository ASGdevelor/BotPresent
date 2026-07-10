export const BUTTONS = {
  presentation: "📊 Создать презентацию",
  research: "🔎 Провести исследование",
} as const;

export type Action = keyof typeof BUTTONS;

export const MENU_TEXT = [
  "Привет! Я помогу быстро подготовить материалы по вашей теме.",
  "",
  "Выберите действие с помощью кнопок ниже.",
].join("\n");

