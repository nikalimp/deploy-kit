// Проверка перед запуском (стандарт AI-Ready сайта, §11). Запуск: npm run check — сначала собирает сайт, потом проверяет out/.
// @nikitos-shared check.mjs — общая версия в nikalimp/deploy-kit/shared; проектные проверки — scripts/check.local.mjs
//  1. В готовом сайте нет TODO и домена-заглушки example.ru.
//  2. geo-check: robots.txt, sitemap, llms.txt, мета-теги, JSON-LD, текст без JS. Балл ≥ 8 и ни одной проблемы P1.
//  3. Индексация (стандарт §2 «Индексация» и §3): страницы из sitemap без noindex, с canonical на себя и title от 40 символов —
//     и не короче 250 слов в <main> — иначе ошибка; title длиннее 65, description вне 120–160, lastmod = дата сборки, нет ключа IndexNow — предупреждения.
//  4. Блокирующее перед выкладкой (стандарт §11): Метрика подключена, ИНН и ОГРН проходят контрольную сумму,
//     есть политика и согласие на обработку ПДн, у переноса — снят geo-check «до».
//  5. Тексты по Главреду (стандарт §7): каждая страница из sitemap — 7,5+ (ниже 6,5 — ошибка).
//  6. Дизайн-система (стандарт §6): цвет в обход токенов (text-[#…], bg-[rgb(…)]) — ошибка.
//  7. Ориентиры с пометкой «estimate» — список мест, которые ждут подтверждения клиента.
// Режима тестовой выкладки нет (решение Ника, 21.10.2026): сайт всегда открыт для индексации, проверка всегда строгая.
// Отчёт geo-check сохраняется в specs/reports/geo-check-<дата>.md — история для клиента.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { glavred } from "./glavred.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "out");
// Проектные настройки проверок — scripts/check.local.mjs (необязательный, переживает обновление этого файла из стартера):
//   export const glavredSkip = ["/privacy-policy/", …] — страницы, которые Главред не проверяет (юридические тексты переносятся дословно)
//   export const thinOk = ["/consent/", …] — служебные страницы, которым не нужен минимум 250 слов
//   export const exceptions = { privacy: "причина", requisites: "причина" } — исключения из spec §9 «Исключения»: блок становится предупреждением
//   export default async ({ ROOT, OUT, fail, ok, warn, prodFail }) => { … } — свои проверки, раздел 8
const localPath = path.join(ROOT, "scripts", "check.local.mjs");
let localMod = null;
if (fs.existsSync(localPath)) {
  try { localMod = await import(`file://${localPath}`); }
  catch (e) { console.log(`✗ check.local.mjs не загрузился: ${e.message.split("\n")[0]}`); process.exitCode = 1; }
}
const MIN_SCORE = 8;
let failed = false;
const fail = (msg) => { failed = true; console.log(`✗ ${msg}`); };
const ok = (msg) => console.log(`✓ ${msg}`);
const warn = (msg) => console.log(`  ⚠ ${msg}`);
const prodFail = fail; // блокирующее перед выкладкой (стандарт §11)

if (!fs.existsSync(OUT)) { console.error("Нет out/ — сначала npm run build"); process.exit(1); }

// 1. TODO и заглушки в готовом сайте
const files = (function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? (e.name === "_next" ? [] : walk(p)) : /\.(html|txt|xml)$/.test(e.name) ? [p] : [];
  });
})(OUT);
const todos = [];
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  const n = (text.match(/TODO/g) || []).length;
  if (n) todos.push(`${path.relative(OUT, f)} (${n})`);
}
if (todos.length) prodFail(`TODO в ${todos.length} файлах: ${todos.slice(0, 8).join(", ")}${todos.length > 8 ? " …" : ""}`);
else ok("TODO нет");

const robots = fs.readFileSync(path.join(OUT, "robots.txt"), "utf8");
const base = (robots.match(/^Host:\s*(\S+)/m) || [])[1] || "";
if (!base || base.includes("example.ru")) fail(`Домен не задан: site.url = ${base || "пусто"}`);
else ok(`Домен: ${base}`);

// 2. geo-check по локальной сборке
const date = new Date().toISOString().slice(0, 10);
const reports = path.join(ROOT, "specs", "reports");
fs.mkdirSync(reports, { recursive: true });
const json = path.join(reports, `.geo-check-${date}.json`);
let md = "";
try {
  md = execFileSync("python3", [path.join(ROOT, "scripts", "geo-check.py"), OUT, "--base", base || "https://example.ru", "--max", "200", "--json", json], { encoding: "utf8" });
} catch (e) {
  fail(`geo-check не запустился: ${e.message.split("\n")[0]} (нужен python3)`);
}
if (md) {
  fs.writeFileSync(path.join(reports, `geo-check-${date}.md`), md);
  const R = JSON.parse(fs.readFileSync(json, "utf8"));
  fs.rmSync(json, { force: true });
  const p1 = R.issues.filter(([s]) => s === "P1").map(([, m]) => m);
  if (R.tech_score < MIN_SCORE) fail(`geo-check: балл ${R.tech_score}/10, нужно ≥ ${MIN_SCORE}`);
  else ok(`geo-check: балл ${R.tech_score}/10`);
  if (p1.length) fail(`geo-check: проблемы P1 — ${p1.join("; ")}`);
  const other = R.issues.filter(([s]) => s !== "P1");
  if (other.length) console.log(`  ещё ${other.length} замечаний P2/P3 — см. specs/reports/geo-check-${date}.md`);
}

// 3. Индексация
const MIN_WORDS = 250; // минимум слов в <main> для каждой страницы из sitemap (стандарт §2 «Индексация»)
const THIN_OK = ["/contacts/", ...(localMod?.thinOk ?? [])]; // служебные страницы, где объём не важен; свои — export const thinOk в check.local.mjs, с причиной в specs/02-spec.md, §9
const sitemapXml = fs.readFileSync(path.join(OUT, "sitemap.xml"), "utf8");
const entries = [...sitemapXml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(([, u]) => ({
  loc: (u.match(/<loc>([^<]+)<\/loc>/) || [])[1], lastmod: (u.match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1],
}));
const TITLE_MIN = 40, TITLE_MAX = 65, DESC_MIN = 120, DESC_MAX = 160; // длина вместе с названием бренда
const unesc = (t) => t.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
const idx = { noindex: [], canonical: [], thin: [], shortTitle: [], longTitle: [], desc: [] };
for (const { loc } of entries) {
  const file = path.join(OUT, decodeURI(new URL(loc).pathname), "index.html");
  if (!fs.existsSync(file)) { fail(`В sitemap есть ${loc}, а страницы нет`); continue; }
  const html = fs.readFileSync(file, "utf8");
  if (/<meta name="robots" content="[^"]*noindex/.test(html)) idx.noindex.push(loc);
  const canon = (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1];
  if (canon !== loc) idx.canonical.push(`${loc} → ${canon ?? "нет"}`);
  const p = new URL(loc).pathname;
  const title = unesc((html.match(/<title>([^<]*)<\/title>/) || [])[1] ?? "");
  if (title.length < TITLE_MIN) idx.shortTitle.push(`${p} «${title}» (${title.length})`);
  if (title.length > TITLE_MAX) idx.longTitle.push(`${p} (${title.length})`);
  const desc = unesc((html.match(/<meta name="description" content="([^"]*)"/) || [])[1] ?? "");
  if (desc.length < DESC_MIN || desc.length > DESC_MAX) idx.desc.push(`${p} (${desc.length})`);
  const main = (html.match(/<main[\s\S]*?<\/main>/) || [html])[0]
    .replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ");
  const words = main.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  if (words < MIN_WORDS && !THIN_OK.includes(new URL(loc).pathname)) idx.thin.push(`${new URL(loc).pathname} (${words})`);
}
if (idx.noindex.length) fail(`В sitemap страницы с noindex: ${idx.noindex.join(", ")}`);
if (idx.canonical.length) fail(`canonical не указывает на саму страницу: ${idx.canonical.slice(0, 5).join("; ")}`);
if (idx.shortTitle.length) fail(`title короче ${TITLE_MIN} символов — добавь расшифровку или уточнение (стандарт §3): ${idx.shortTitle.join("; ")}`);
if (idx.longTitle.length) console.log(`  ⚠ title длиннее ${TITLE_MAX} символов, Google обрежет: ${idx.longTitle.join(", ")}`);
if (idx.desc.length) console.log(`  ⚠ description вне ${DESC_MIN}–${DESC_MAX} символов: ${idx.desc.join(", ")}`);
if (!idx.noindex.length && !idx.canonical.length && !idx.shortTitle.length) ok(`Индексация: ${entries.length} страниц в sitemap, noindex и чужих canonical нет`);
if (idx.thin.length) fail(`Страницы короче ${MIN_WORDS} слов в <main> — дописать (история, применение, рекомендации, FAQ): ${idx.thin.join(", ")}`);
const today = new Date().toISOString().slice(0, 10);
const buildDated = entries.filter((e) => e.lastmod?.startsWith(today)).length;
if (entries.length > 3 && buildDated / entries.length > 0.5) console.log(`  ⚠ lastmod = сегодня у ${buildDated} из ${entries.length} URL — похоже на дату сборки, ставь только реальные даты изменений`);
if (!fs.readdirSync(path.join(ROOT, "public")).some((f) => /^[a-f0-9]{32}\.txt$/.test(f))) console.log("  ⚠ Нет ключа IndexNow — npm run indexnow:key");

// 3б. Хостинг и внешние ресурсы (стандарт §1, «Хостинги — что проверено»)
{
  const ht = path.join(ROOT, "public", ".htaccess");
  const htBad = fs.existsSync(ht) && fs.readFileSync(ht, "utf8").split("\n").some((l) => !/^\s*#/.test(l) && /RewriteCond\s+%\{(HTTPS|SERVER_PORT)\}/i.test(l));
  if (htBad)
    fail("public/.htaccess: редирект на HTTPS по %{HTTPS}/%{SERVER_PORT} — за nginx REG.RU это бесконечный цикл; HTTPS включать галочкой в ISPmanager");
  const extFonts = [];
  const allOut = (function walkAll(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walkAll(path.join(d, e.name)) : [path.join(d, e.name)]); })(OUT);
  for (const f of allOut.filter((f) => /\.(html|css)$/.test(f))) if (/fonts\.(googleapis|gstatic)\.com/.test(fs.readFileSync(f, "utf8"))) extFonts.push(path.relative(OUT, f));
  if (extFonts.length) fail(`Google Fonts блокируются в РФ — шрифты только локально (@fontsource): ${extFonts.slice(0, 5).join(", ")}`);
  else if (!htBad) ok("Хостинг: .htaccess без цикла HTTPS, внешних шрифтов нет");
}

// 4. Блокирующее перед выкладкой
const home = fs.readFileSync(path.join(OUT, "index.html"), "utf8");
if (/mc\.yandex\.ru\/metrika/.test(home)) ok("Яндекс Метрика подключена");
else warn("Яндекс Метрика не подключена — напоминание (стандарт §9.0): свой проект — сразу, клиентский — после публикации на его домене; номер — site.metrikaId");
const EXC = localMod?.exceptions ?? {};
for (const page of ["privacy-policy", "consent"]) {
  if (fs.existsSync(path.join(OUT, page, "index.html"))) continue;
  if (EXC.privacy) warn(`Нет /${page}/ — исключение проекта: ${EXC.privacy}`);
  else prodFail(`Нет страницы /${page}/ — политика и отдельное согласие на обработку ПДн обязательны (стандарт §8)`);
}
// ИНН и ОГРН — контрольные суммы ФНС: ловят КПП вместо ИНН, опечатки и перепутанные поля
// site.ts — в src/content/ (стартер) или src/lib/ (nikalimp.ru и старые проекты)
const siteTsPath = [path.join(ROOT, "src", "content", "site.ts"), path.join(ROOT, "src", "lib", "site.ts")].find((f) => fs.existsSync(f));
const siteTs = siteTsPath ? fs.readFileSync(siteTsPath, "utf8") : "";
const field = (name) => (siteTs.match(new RegExp(`${name}:\\s*"([^"]*)"`)) || [])[1] ?? "";
const digits = (v) => v.split("").map(Number);
const innOk = (v) => {
  const d = digits(v), w = (ws) => (ws.reduce((s, k, i) => s + k * d[i], 0) % 11) % 10;
  if (/^\d{10}$/.test(v)) return w([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  if (/^\d{12}$/.test(v)) return w([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && w([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
  return false;
};
const ogrnOk = (v) => {
  if (/^\d{13}$/.test(v)) return Number((BigInt(v.slice(0, 12)) % 11n) % 10n) === +v[12];
  if (/^\d{15}$/.test(v)) return Number((BigInt(v.slice(0, 14)) % 13n) % 10n) === +v[14];
  return false;
};
const inn = field("inn"), ogrn = field("ogrn") || field("ogrnip"); // у ИП поле ogrnip
// Самозанятый (НПД) — без ОГРН: только ИНН физлица, 12 цифр. Признак — «самозанят» или «НПД» в legal.status
const npd = /status:\s*"[^"]*(самозанят|НПД|профессиональный доход)/i.test(siteTs);
if (npd) {
  if (!/^\d{12}$/.test(inn) || !innOk(inn)) fail(`Самозанятый: ИНН ${inn || "пусто"} — нужен ИНН физлица из 12 цифр с верной контрольной суммой`);
  else ok(`Реквизиты: самозанятый, ИНН ${inn} корректен по контрольной сумме`);
} else if (EXC.requisites) {
  ok(`Реквизиты не требуются — исключение проекта: ${EXC.requisites}`);
} else if (/TODO/.test(inn + ogrn) || !inn || !ogrn) prodFail("Реквизиты не заполнены: legal.inn и legal.ogrn (у ИП — legal.ogrnip) в src/content/site.ts");
else {
  if (!innOk(inn)) fail(`ИНН ${inn} не проходит контрольную сумму (10 цифр — ООО, 12 — ИП; 9 цифр — это КПП, не ИНН). Сверь с ЕГРЮЛ: egrul.nalog.ru`);
  if (!ogrnOk(ogrn)) fail(`ОГРН ${ogrn} не проходит контрольную сумму (13 цифр — ООО, 15 — ОГРНИП). Сверь с ЕГРЮЛ: egrul.nalog.ru`);
  if (innOk(inn) && ogrnOk(ogrn)) ok(`Реквизиты: ИНН ${inn} и ОГРН ${ogrn} корректны по контрольной сумме (совпадение с ЕГРЮЛ — в чеклисте запуска)`);
}
// Перенос: без замера «до» нельзя показать результат переезда
if (fs.existsSync(path.join(ROOT, "specs", "00-transfer-audit.md"))) {
  const rep = fs.existsSync(reports) ? fs.readdirSync(reports) : [];
  if (rep.some((f) => /^geo-check-before-.*\.md$/.test(f))) ok("Перенос: geo-check «до» снят");
  else if (/geo-check «до»/.test(fs.readFileSync(path.join(ROOT, "specs", "02-spec.md"), "utf8").split(/^## 9\./m)[1] ?? "")) ok("Перенос: geo-check «до» не снят — исключение в specs/02-spec.md §9");
  else prodFail("Перенос: нет specs/reports/geo-check-before-<дата>.md — снять со старого сайта до смены DNS: python3 scripts/geo-check.py <старый адрес> --max 50");
  const base = path.join(reports, "baseline");
  if (!fs.existsSync(base) || !fs.readdirSync(base).length) warn("Перенос: нет базовой линии specs/reports/baseline/ (экспорт Метрики и запросов Вебмастера) — без неё мониторинг «до / после» невозможен; записать как долг в карточку клиента");
}

// 5. Главред по страницам из sitemap
const GLAV_OK = 7.5, GLAV_FAIL = 6.5;
const glav = [];
const glavSkip = new Set(localMod?.glavredSkip ?? []);
for (const { loc } of entries) {
  if (glavSkip.has(new URL(loc).pathname)) continue;
  const file = path.join(OUT, decodeURI(new URL(loc).pathname), "index.html");
  if (!fs.existsSync(file)) continue;
  const main = (fs.readFileSync(file, "utf8").match(/<main[\s\S]*?<\/main>/) || [""])[0]
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ")
    .replace(/<\/(p|li|h[1-6]|dt|dd|td|th|summary|div)>|<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;| |⁠/g, " ");
  const r = glavred(main);
  if (r.words > 30 && r.score < GLAV_OK) glav.push({ p: new URL(loc).pathname, score: r.score });
}
const glavBad = glav.filter((g) => g.score < GLAV_FAIL);
if (glavBad.length) prodFail(`Главред ниже ${GLAV_FAIL}: ${glavBad.map((g) => `${g.p} (${g.score})`).join(", ")} — node scripts/glavred.mjs <файл> покажет, что править`);
const glavWarn = glav.filter((g) => g.score >= GLAV_FAIL);
if (glavWarn.length) warn(`Главред ниже ${GLAV_OK} (цель для продающих страниц): ${glavWarn.map((g) => `${g.p} (${g.score})`).join(", ")}`);
if (!glav.length) ok(`Главред: все страницы из sitemap — ${GLAV_OK}+`);

// 6. Цвет в обход токенов
const srcFiles = (function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : /\.(tsx?|mdx?)$/.test(e.name) ? [p] : [];
  });
})(path.join(ROOT, "src"));
const ARBITRARY_COLOR = /\b(?:text|bg|border|fill|stroke|from|via|to|ring|outline|accent|shadow|decoration|caret|divide|placeholder)-\[(?:#|rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)/;
const colorHits = [];
for (const f of srcFiles) {
  fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    if (ARBITRARY_COLOR.test(line)) colorHits.push(`${path.relative(ROOT, f)}:${i + 1}`);
  });
}
if (colorHits.length) fail(`Цвет в обход токенов (стандарт §6, Tailwind п. 2) — заведи токен в globals.css: ${colorHits.slice(0, 8).join(", ")}${colorHits.length > 8 ? " …" : ""}`);
else ok("Цвета — только через токены");

// 7. Ориентиры, которые ждут подтверждения клиента
const estimates = [];
for (const f of [...srcFiles.filter((f) => f.includes(`${path.sep}content${path.sep}`)), ...(fs.existsSync(path.join(ROOT, "content")) ? (function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".md") && !e.name.startsWith("_") ? [path.join(d, e.name)] : []));
})(path.join(ROOT, "content")) : [])]) {
  fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => { if (/\bestimate\b/i.test(line)) estimates.push(`${path.relative(ROOT, f)}:${i + 1}`); });
}
if (estimates.length) warn(`Ориентиры без подтверждения клиента (estimate), ${estimates.length}: ${estimates.slice(0, 10).join(", ")} — каждый должен быть в «Вопросах» specs/05-tasks.md`);

// 7б. Хлебные крошки — только на страницах второго уровня и глубже (стандарт §2.4)
const crumbsTop = fs.readdirSync(OUT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(OUT, e.name, "index.html")))
  .filter((e) => /aria-label="Хлебные крошки"|"BreadcrumbList"/.test(fs.readFileSync(path.join(OUT, e.name, "index.html"), "utf8")))
  .map((e) => `/${e.name}/`)
  .filter((u) => !(localMod?.crumbsOk ?? []).includes(u)); // check.local.mjs: export const crumbsOk = ["/semantics/"] — страницы-исключения с двойной вложенностью
if (crumbsTop.length) warn(`Хлебные крошки на страницах первого уровня (стандарт §2.4 — только со второго уровня): ${crumbsTop.join(", ")}`);

// 8. Проектные проверки — scripts/check.local.mjs (переживает обновление этого файла из стартера).
//    export default async ({ ROOT, OUT, fail, ok, warn }) => { … }
if (localMod?.default) {
  try { await localMod.default({ ROOT, OUT, fail, ok, warn, prodFail }); }
  catch (e) { fail(`check.local.mjs упал: ${e.message.split("\n")[0]}`); }
}

console.log(failed ? "\nПроверка НЕ пройдена — к запуску рано." : "\nПроверка пройдена. Дальше — ручной чеклист specs/06-launch-checklist.md.");
process.exit(failed ? 1 : 0);
