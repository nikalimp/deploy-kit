# deploy-kit

## Что делает
Общий сценарий выкладки для всех сайтов (reusable workflow GitHub Actions) и паспорт проекта `publish.json`. Стандарт — «Публикация — стандарт».

## Файлы
| Файл | Куда идёт |
|---|---|
| `.github/workflows/site.yml` | в репозиторий `nikalimp/deploy-kit`, тег `v1` |
| `deploy.yml` | в проект: `.github/workflows/deploy.yml` (10 строк, вызов site.yml) |
| `publish.json` | в корень проекта |
| `deploy-manual.sh` | в проект: `scripts/deploy-<app>.sh` — план 3, выкладка с Mac |

## Адаптеры
- `ssh-ftp` (по умолчанию) — три пути: SSH (rsync, `id: ssh`, continue-on-error) → FTP (`if: steps.ssh.outcome == 'failure'`, FTP-Deploy-Action, без clean-slate) → вручную с Mac (`deploy-manual.sh`). Сборка всегда — артефакт `site-build`. Красный, только если упали SSH и FTP. В конце — curl 200.
- `ftp`, `s3` (Yandex Object Storage и любой S3), `manual-zip`, `tilda`. `ssh-rsync` — старое имя `ssh-ftp`.
- Секреты и чек-лист нового проекта — «Хостинги — что проверено».
- Монорепо: `site_dir`, `out_dir`, `app_path`, `rsync_exclude`.

## Связи
- Используют: `website:publish`, `website:update`.
- Вызывает в проекте: `media`, `site-channels`, `typograf` (prebuild сайта).
