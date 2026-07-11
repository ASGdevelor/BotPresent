# Repository Guidelines

## Project Structure & Module Organization

This is a Bun + TypeScript Telegram bot. Application code is in `src/`: `bot.ts` routes Telegram updates, `lead-form.ts` manages the questionnaire, and `src/services/` contains lead generation, public-web fetching, presentation rendering, and message history. Shared domain types are in `src/types/`. Unit tests live in `tests/` and mirror the service/module names. `TestSite/Generic/index.html` is the bundled presentation template; generated presentations are stored under `data/presentations/` and are ignored by Git. Operational and user documentation is in `docs/`.

## Build, Test, and Development Commands

Run these commands from the repository root:

```bash
bun install          # install locked dependencies
bun run start        # start the bot
bun run dev          # start with Bun watch mode
bun run typecheck    # run TypeScript without emitting files
bun test             # run the Bun test suite
bun run check        # typecheck followed by all tests
```

Set `BOT_TOKEN` in `.env` (or use the documented legacy `TOKEN` variable) before starting the bot.

## Coding Style & Naming Conventions

Use TypeScript with ES modules, two-space indentation, semicolons, and explicit types for exported APIs. Prefer `camelCase` for variables/functions, `PascalCase` for classes and interfaces, and `UPPER_SNAKE_CASE` for constants. Keep network access behind `src/services/public-web.ts`; preserve its URL validation and SSRF protections. Escape untrusted values before inserting them into generated HTML.

## Testing Guidelines

Tests use Bun's built-in runner and `describe`/`test` assertions. Name files `*.test.ts` and group cases by feature (for example, `tests/lead-generation.test.ts`). Add regression coverage for parser, URL-safety, rendering, and error-handling changes. Run `bun run check` before opening a pull request.

## Commit & Pull Request Guidelines

Existing history uses short Conventional Commit-style subjects such as `feat: ...` and `docs: ...`; keep messages imperative, focused, and under roughly 72 characters. Pull requests should explain the user-visible behavior, identify affected modules, list validation commands, and call out configuration or security implications. Include screenshots or sample generated output when changing Telegram messages or presentation templates. Do not commit `.env`, tokens, SQLite files, or generated presentation data.

## Security & Configuration Tips

Never place bot tokens or credentials in source control. Public-site fetching must remain limited to `http`/`https` and retain private-network, redirect, timeout, and content-size checks. Treat scraped contacts and generated presentations as untrusted output requiring review before external use.
