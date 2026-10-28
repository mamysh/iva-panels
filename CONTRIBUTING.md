# Разработка Panels

Нужны Node.js 24 и npm. Runtime службы рассчитан на Linux с `bash` и `flock`.
Исходники — `plugin/sh.iva/services/router`, тесты — `test/`.
Сценарии используют вымышленные данные, временные каталоги и локальные заглушки.

## Локальная проверка

```sh
npm ci
npm run check
node scripts/check-panel.ts examples/notes
node scripts/check-panel.ts examples/dynamic-notes
bash -n plugin/sh.iva/services/router/launch.sh
```

`npm run check` включает формат, типы, тесты, побайтовую проверку bundles,
privacy текущих файлов и reachable Git-истории, локальные ссылки и audit.
Linux-тест launcher пропускается на macOS и выполняется в Linux CI.
Проверка локальных ссылок не подтверждает доступность внешних URL.

После изменения TypeScript:

```sh
npm run format
npm run build
npm run check
```

В поставке сохраняются `server.mjs`, `lifecycle-worker.mjs`, `native-manager.mjs`, `inspect.mjs`, `install.mjs`.
Редактируйте исходники и пересобирайте; ручная правка bundle запрещена.
CI проверяет сохранённые bundles без предварительной перезаписи.

## Подключение другого плагина

Начните с [INTEGRATION](docs/INTEGRATION.md). Проверка поставляемого пакета
отдельным процессом:

```sh
node --test test/integration-example.test.ts
```

Для descriptor — [v1](docs/PLUGIN_API.md) и [v2](docs/DYNAMIC_API.md).
Для карточок в разговоре — [CHAT_CARDS](docs/CHAT_CARDS.md).
Поставляемый skill должен содержать тот же контракт и актуальные примеры,
чтобы Иве не требовался доступ к приватным справочникам.

## Проверки Bridge и менеджера

CI использует изолированные exact checkout Ивы; их SHA перечислены в
[COMPATIBILITY](docs/COMPATIBILITY.md) и [workflow](.github/workflows/check.yml).
В заранее подготовленном тестовом окружении:

```sh
node scripts/check-settings.ts /path/to/exact/bitrix/plugin
node scripts/check-bridge.mjs /path/to/isolated/iva-checkout /path/to/exact/bitrix/plugin
node scripts/check-lifecycle.mjs /path/to/isolated/iva-checkout
node scripts/check-forced-build.mjs /path/to/isolated/iva-checkout
```

Не используйте рабочую установку как sandbox. Исходники ядра не патчатся;
скрипты создают временные данные. Bridge использует настоящий маршрут штатных
модулей, Eve/Bot API заглушки и запрещает `getUpdates`. Менеджер использует
подменённые systemd/build/health. Эти проверки не являются чистой установкой,
живым Telegram или настоящим Linux lifecycle.

Для своей основы сначала проверьте её контракт; новое имя версии не расширяет
поддержку менеджера автоматически. Матрица 0.5.7 также запускает native lifecycle и forced-build, включая отказ
сборки и tamper каждого закреплённого исходника. Переход к другому exact SHA требует
отдельной проверки и обновления матрицы.

## Правила изменения

- Сохраняйте обычные сообщения, native callbacks и единственный polling Bridge.
- Права и бизнес-валидация принадлежат плагину; descriptor не выбирает shell,
  произвольный tool, URL или секреты.
- Для изменений доставки/записи проверяйте durable intent до эффекта, lost response,
  повторы после рестарта, чужие кнопки, stale revision, TTL и status без записи.
- Для lifecycle проверяйте весь реестр и соседние службы, а не только целевой enabled.
- Согласуйте README, skill, manifest, схемы, инструкции и CHANGELOG с кодом.
- При изменении устанавливаемого `plugin/` обновляйте package/lock, manifest и runtime version.
- Не добавляйте реальные токены, webhook, runtime state, приватные пути и локальную память.

## Перед pull request

Опишите проблему и новое поведение для пользователя. Укажите проведённые проверки
и их границы, изменения прав и миграции. Просмотрите staged diff, выполните
`git diff --check` и дождитесь CI на exact SHA.

[Требования к выпуску](docs/RELEASING.md), [безопасность](SECURITY.md),
[план чистой установки](docs/ACCEPTANCE.md), [оформление иллюстраций](docs/VISUALS.md).

Для установщика на изолированном exact checkout0.5.7:

```sh
node scripts/check-install.mjs /path/to/isolated/iva-checkout
```

Это native proposal/install smoke с настоящими bundles и flock, но заменой
systemd/Telegram. Рабочую Иву не используйте как sandbox первой установки.
