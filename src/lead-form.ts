import type { LeadCriteria, LeadField } from "./types/lead";

export const LEAD_FIELDS = [
  "whoCanBuy",
  "whoToFind",
  "whereToSearch",
  "offer",
  "exclusions",
] as const satisfies readonly LeadField[];

export const LEAD_PROMPTS: Record<LeadField, string> = {
  whoCanBuy: "1/5. Кому можно продать услуги?\nТочно: тип клиента + размер + потребность.\nПример: сети частных стоматологий от 3 филиалов, которым нужен поток пациентов.",
  whoToFind: "2/5. Кого ищем?\nУкажите сферу и при необходимости специализацию. Поиск охватит разные формулировки названий компаний в этой сфере.\nПример: аптечные сети и самостоятельные аптеки.",
  whereToSearch: "3/5. Где искать?\nОбязательно укажите страну, затем при необходимости город/область. Google просматривается в глубину, а сайты проверяются по географии и национальному домену (например, .ru, .by, .kz).\nПример: Россия или Россия, Москва и Московская область.",
  offer: "4/5. Что предложить?\nУкажите услугу, пользу и задачу, которую она решает.\nПример: AI-видеоконтент для соцсетей, чтобы увеличить число записей на консультацию.",
  exclusions: "5/5. Кого не брать?\nПеречислите через запятую типы компаний, агрегаторы и бренды-конкуренты или отправьте «нет».",
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
