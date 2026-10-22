# deploy-kit

## Что делает
Общие сценарии выкладки (reusable workflows GitHub Actions): `site.yml` — сайты (статика), `app.yml` — веб-сервисы и админки (Docker). Паспорт проекта — `publish.json`. Стандарты — «Публикация — стандарт», «Веб-сервис — стандарт».

## Файлы
| Файл | Куда идёт |
|---|---|
| `.github/workflows/site.yml` | в репозиторий `nikalimp/deploy-kit`, тег `v1` |
| `deploy.yml` | в проект: `.github/workflows/deploy.yml` (10 строк, вызов site.yml) |
| `publish.json` | в корень проекта |
| `deploy-manual.sh` | в проект: `scripts/deploy-<app>.sh` — план 3, выкладка с Mac |
| `.github/workflows/app.yml` | в `nikalimp/deploy-kit`, тег `v1` — сервисы и админки |
| `.github/workflows/pr.yml` | в `nikalimp/deploy-kit`, тег `v1` — check и автослияние PR агента |
| `templates/pr.yml` | в проект сайта: `.github/workflows/pr.yml` (check → слияние → site.yml) |
| `templates/app/pr-app.yml` | в проект сервиса: `.github/workflows/pr.yml` (check → слияние → app.yml) |
| `templates/app/deploy-app.yml` | в проект сервиса: `.github/workflows/deploy.yml` |
| `templates/app/compose.yml` | в проект: `deploy/compose.yml` (vps-compose) |
| `templates/app/Dockerfile`, `health-route.ts` | в проект: Dockerfile Next.js standalone и `/api/health` |

## Адаптеры
- `ssh-ftp` (по умолчанию) — три пути: SSH (rsync, `id: ssh`, continue-on-error) → FTP (`if: steps.ssh.outcome == 'failure'`, FTP-Deploy-Action, без clean-slate) → вручную с Mac (`deploy-manual.sh`). Сборка всегда — артефакт `site-build`. Красный, только если упали SSH и FTP. В конце — curl 200.
- `ftp`, `s3` (Yandex Object Storage и любой S3), `manual-zip`, `tilda`. `ssh-rsync` — старое имя `ssh-ftp`.
- Секреты и чек-лист нового проекта — «Хостинги — что проверено».
- Монорепо: `site_dir`, `out_dir`, `app_path`, `rsync_exclude`.

## Автослияние (pr.yml)
```
claude/<задача> ─► PR ─► check ─► зелёный ─► слияние (GITHUB_TOKEN) ─► выкладка в том же запуске ─► не 200: агент открывает revert-PR
```
- Слияние токеном GITHUB_TOKEN не запускает deploy.yml, поэтому выкладка — job `deploy` в `pr.yml` проекта (`ref: main`).
- Без автослияния: не `claude/*`, форк, черновик, метка `needs-nik`, правка путей `manual_paths` (по умолчанию `.github/`, `publish.json`) — метку ставит сам.
- Защиту ветки main с обязательным check не включаем: она запретит прямые коммиты статей и коммит медиа из Actions.
- Итоги шагов (путь выкладки, каналы, реестр, ошибки check) — аннотации `::notice::`/`::warning::`/`::error::` и сводка запуска: их видно через REST check-runs, журналы — нет.

## Адаптеры сервисов (app.yml)
- `vps-compose` — VPS: образ из реестра (ghcr или cr.yandex), `docker compose pull`, миграции, `up -d`, health; не 200 — откат на прошлый образ.
- `yc-container` — Yandex Serverless Containers: миграции в Actions, новая ревизия, health.
- `platform` — Timeweb Apps, Vercel Git: платформа собирает сама, сценарий ждёт health.

## Связи
- Используют: `web:publish`, `web:update`, `web:new-service`, `web:new-admin`.
- Вызывает в проекте: `media`, `site-channels`, `typograf` (prebuild сайта).
