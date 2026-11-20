#!/usr/bin/env node
// @nikitos-shared target-build.mjs — сборка под цель выкладки (тест или прод). Вызывает site.yml после `npm run check`.
// Стандарт — «Публикация — стандарт», раздел «Тест и прод параллельно».
//
// Тест и прод собираются из одного коммита с одним SITE_URL (боевой домен, если он есть). Строгая проверка
// `npm run check` идёт по обычной сборке. Потом этот скрипт правит готовую папку:
//   indexable=false (тест):
//     - <meta name="robots" content="noindex,nofollow"> в каждой HTML-странице (и в данных RSC Next.js);
//     - robots.txt: «User-agent: * / Disallow: /»;
//     - без Метрики, Google Analytics и верификаций (мета-теги и файлы yandex_*.html, google*.html);
//     - заголовок X-Robots-Tag в .htaccess (Apache, только если есть mod_headers);
//   indexable=true (прод): ничего не закрывает и проверяет, что главная без noindex и robots.txt не закрывает сайт.
//   Оба: абсолютные адреса других целей (--alias) заменяются на SITE_URL — canonical всегда на боевой домен.
//
// Запуск: node target-build.mjs --out out --target test --indexable false --site-url https://client.ru --alias https://client.nikalimp.ru
// Итог — строки ::notice:: / ::error:: (аннотации Actions) и код выхода 1 при ошибке.
import fs from "node:fs";
import path from "node:path";

const arg = (k, d = "") => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
};
const OUT = path.resolve(arg("out", "out"));
const TARGET = arg("target", "test");
const INDEXABLE = arg("indexable", TARGET === "prod" ? "true" : "false") === "true";
const SITE_URL = arg("site-url").replace(/\/+$/, "");
const ALIASES = arg("alias")
  .split(/[\s,]+/)
  .map((u) => u.replace(/\/+$/, ""))
  .filter((u) => u && u !== SITE_URL);

if (!fs.existsSync(OUT)) {
  console.log(`::error::target-build: нет папки сборки ${OUT}`);
  process.exit(1);
}

const TEXT = /\.(html?|xml|txt|json|webmanifest|js|css|rss|atom)$/i;
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
})(OUT);
const rel = (p) => path.relative(OUT, p);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const NOINDEX = '<meta name="robots" content="noindex,nofollow">';
const VERIFY_FILE = /^(yandex_[0-9a-f]+\.html|google[0-9a-f]+\.html|BingSiteAuth\.xml)$/i;
const stats = { html: 0, noindex: 0, aliased: 0, metrika: 0, verification: 0, removed: [] };

for (const f of files) {
  if (!TEXT.test(f)) continue;
  if (!INDEXABLE && VERIFY_FILE.test(path.basename(f)) && path.dirname(f) === OUT) continue; // удаляются ниже
  const before = fs.readFileSync(f, "utf8");
  let s = before;

  // 1. Другие адреса проекта → SITE_URL (canonical, og:url, sitemap, llms.txt, JSON-LD)
  for (const a of ALIASES) {
    const re = new RegExp(esc(a), "g");
    const n = (s.match(re) || []).length;
    if (n) {
      s = s.replace(re, SITE_URL);
      stats.aliased += n;
    }
  }

  if (!INDEXABLE) {
    if (/\.html?$/i.test(f)) {
      stats.html++;
      // старые robots — вон, свой noindex — сразу после <head>
      s = s.replace(/<meta\s+name=["']robots["'][^>]*>/gi, "");
      s = /<head[^>]*>/i.test(s) ? s.replace(/<head([^>]*)>/i, `<head$1>${NOINDEX}`) : NOINDEX + s;
      stats.noindex++;
      // верификации поисковиков
      s = s.replace(/<meta\s+name=["'](?:yandex-verification|google-site-verification|msvalidate\.01|wmail-verification|p:domain_verify|facebook-domain-verification)["'][^>]*>/gi, () => (stats.verification++, ""));
      // Метрика и Google Analytics: скрипт с кодом счётчика, внешний тег и картинка в <noscript>
      s = s.replace(/<script\b[^>]*>(?:(?!<\/script>)[\s\S])*?(?:mc\.yandex\.ru|ym\(\d+|googletagmanager\.com|gtag\()(?:(?!<\/script>)[\s\S])*<\/script>/gi, () => (stats.metrika++, ""));
      s = s.replace(/<script\b[^>]*src=["'][^"']*(?:mc\.yandex\.ru|googletagmanager\.com)[^"']*["'][^>]*>\s*<\/script>/gi, () => (stats.metrika++, ""));
      s = s.replace(/<noscript>(?:(?!<\/noscript>)[\s\S])*?mc\.yandex\.ru(?:(?!<\/noscript>)[\s\S])*<\/noscript>/gi, () => (stats.metrika++, ""));
    }
    // Next.js: мета-теги лежат ещё и в данных RSC (.txt и self.__next_f в HTML) — при переходах страниц они попадают в <head>
    s = s.replace(/(\\?"name\\?":\\?"robots\\?",\\?"content\\?":\\?")[^"\\]*(\\?")/g, "$1noindex,nofollow$2");
  } else if (/\.html?$/i.test(f)) {
    stats.html++;
    // служебные страницы (404, согласие) закрыты намеренно — проверяем главную; страницы из sitemap проверил npm run check
    if (rel(f) === "index.html" && /<meta\s+name=["']robots["'][^>]*noindex/i.test(s)) stats.noindex++;
  }

  if (s !== before) fs.writeFileSync(f, s);
}

if (!INDEXABLE) {
  // robots.txt закрывает всё; sitemap не указываем — тест не должен попасть в выдачу
  fs.writeFileSync(path.join(OUT, "robots.txt"), "# Тестовая копия сайта — закрыта от поисковиков (deploy-kit target-build)\nUser-agent: *\nDisallow: /\n");
  // файлы верификации Вебмастера и Search Console
  for (const f of fs.readdirSync(OUT)) {
    if (VERIFY_FILE.test(f)) {
      fs.rmSync(path.join(OUT, f));
      stats.removed.push(f);
    }
  }
  // заголовок для любых файлов (PDF, картинки), не только HTML
  const ht = path.join(OUT, ".htaccess");
  const block = '\n# deploy-kit target-build: тестовая копия закрыта от поисковиков\n<IfModule mod_headers.c>\n  Header set X-Robots-Tag "noindex, nofollow"\n</IfModule>\n';
  const cur = fs.existsSync(ht) ? fs.readFileSync(ht, "utf8") : "";
  if (!cur.includes("X-Robots-Tag")) fs.writeFileSync(ht, cur + block);

  console.log(
    `::notice::Сборка «${TARGET}» закрыта от поисковиков: noindex в ${stats.noindex} HTML, robots.txt Disallow: /, ` +
      `убрано счётчиков ${stats.metrika}, верификаций ${stats.verification + stats.removed.length}` +
      (stats.aliased ? `, адресов теста → ${SITE_URL}: ${stats.aliased}` : ""),
  );
} else {
  if (stats.noindex) {
    console.log(`::error::Сборка «${TARGET}» индексируемая, но на главной noindex — проверь robots в метаданных layout`);
    process.exit(1);
  }
  const robots = path.join(OUT, "robots.txt");
  if (fs.existsSync(robots) && /User-agent:\s*\*\s*\n\s*Disallow:\s*\/\s*$/im.test(fs.readFileSync(robots, "utf8"))) {
    console.log(`::error::Сборка «${TARGET}» индексируемая, но robots.txt закрывает весь сайт (Disallow: /)`);
    process.exit(1);
  }
  console.log(`::notice::Сборка «${TARGET}» открыта для поисковиков: ${stats.html} HTML без noindex` + (stats.aliased ? `, адресов теста → ${SITE_URL}: ${stats.aliased}` : ""));
}
