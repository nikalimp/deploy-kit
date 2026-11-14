#!/usr/bin/env node
// @nikitos-shared yandex-report.mjs
// Еженедельная выгрузка Яндекс Вебмастера и Метрики → <REPORTS_DIR>/yandex/YYYY-MM-DD.json.
// Запускает deploy-kit/.github/workflows/data.yml вместе с Search Console. Без зависимостей.
// Лиды — цели Метрики (lead, quiz_done, audit и т. п.): только числа, без имён и телефонов.
//
// Секрет YANDEX_OAUTH_TOKEN — OAuth-токен приложения «NikitOS — отчёты сайтов» (oauth.yandex.ru,
// права webmaster:hostinfo и metrika:read). Токен живёт год: получить заново по ссылке
// https://oauth.yandex.ru/authorize?response_type=token&client_id=8972e869e8554d7fa140f2a77f4cce60
// SITE_URL — адрес сайта, REPORTS_DIR — папка отчётов (по умолчанию specs/reports).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HOST = (process.env.SITE_URL || process.env.YANDEX_HOST || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
const REPORTS = process.env.REPORTS_DIR || "specs/reports";
const TOKEN = process.env.YANDEX_OAUTH_TOKEN;
const WM = "https://api.webmaster.yandex.net/v4";
const MT = "https://api-metrika.yandex.net";
// Домены нейросетей — для сегмента «переходы из ИИ»
const AI = ["chatgpt.com", "chat.openai.com", "perplexity.ai", "alice.yandex.ru", "ya.ru", "giga.chat", "gigachat", "chat.deepseek.com", "gemini.google.com", "claude.ai", "copilot.microsoft.com"];

const day = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

async function get(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { Authorization: `OAuth ${TOKEN}` } });
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 2000 * (i + 1))); continue; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${r.status} ${url.split("?")[0]}: ${JSON.stringify(d).slice(0, 300)}`);
    return d;
  }
  throw new Error(`Не ответил ${url.split("?")[0]}`);
}
const safe = (p) => p.catch((e) => ({ error: String(e.message).slice(0, 400) }));
const qs = (o) => Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}=${encodeURIComponent(x)}`)).join("&");

async function webmaster(from, to) {
  const { user_id } = await get(`${WM}/user`);
  const hosts = (await get(`${WM}/user/${user_id}/hosts`)).hosts ?? [];
  // У сайта бывает несколько записей (http/https, www) — берём ту, по которой Вебмастер уже собрал данные
  const cands = hosts.filter((h) => new URL(h.ascii_host_url).hostname.replace(/^www\./, "") === HOST)
    .sort((a, b) => Number(b.ascii_host_url.startsWith("https")) - Number(a.ascii_host_url.startsWith("https")) || Number(b.verified) - Number(a.verified));
  if (!cands.length) return { error: `Сайт ${HOST} не добавлен в Вебмастер этого аккаунта. Есть: ${hosts.map((h) => h.ascii_host_url).join(", ") || "нет"}` };
  let host = cands[0], first = null;
  for (const h of cands) {
    const r = await safe(get(`${WM}/user/${user_id}/hosts/${encodeURIComponent(h.host_id)}/summary`));
    if (!r.error) { host = h; first = r; break; }
    first ??= r;
  }
  const base = `${WM}/user/${user_id}/hosts/${encodeURIComponent(host.host_id)}`;
  const ind = ["TOTAL_SHOWS", "TOTAL_CLICKS", "AVG_SHOW_POSITION", "AVG_CLICK_POSITION"];
  const [summary, queries, history, indexing, inSearch, sitemaps, diagnostics] = await Promise.all([
    Promise.resolve(first),
    safe(get(`${base}/search-queries/popular?${qs({ order_by: "TOTAL_SHOWS", query_indicator: ind, date_from: from, date_to: to, limit: 500 })}`)),
    safe(get(`${base}/search-queries/all/history?${qs({ query_indicator: ["TOTAL_SHOWS", "TOTAL_CLICKS"], date_from: from, date_to: to })}`)),
    safe(get(`${base}/indexing/history?${qs({ date_from: from, date_to: to })}`)),
    safe(get(`${base}/search-urls/in-search/history?${qs({ date_from: from, date_to: to })}`)),
    safe(get(`${base}/sitemaps`)),
    safe(get(`${base}/diagnostics`)),
  ]);
  // Нет ни одного sitemap — добавляем адрес из robots.txt (право webmaster:verify у приложения есть)
  let sitemapAdded = null;
  if (!sitemaps.error && !(sitemaps.sitemaps ?? []).length) {
    const robots = await fetch(`https://${HOST}/robots.txt`).then((r) => r.text()).catch(() => "");
    const url = robots.match(/^\s*sitemap:\s*(\S+)/im)?.[1] || `https://${HOST}/sitemap.xml`;
    const r = await fetch(`${base}/user-added-sitemaps`, { method: "POST", headers: { Authorization: `OAuth ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    sitemapAdded = { url, status: r.status, body: (await r.text()).slice(0, 200) };
    console.log(r.ok ? `::notice::Вебмастер: добавлен sitemap ${url}` : `::warning::Вебмастер: не удалось добавить sitemap ${url} — ${r.status}`);
  }
  return { host: host.ascii_host_url, sitemapAdded, verified: host.verified, candidates: cands.map((h) => `${h.ascii_host_url} verified=${h.verified}`), summary, queries, history, indexing, inSearch, sitemaps, diagnostics };
}

async function metrika(from, to) {
  const counters = (await get(`${MT}/management/v1/counters?per_page=1000`)).counters ?? [];
  const c = counters.find((x) => String(x.site ?? "").replace(/^www\./, "").startsWith(HOST)) ?? counters.find((x) => (x.site2?.site ?? "").includes(HOST));
  if (!c) return { error: `Счётчик для ${HOST} не найден. Есть: ${counters.map((x) => `${x.id} ${x.site}`).join(", ") || "нет"}` };
  const stat = (o) => safe(get(`${MT}/stat/v1/data?${qs({ ids: c.id, date1: from, date2: to, accuracy: "full", limit: 100, ...o })}`)
    .then((d) => ({ totals: d.totals, rows: (d.data ?? []).map((r) => ({ key: r.dimensions.map((x) => x.name ?? x.id).join(" | "), values: r.metrics })) })));
  const m = "ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:avgVisitDurationSeconds";
  const [sources, referers, landing, daily, goalsAny] = await Promise.all([
    stat({ metrics: m, dimensions: "ym:s:lastTrafficSource" }),
    stat({ metrics: m, dimensions: "ym:s:refererDomain", limit: 200 }),
    stat({ metrics: m, dimensions: "ym:s:startURLPath", limit: 100 }),
    stat({ metrics: "ym:s:visits,ym:s:users", dimensions: "ym:s:date", sort: "ym:s:date" }),
    stat({ metrics: "ym:s:sumGoalReachesAny", dimensions: "ym:s:lastTrafficSource" }),
  ]);
  // Лиды: цели Метрики, похожие на заявку. Только числа — по источникам, страницам входа и дням.
  const allGoals = (await safe(get(`${MT}/management/v1/counter/${c.id}/goals`))).goals ?? [];
  const LEAD = /lead|заявк|form|форм|audit|аудит|quiz_done|callback|звон|order|заказ|submit|contact|запис/i;
  const goals = allGoals.filter((g) => LEAD.test(`${g.name} ${JSON.stringify(g.conditions ?? [])}`)).slice(0, 10);
  const leads = { goals: goals.map((g) => ({ id: g.id, name: g.name })) };
  if (goals.length) {
    const gm = goals.map((g) => `ym:s:goal${g.id}reaches`).join(",");
    const from90 = day(addDays(new Date(), -90));
    [leads.bySource, leads.byLanding, leads.daily, leads.byLanding90] = await Promise.all([
      stat({ metrics: gm, dimensions: "ym:s:lastTrafficSource" }),
      stat({ metrics: gm, dimensions: "ym:s:startURLPath", limit: 50 }),
      stat({ metrics: gm, dimensions: "ym:s:date", sort: "ym:s:date" }),
      safe(get(`${MT}/stat/v1/data?${qs({ ids: c.id, date1: from90, date2: to, accuracy: "full", limit: 100, metrics: gm, dimensions: "ym:s:startURLPath" })}`)
        .then((d) => ({ totals: d.totals, rows: (d.data ?? []).map((r) => ({ key: r.dimensions[0].name, values: r.metrics })) }))),
    ]);
  }
  // Все статьи со статистикой: входы за 90 дней по страницам
  const landing90 = await safe(get(`${MT}/stat/v1/data?${qs({ ids: c.id, date1: day(addDays(new Date(), -90)), date2: to, accuracy: "full", limit: 500, metrics: m, dimensions: "ym:s:startURLPath" })}`)
    .then((d) => ({ totals: d.totals, rows: (d.data ?? []).map((r) => ({ key: r.dimensions[0].name, values: r.metrics })) })));
  const ai = Array.isArray(referers.rows) ? referers.rows.filter((r) => AI.some((d) => r.key.includes(d))) : [];
  return { counter: { id: c.id, site: c.site, status: c.status }, metrics: m.split(","), sources, referers, ai, landing, landing90, daily, goalsAny, leads };
}

async function main() {
  if (!TOKEN) throw new Error("Нет секрета YANDEX_OAUTH_TOKEN");
  if (!HOST) throw new Error("Нет SITE_URL");
  const to = day(addDays(new Date(), -1)), from = day(addDays(new Date(), -28));
  const [wm, mt] = await Promise.all([safe(webmaster(from, to)), safe(metrika(from, to))]);
  const report = { host: HOST, generated: new Date().toISOString(), period: [from, to], webmaster: wm, metrika: mt };
  const file = join(REPORTS, "yandex", `${day(new Date())}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(report, null, 1));
  const errs = [wm.error && `Вебмастер: ${wm.error}`, mt.error && `Метрика: ${mt.error}`].filter(Boolean);
  const shows = wm.history?.indicators?.TOTAL_SHOWS?.reduce((s, x) => s + x.value, 0);
  const clicks = wm.history?.indicators?.TOTAL_CLICKS?.reduce((s, x) => s + x.value, 0);
  console.log(`✓ ${HOST} ${from}…${to}: Яндекс — показов ${shows ?? "?"}, кликов ${clicks ?? "?"}; Метрика — визитов ${mt.sources?.totals?.[0] ?? "?"}, из нейросетей ${mt.ai?.reduce?.((s, r) => s + r.values[0], 0) ?? "?"}, лидов ${mt.leads?.bySource?.totals?.reduce?.((s, x) => s + x, 0) ?? "?"} → ${file}`);
  for (const e of errs) console.log(`::warning::${e.replace(/\s+/g, " ").slice(0, 900)}`);
  if (errs.length === 2) process.exit(1);
}

// ::error:: — причина видна в аннотациях запуска (журналы Actions из облачной сессии не читаются)
main().catch((e) => { const m = String(e.message).replace(/\s+/g, " ").slice(0, 900); console.error(`✗ ${m}`); console.log(`::error::Яндекс: ${m}`); process.exit(1); });
