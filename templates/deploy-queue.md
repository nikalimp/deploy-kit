# Очередь публикации в deploy.yml проекта

Проект с контент-заводом добавляет в свой `.github/workflows/deploy.yml` расписание и job очереди перед выкладкой:

```yaml
on:
  push: …как было…
  schedule:
    - cron: "11 4 * * 1-5"   # Пн–Пт 11:11 по Бангкоку
  workflow_dispatch: {}
jobs:
  queue:
    permissions: { contents: write }
    uses: nikalimp/deploy-kit/.github/workflows/queue.yml@main
    with:
      config: content/factory/content.config.json
  site:
    needs: queue
    if: github.event_name != 'schedule' || needs.queue.outputs.published == 'true'
    permissions: { contents: write }
    uses: nikalimp/deploy-kit/.github/workflows/site.yml@main
    with:
      ref: main            # выкладывать main с коммитом очереди
      …как было…
```

Коммит очереди идёт через `GITHUB_TOKEN` и сам выкладку не запускает — поэтому `site` ждёт `queue` в том же запуске.
