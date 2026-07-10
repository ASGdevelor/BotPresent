# Развёртывание

## Вариант 1: Bun на сервере

1. Установите Bun версии 1.2 или новее.
2. Склонируйте репозиторий и выполните `bun install --frozen-lockfile`.
3. Создайте `.env` с переменной `BOT_TOKEN`.
4. Запустите `bun run start` под менеджером процессов (systemd, Supervisor или PM2).

Пример unit-файла systemd:

```ini
[Unit]
Description=BotPresent Telegram bot
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/bot-present
EnvironmentFile=/opt/bot-present/.env
ExecStart=/home/bot/.bun/bin/bun run start
Restart=always
RestartSec=5
User=bot

[Install]
WantedBy=multi-user.target
```

После сохранения файла:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bot-present
sudo systemctl status bot-present
```

## Вариант 2: Docker Compose

Создайте `.env`, затем выполните:

```bash
docker compose up -d --build
docker compose logs -f
```

Каталог `./data` подключается в контейнер как volume и хранит SQLite-историю между перезапусками. Для запуска без Docker убедитесь, что процесс может записывать в путь `HISTORY_DB_PATH` (по умолчанию `./data/bot-history.sqlite`). Резервное копирование и удаление базы выполняются владельцем сервера согласно его политике данных.

Бот использует long polling, поэтому домен, HTTPS и открытый входящий порт не нужны. Для лидогенерации серверу требуется исходящий HTTPS-доступ к Telegram API, поисковой выдаче Bing и анализируемым публичным сайтам.

## Обновление

```bash
git pull --ff-only
bun install --frozen-lockfile
bun run check
sudo systemctl restart bot-present
```
