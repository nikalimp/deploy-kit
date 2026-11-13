#!/usr/bin/env node
// @nikitos-shared queue-publish.mjs
// Очередь публикации контент-завода: по будням GitHub Actions (deploy-kit/.github/workflows/queue.yml) берёт из плана
// строки со статусом ready и датой <= сегодня (часовой пояс проекта), переносит черновик в блог и ставит published.
// Статьи пишет субботняя задача «Неделя — все проекты» (content-factory:weekly); Claude по будням не нужен.
//
//   node queue-publish.mjs <content.config.json> [--max 2] [--date YYYY-MM-DD] [--dry]
// Печатает JSON {published:[{slug,title,date,article}], skipped:[…]}; в GITHUB_OUTPUT — published=true|false, titles.
// Без зависимостей. Формат плана — как у content-kit/plan.py: таблица между <!-- plan:start --> и <!-- plan:end -->.

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, appendFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

const a = process.argv.slice(2);
const cfgPath = a.find((x) => !x.startsWith("--"));
const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
const MAX = Number(opt("--max", 2));
const DRY = a.includes("--dry");
const out = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);

if (!cfgPath || !existsSync(cfgPath)) {
  console.log(JSON.stringify({ published: [], skipped: [], note: `нет конфига ${cfgPath || ""} — у проекта нет контент-завода` }));
  out("published", "false");
  process.exit(0);
}
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const root = resolve(dirname(cfgPath), cfg.root || "../..");
const P = (k, slug) => join(root, String(cfg.paths?.[k] || "").replace("{slug}", slug));
const today = opt("--date", new Intl.DateTimeFormat("en-CA", { timeZone: cfg.timezone || "Europe/Moscow" }).format(new Date()));

const planFile = P("plan", "");
const txt = readFileSync(planFile, "utf8");
const m = txt.match(/<!-- plan:start -->\n([\s\S]*?)\n?<!-- plan:end -->/);
if (!m) throw new Error(`Нет маркеров plan:start/plan:end в ${planFile}`);
const split = (l) => l.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim());
const lines = m[1].split("\n");
const tableIdx = lines.map((l, i) => (l.trim().startsWith("|") ? i : -1)).filter((i) => i >= 0);
const head = split(lines[tableIdx[0]]);
const col = (name) => head.indexOf(name);
const [cDate, cStatus, cSlug, cTitle] = ["Дата", "Статус", "slug", "Тема (H1)"].map(col);
if ([cDate, cStatus, cSlug].some((i) => i < 0)) throw new Error("В шапке плана нет колонок Дата, Статус или slug");

// Защита от двойного выпуска: сколько уже вышло сегодня
const rows = tableIdx.slice(2).map((i) => ({ i, cells: split(lines[i]) }));
const due = rows
  .filter((r) => r.cells[cStatus] === "ready" && r.cells[cDate] && r.cells[cDate] <= today)
  .sort((x, y) => x.cells[cDate].localeCompare(y.cells[cDate]))
  .slice(0, MAX);

const published = [], skipped = [];
for (const r of due) {
  const slug = r.cells[cSlug], date = r.cells[cDate], title = (r.cells[cTitle] || slug).replace(/\\\|/g, "|");
  const draft = P("drafts", slug), article = P("article", slug);
  if (existsSync(article) && !existsSync(draft)) { skipped.push({ slug, why: "статья уже в блоге — только статус" }); }
  else if (!existsSync(draft)) { skipped.push({ slug, why: `нет черновика ${draft.replace(root + "/", "")}` }); continue; }
  else if (!DRY) {
    let body = readFileSync(draft, "utf8");
    // дата выхода — из плана (пропущенный день выходит своей датой)
    body = body.replace(/^(---\n[\s\S]*?^date:\s*)["']?[0-9-]+["']?/m, `$1${date}`);
    mkdirSync(dirname(article), { recursive: true });
    writeFileSync(article, body);
    unlinkSync(draft);
  }
  r.cells[cStatus] = "published";
  lines[r.i] = "| " + r.cells.join(" | ") + " |";
  published.push({ slug, title, date, article: article.replace(root + "/", "") });
}

if (!DRY && published.length) {
  const g0 = m.index + "<!-- plan:start -->\n".length;
  writeFileSync(planFile, txt.slice(0, g0) + lines.join("\n") + txt.slice(g0 + m[1].length));
}

console.log(JSON.stringify({ today, published, skipped }, null, 1));
for (const s of skipped) console.log(`::warning::Очередь: ${s.slug} — ${s.why}`);
for (const p of published) console.log(`::notice::Очередь: выходит «${p.title}» (${p.date})`);
out("published", published.length ? "true" : "false");
out("titles", published.map((p) => p.title).join(" · ").replace(/\n/g, " "));
