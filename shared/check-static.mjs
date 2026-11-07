// Минимальный npm run check для статичных сайтов без Next.js (Three.js, vanilla, Vite): тот же стандарт, что у стартера,
// @nikitos-shared check-static.mjs
// в объёме, который применим к любому HTML. Оригинал — NikitOS/.claude/toolkit/deploy-kit/static/check-static.mjs,
// в проекте — scripts/check.mjs; package.json: "check": "<сборка, если есть> && node scripts/check.mjs <папка сборки>".
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(process.argv[2] || ".");
const ROOT = process.cwd();
let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { failed++; console.log(`  ✗ ${m}`); };
const warn = (m) => console.log(`  ⚠ ${m}`);
const skip = new Set(["node_modules", ".git", "specs", ".github", "scripts"]);
const all = (function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => skip.has(e.name) ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
})(OUT);
const html = all.filter((f) => f.endsWith(".html"));
const text = (f) => fs.readFileSync(f, "utf8");

console.log(`check-static: ${path.relative(ROOT, OUT) || "."} — ${html.length} HTML`);
if (!html.length) fail("Нет ни одного .html");
const ext = all.filter((f) => /\.(html|css|js)$/.test(f) && /fonts\.(googleapis|gstatic)\.com/.test(text(f)));
ext.length ? fail(`Google Fonts блокируются в РФ — шрифты локально: ${ext.map((f) => path.relative(OUT, f)).slice(0, 5).join(", ")}`) : ok("Внешних шрифтов нет");
const todos = html.filter((f) => /TODO/.test(text(f)));
todos.length ? fail(`TODO в ${todos.map((f) => path.relative(OUT, f)).join(", ")}`) : ok("TODO нет");
for (const f of html) {
  const h = text(f), rel = path.relative(OUT, f);
  const title = (h.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
  const desc = (h.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)/i) || [])[1] || "";
  if (title.length < 20) fail(`${rel}: title короче 20 символов («${title}»)`);
  if (desc.length < 70) fail(`${rel}: description короче 70 символов`);
  if (!/<html[^>]+lang=/.test(h)) fail(`${rel}: нет <html lang>`);
  if (!/<h1[\s>]/.test(h)) warn(`${rel}: нет <h1> — нейросети и поиск не видят главный заголовок`);
  if (!/application\/ld\+json/.test(h)) warn(`${rel}: нет JSON-LD`);
}
for (const f of ["robots.txt", "sitemap.xml", "llms.txt"]) fs.existsSync(path.join(OUT, f)) ? ok(f) : warn(`Нет ${f}`);
const ht = path.join(OUT, ".htaccess");
if (fs.existsSync(ht) && text(ht).split("\n").some((l) => !/^\s*#/.test(l) && /RewriteCond\s+%\{(HTTPS|SERVER_PORT)\}/i.test(l)))
  fail(".htaccess: редирект по %{HTTPS} — цикл за nginx REG.RU; HTTPS — галочкой в ISPmanager");
if (!html.some((f) => /mc\.yandex\.ru\/metrika|ym\(\d+/.test(text(f)))) warn("Яндекс Метрика не подключена — напоминание (стандарт §9.0)");
const big = all.filter((f) => /\.(jpe?g|png)$/i.test(f) && fs.statSync(f).size > 400_000);
if (big.length) warn(`Тяжёлые картинки > 400 КБ (PageSpeed): ${big.map((f) => path.relative(OUT, f)).slice(0, 5).join(", ")} — webp/avif`);
console.log(failed ? `\n✗ check: ${failed} ошибок` : "\n✓ check пройден");
process.exit(failed ? 1 : 0);
