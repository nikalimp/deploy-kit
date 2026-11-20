# Журнал deploy-kit

Проекты вызывают сценарии по `@main`, поэтому каждая версия обратно совместима. Версия — для журнала и ссылок, тегом не закрепляется.

## 2.0.0 — 2026-11-20
Тест и прод параллельно, без апрува Ника.
- `site.yml`: вход `target: test | prod`, адрес, папка и индексация — из `publish.json → targets`. Новый job `plan`, выходы `skipped`, `sha`, `url`.
- Сборка под цель: `SITE_URL`, `SITE_TARGET`, `SITE_INDEXABLE` (и `NEXT_PUBLIC_*`) перед сборкой; `shared/target-build.mjs` после `npm run check` закрывает тест от поисковиков (noindex, robots.txt `Disallow: /`, `X-Robots-Tag`, без Метрики и верификаций) и ведёт canonical на боевой домен.
- Проверка цели после выкладки: главная, `sitemap.xml`, `robots.txt`, `llms.txt` — 200, несуществующая страница — 404, noindex только на тесте.
- Секреты папок по целям: `FTP_DIR` (тест), `FTP_DIR_PROD` (прод), для SSH — `SITE_DIR`, `SITE_DIR_PROD`. Нет секрета прода — прод пропускается, Нику сообщение.
- IndexNow, каналы и PageSpeed — с прода, пока прода нет — с теста.
- Сообщение об ошибке называет цель; ошибка теста — «прод не тронут».
- `pr.yml`: метки `needs-nik` и ручного слияния нет — любой PR из `claude/*` сливается после зелёного check. Вход `manual_paths` устарел и не используется.
- Шаблоны: `templates/deploy.yml` и `templates/pr.yml` — тест → прод тем же коммитом; новый `templates/deploy-prod.yml` (повтор и откат по `sha`); `templates/publish.json` с `targets`; `pr-app.yml` без `manual_paths`.
- `self-check.yml`: actionlint и по новым шаблонам; проверка `target-build.mjs` на сборке-образце.
- Совместимость: без входа `target` — всё как в 1.x (вход `url`, секрет `FTP_DIR`, сборка без правок). Без `targets` в `publish.json` вызов с `target: test` работает как раньше, `target: prod` пропускается.

## 1.x — 2026-10-20 … 2026-11-14
Общие сценарии `site.yml`, `app.yml`, `pr.yml`, `queue.yml`, `data.yml`; адаптер `ssh-ftp`; автослияние PR агента с меткой `needs-nik` для ручных путей; секреты по одному (`NEXT_PUBLIC_*`, `LEAD_*`).
