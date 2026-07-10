import { mkdirSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

export type MessageDirection = "user" | "bot" | "system";

export interface HistoryMessage {
  id: number;
  chatId: number;
  userId: number;
  direction: MessageDirection;
  text: string;
  createdAt: Date;
}
interface HistoryRow {
  id: number;
  chat_id: string;
  user_id: string;
  direction: MessageDirection;
  text: string;
  created_at: number;
}

export interface MessageHistoryOptions {
  maxMessagesPerUser?: number;
  retentionDays?: number;
}

export class MessageHistory {
  private readonly database: Database;
  private readonly maxMessagesPerUser: number;
  private readonly retentionMs: number;

  constructor(
    databasePath = process.env.HISTORY_DB_PATH?.trim() || "./data/bot-history.sqlite",
    options: MessageHistoryOptions = {},
  ) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    }

    this.maxMessagesPerUser = options.maxMessagesPerUser ?? 200;
    this.retentionMs = (options.retentionDays ?? 90) * 24 * 60 * 60 * 1_000;
    this.database = new Database(databasePath, { create: true, strict: true });
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS message_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('user', 'bot', 'system')),
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_message_history_user
        ON message_history (chat_id, user_id, created_at DESC);
    `);
  }

  record(
    chatId: number,
    userId: number,
    direction: MessageDirection,
    text: string,
    createdAt = new Date(),
  ): void {
    const normalized = text.replace(/\0/g, "").trim().slice(0, 4_000);
    if (!normalized) return;

    const transaction = this.database.transaction(() => {
      this.database.query(`
        INSERT INTO message_history (chat_id, user_id, direction, text, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
      `).run(String(chatId), String(userId), direction, normalized, createdAt.getTime());

      this.database.query("DELETE FROM message_history WHERE created_at < ?1")
        .run(Date.now() - this.retentionMs);

      this.database.query(`
        DELETE FROM message_history
        WHERE chat_id = ?1 AND user_id = ?2
          AND id NOT IN (
            SELECT id FROM message_history
            WHERE chat_id = ?1 AND user_id = ?2
            ORDER BY created_at DESC, id DESC
            LIMIT ?3
          )
      `).run(String(chatId), String(userId), this.maxMessagesPerUser);
    });

    transaction();
  }

  list(chatId: number, userId: number, limit = 100): HistoryMessage[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), this.maxMessagesPerUser);
    const rows = this.database.query(`
      SELECT id, chat_id, user_id, direction, text, created_at
      FROM message_history
      WHERE chat_id = ?1 AND user_id = ?2
      ORDER BY created_at DESC, id DESC
      LIMIT ?3
    `).all(String(chatId), String(userId), safeLimit) as HistoryRow[];

    return rows.reverse().map((row) => ({
      id: row.id,
      chatId: Number(row.chat_id),
      userId: Number(row.user_id),
      direction: row.direction,
      text: row.text,
      createdAt: new Date(row.created_at),
    }));
  }

  clear(chatId: number, userId: number): number {
    const result = this.database.query(`
      DELETE FROM message_history WHERE chat_id = ?1 AND user_id = ?2
    `).run(String(chatId), String(userId));
    return result.changes;
  }

  close(): void {
    this.database.close(false);
  }
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function formatHistoryReport(messages: HistoryMessage[]): string {
  if (messages.length === 0) {
    return "# История сообщений\n\nИстория пока пуста.\n";
  }

  const directionLabels: Record<MessageDirection, string> = {
    user: "Пользователь",
    bot: "Бот",
    system: "Система",
  };
  const formatter = new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "Europe/Moscow",
  });

  return [
    "# История сообщений",
    "",
    `Записей: ${messages.length}`,
    "",
    ...messages.map((message) => (
      `- **${formatter.format(message.createdAt)} · ${directionLabels[message.direction]}:** ${singleLine(message.text)}`
    )),
    "",
  ].join("\n");
}
