// IndexNow: сообщаем Яндексу и Bing, какие страницы появились или изменились, — без ожидания обхода.
// @nikitos-shared indexnow.mjs — общая версия в nikalimp/deploy-kit/shared; проектные проверки — scripts/check.local.mjs
// Запуск в GitHub Actions (deploy-site.yml):
//   node scripts/indexnow.mjs prepare  — после сборки: сравнивает текст страниц из sitemap с прошлой выкладкой
//                                        (out/indexnow-state.json на сайте), пишет новый state и список изменённых URL
//   node scripts/indexnow.mjs submit   — после заливки: отправляет изменённые URL
//   node scripts/indexnow.mjs key      — один раз на проект: создаёт ключ public/<32 hex>.txt
// Ключ — файл public/<32 hex>.txt (содержимое = имя без .txt). Next.js при каждой сборке меняет служебный код
// в HTML, поэтому сравниваем только видимый текст, title и meta description.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const OUT = "out";
const STATE = "indexnow-state.json";
const CHANGED = ".indexnow-changed.json";
const ENDPOINTS = ["https://yandex.com/indexnow", "https://api.indexnow.org/indexnow"];

if (process.argv[2] === "key") {
  const k = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync(path.join("public", `${k}.txt`), k);
  console.log(`IndexNow: ключ создан — public/${k}.txt`);
  process.exit(0);
}

const key = fs.readdirSync("public").find((f) => /^[a-f0-9]{32}\.txt$/.test(f))?.replace(/\.txt$/, "");
if (!key) { console.log("IndexNow: нет ключа в public/ — пропускаю"); process.exit(0); }

const urls = [...fs.readFileSync(path.join(OUT, "sitemap.xml"), "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const origin = new URL(urls[0]).origin;

function fingerprint(url) {
  const file = path.join(OUT, decodeURI(new URL(url).pathname), "index.html");
  if (!fs.existsSync(file)) return null;
  const html = fs.readFileSync(file, "utf8");
  const meta = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] ?? "";
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  return crypto.createHash("sha1").update(meta + "\n" + text).digest("hex");
}

const mode = process.argv[2];

if (mode === "prepare") {
  let prev = {};
  try {
    const r = await fetch(`${origin}/${STATE}`, { signal: AbortSignal.timeout(15000) });
    if (r.ok) prev = await r.json();
  } catch { /* первая выкладка или сайт недоступен — отправим всё */ }
  const next = {};
  for (const u of urls) { const h = fingerprint(u); if (h) next[u] = h; }
  const changed = Object.keys(next).filter((u) => prev[u] !== next[u]);
  fs.writeFileSync(path.join(OUT, STATE), JSON.stringify(next));
  fs.writeFileSync(CHANGED, JSON.stringify(changed));
  console.log(`IndexNow: страниц в sitemap ${urls.length}, новых или изменённых ${changed.length}`);
  changed.forEach((u) => console.log("  " + u));
} else if (mode === "submit") {
  const changed = fs.existsSync(CHANGED) ? JSON.parse(fs.readFileSync(CHANGED, "utf8")) : [];
  if (!changed.length) { console.log("IndexNow: изменений нет"); process.exit(0); }
  const body = JSON.stringify({ host: new URL(origin).host, key, keyLocation: `${origin}/${key}.txt`, urlList: changed.slice(0, 10000) });
  for (const ep of ENDPOINTS) {
    try {
      const r = await fetch(ep, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body, signal: AbortSignal.timeout(20000) });
      console.log(`IndexNow ${ep}: ${r.status} (${changed.length} URL)`);
    } catch (e) {
      console.log(`::warning::IndexNow ${ep}: ${e.message}`);
    }
  }
} else {
  console.log("Использование: node scripts/indexnow.mjs key|prepare|submit");
}
