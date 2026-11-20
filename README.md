# deploy-kit

## Что делает
Общие сценарии выкладки (reusable workflows GitHub Actions): `site.yml` — сайты (статика), `app.yml` — веб-сервисы и админки (Docker). Паспорт проекта — `publish.json`. Стандарты — «Публикация — стандарт», «Веб-сервис — стандарт».

## Версии
Текущая версия — **2.0.0** (20.11.2026), журнал — `CHANGELOG.md`. Проекты вызывают сценарии по `@main` — тега `v1` в шаблонах нет с 23.10.2026: правка действует везде сразу. Поэтому каждая правка обратно совместима: старый `deploy.yml` без входа `target` работает как раньше. Предохранитель — `self-check.yml`: каждый PR в deploy-kit проходит `actionlint` по сценариям и шаблонам и проверку `target-build.mjs`, PR из `claude/*` с зелёной проверкой сливается сам. Тег `v1` оставлен для старых копий и больше не двигается.

## Тест и прод параллельно (2.0.0)
Каждый клиентский проект живёт на двух адресах: тест — поддомен `*.nikalimp.ru` на хостинге Ника (копия проекта у Ника, все обновления сначала там), прод — домен клиента.
```
PR claude/* ─► check ─► автослияние ─► test: сборка → закрыть от поисковиков → выкладка → проверка
                                          └─ зелёная ─► prod: тот же коммит → сборка → выкладка → проверка
                                          └─ красная ─► Telegram Нику, прод не трогается
```
- `publish.json` → `targets.test` / `targets.prod`: `url`, `ftp_dir_secret` (имя секрета папки), `indexable`. Нет `targets` — старое поле `url` и `FTP_DIR`, как раньше. Нет `targets.prod` (до запуска на домене) — выкладка на прод пропускается.
- `site.yml`, вход `target: test | prod`. Перед сборкой — `SITE_URL` (боевой домен, если есть прод), `SITE_TARGET`, `SITE_INDEXABLE` и `NEXT_PUBLIC_*`. После `npm run check` — `shared/target-build.mjs`: тест получает `noindex,nofollow`, `robots.txt` с `Disallow: /`, `X-Robots-Tag`, без Метрики и верификаций; canonical — на боевой домен. Прод — обычный боевой сайт.
- Проверка цели после выкладки: `/`, `sitemap.xml`, `robots.txt`, `llms.txt` — 200, несуществующая страница — 404, `noindex` есть на тесте и нет на проде.
- FTP-логин и пароль общие (`FTP_HOST`, `FTP_USER`, `FTP_PASS`), папки разные: `FTP_DIR` (тест), `FTP_DIR_PROD` (прод). Нет секрета папки прода — прод пропускается, Нику — сообщение.
- IndexNow, посты в каналы и PageSpeed идут с прода, а пока прода нет — с теста (IndexNow — только с индексируемой цели).
- Выходы `site.yml`: `skipped`, `sha` (собранный коммит — по нему выкладывается прод), `url`.
- Повтор или откат прода — `templates/deploy-prod.yml` (workflow_dispatch «Deploy prod», вход `sha`).

## Файлы
| Файл | Куда идёт |
|---|---|
| `.github/workflows/site.yml` | в репозиторий `nikalimp/deploy-kit`, вызов `@main` |
| `templates/deploy.yml` | в проект: `.github/workflows/deploy.yml` — push в main: тест → проверка → прод тем же коммитом |
| `templates/deploy-prod.yml` | в проект: `.github/workflows/deploy-prod.yml` — повтор или откат прода по `sha` |
| `templates/publish.json` | в корень проекта: паспорт с `targets` |
| `shared/target-build.mjs` | берётся `site.yml` из deploy-kit при каждой выкладке с `target` — сборка под цель |
| `deploy-manual.sh` | в проект: `scripts/deploy-<app>.sh` — план 3, выкладка с Mac |
| `.github/workflows/app.yml` | в `nikalimp/deploy-kit`, вызов `@main` — сервисы и админки |
| `.github/workflows/pr.yml` | в `nikalimp/deploy-kit`, вызов `@main` — check и автослияние PR агента |
| `templates/pr.yml` | в проект сайта: `.github/workflows/pr.yml` (check → слияние → тест → прод) |
| `templates/app/pr-app.yml` | в проект сервиса: `.github/workflows/pr.yml` (check → слияние → app.yml) |
| `templates/app/deploy-app.yml` | в проект сервиса: `.github/workflows/deploy.yml` |
| `templates/app/compose.yml` | в проект: `deploy/compose.yml` (vps-compose) |
| `templates/app/Dockerfile`, `health-route.ts` | в проект: Dockerfile Next.js standalone и `/api/health` |
| `.github/workflows/queue.yml` + `shared/queue-publish.mjs` | в `nikalimp/deploy-kit`, вызов `@main` из `deploy.yml` проекта по будням (schedule): статья дня из плана (ready, дата ≤ сегодня) → блог → выкладка → каналы. Claude по будням не нужен |
| `.github/workflows/data.yml` + `shared/gsc-report.mjs`, `shared/yandex-report.mjs` | в `nikalimp/deploy-kit`, вызов `@main` из `data.yml` проекта по субботам 11:04 (Бангкок): Search Console, Вебмастер, Метрика и лиды (цели Метрики, только числа) → `specs/reports/{gsc,yandex}/`. Только боевые сайты на своих доменах; поддомены `*.nikalimp.ru` пропускаются |
| `templates/data.yml`, `templates/deploy-queue.md` | в проект: `.github/workflows/data.yml`; как добавить очередь в `deploy.yml` |

## Адаптеры
- `ssh-ftp` (по умолчанию) — три пути: SSH (rsync, `id: ssh`, continue-on-error) → FTP (`if: steps.ssh.outcome == 'failure'`, FTP-Deploy-Action, без clean-slate) → вручную с Mac (`deploy-manual.sh`). Сборка — артефакт `site-build` (хранится 1 день; шаг необязательный — при нехватке хранилища Actions выкладка продолжается, кроме `manual-zip`). Красный, только если упали SSH и FTP. В конце — curl 200.
- `ftp`, `s3` (Yandex Object Storage и любой S3), `manual-zip`, `tilda`. `ssh-rsync` — старое имя `ssh-ftp`.
- Секреты и чек-лист нового проекта — «Хостинги — что проверено».
- Монорепо: `site_dir`, `out_dir`, `app_path`, `rsync_exclude`.

## Автослияние (pr.yml)
```
claude/<задача> ─► PR ─► check ─► зелёный ─► слияние (GITHUB_TOKEN) ─► тест ─► прод в том же запуске ─► красная проверка: агент открывает revert-PR
```
- Апрува Ника нет (20.11.2026): любой PR агента из `claude/*` сливается сам после зелёного check — правки `.github/`, `publish.json`, удаление страниц, смена URL с 301, смена adapter. Метки `needs-nik` нет, вход `manual_paths` устарел и не используется.
- Слияние токеном GITHUB_TOKEN не запускает deploy.yml, поэтому выкладка — jobs `test` и `prod` в `pr.yml` проекта.
- Без автослияния — только не от агента: не `claude/*`, форк, черновик.
- За Ником: секреты (вводит только он), новые репозитории и push в чужие репозитории — после его подтверждения.
- Защиту ветки main с обязательным check не включаем: она запретит прямые коммиты статей и коммит медиа из Actions.
- Итоги шагов (путь выкладки, каналы, реестр, ошибки check) — аннотации `::notice::`/`::warning::`/`::error::` и сводка запуска: их видно через REST check-runs, журналы — нет.

## Адаптеры сервисов (app.yml)
- `vps-compose` — VPS: образ из реестра (ghcr или cr.yandex), `docker compose pull`, миграции, `up -d`, health; не 200 — откат на прошлый образ.
- `yc-container` — Yandex Serverless Containers: миграции в Actions, новая ревизия, health.
- `platform` — Timeweb Apps, Vercel Git: платформа собирает сама, сценарий ждёт health.

## Связи
- Используют: `website:publish`, `website:sync`, `website:new-site`, `website:transfer-site`, `website:new-service`, `website:new-admin`.
- Вызывает в проекте: `media`, `site-channels`, `typograf` (prebuild сайта).
