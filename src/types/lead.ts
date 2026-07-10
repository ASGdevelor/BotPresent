export interface LeadCriteria {
  /** Описание целевой аудитории и её потребности. */
  whoCanBuy: string;
  /** Тип компаний, которые нужно найти. */
  whoToFind: string;
  /** География, отраслевой каталог или конкретные сайты. */
  whereToSearch: string;
  /** Предлагаемая услуга или решение. */
  offer: string;
  /** Компании, которые необходимо исключить. */
  exclusions: string;
}

export type LeadField = keyof LeadCriteria;

export type ContactRole =
  | "director"
  | "sales"
  | "manager"
  | "employee"
  | "company"
  | "unknown";

export interface TelegramContact {
  handle: string;
  url: string;
  role: ContactRole;
  label?: string;
  sourceUrl?: string;
}

export interface CompanyLead {
  companyName: string;
  siteName: string;
  website: string;
  description: string;
  relevance: string;
  telegramContacts: TelegramContact[];
}

export interface LeadGenerationResult {
  criteria: LeadCriteria;
  leads: CompanyLead[];
  analyzedSites: number;
  warnings: string[];
}
