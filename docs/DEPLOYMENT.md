# Развёртывание

## Bun на сервере

1. Установите Bun версии 1.2 или новее.
2. Склонируйте репозиторий и выполните `bun install --frozen-lockfile`.
3. Создайте `.env` с переменной `BOT_TOKEN`.
4. Запустите `bun run start` под менеджером процессов (systemd, Supervisor или PM2).

Для генерации PDF установите Microsoft Edge или Google Chrome. Без поддерживаемого браузера бот продолжит создавать и отправлять HTML-версию презентации.

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

Процесс должен иметь право записи в `./data`: там сохраняются история и созданные презентации. В дистрибутив входит базовый шаблон `TestSite/Generic`; при локальной разработке может использоваться соседний `../TestSite/Generic`. Резервное копирование и удаление данных выполняются владельцем сервера согласно его политике.

Бот использует long polling, поэтому домен, HTTPS и открытый входящий порт не нужны. Для лидогенерации серверу требуется исходящий HTTPS-доступ к Telegram API, поисковой выдаче Bing и DuckDuckGo, а также анализируемым публичным сайтам.

## Обновление

```bash
git pull --ff-only
bun install --frozen-lockfile
bun run check
sudo systemctl restart bot-present
```
