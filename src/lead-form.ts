import type { LeadCriteria, LeadField } from "./types/lead";

export const LEAD_FIELDS = [
  "whoCanBuy",
  "whoToFind",
  "whereToSearch",
  "offer",
  "exclusions",
] as const satisfies readonly LeadField[];

export const LEAD_PROMPTS: Record<LeadField, string> = {
  whoCanBuy: "1/5. Кому можно продать услуги? Опишите целевую аудиторию и её потребность.",
  whoToFind: "2/5. Кого ищем? Укажите тип, отрасль или размер компаний.",
  whereToSearch: "3/5. Где искать? Укажите географию, каталог или конкретные сайты/домены.",
  offer: "4/5. Что предложить? Кратко опишите услугу и её пользу.",
  exclusions: "5/5. Кого не брать? Перечислите исключения через запятую или отправьте «нет».",
};

export function normalizeLeadAnswer(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

export function nextLeadField(current: LeadField): LeadField | undefined {
  const index = LEAD_FIELDS.indexOf(current);
  return LEAD_FIELDS[index + 1];
}

export function isCompleteLeadCriteria(value: Partial<LeadCriteria>): value is LeadCriteria {
  return LEAD_FIELDS.every((field) => typeof value[field] === "string" && value[field].length > 0);
}

