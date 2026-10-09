# Разработка

Требуется Node.js 24 и npm. Runtime ориентирован на Linux со штатной утилитой `flock`. Исходники сервиса находятся в `plugin/sh.iva/services/router`, тесты используют синтетические данные и локальные HTTP заглушки.

```sh
npm ci
npm run format
npm run build
npm run check
bash -n plugin/sh.iva/services/router/launch.sh
```

Редактируйте TypeScript, затем пересобирайте `server.mjs`, `lifecycle-worker.mjs` и `native-manager.mjs`. Сборка проверяется побайтово; ручное исправление bundle запрещено. CI проверяет сохранённый bundle без его предварительной перезаписи. Зависимости закреплены в lockfile, install-time скрипты не нужны сервису.

Изменение поведения требует согласования README, контрактов, документации и CHANGELOG. Для изменений повторов, доставки, прав и маршрутизации добавляйте регрессионные проверки. Не считайте unit-тесты проверкой полного Bridge или живого Telegram.

Текущая область включает общий каталог, декларативные страницы iva-panels/v1, навигацию и карточку/проверку публичного stable отправки файлов и явно включённые чтение и редактор настроек Bitrix24 через собственные подтверждения плагина. Общий v2 API определён в docs/DYNAMIC_API.md и ADR0008; новые транспорты, доступ к секретам и расширение операций записи требуют отдельного архитектурного решения с проверкой прав. Отдельный lifecycle opt-in вызывает только штатный enable/disable в ограниченной systemd-задаче; это не произвольный API команд. Бизнес-правила остаются в соответствующей интеграции.

Не добавляйте конфигурацию, runtime state, локальную память, личные пути или настоящие ответы сервисов в Git. `check:privacy` — дополнительная проверка, она не заменяет просмотр diff и истории. Для открытия репозитория обязательны условия [RELEASING](docs/RELEASING.md).

Дополнительная проверка штатного Bridge:

```sh
node scripts/check-bridge.mjs /path/to/isolated/iva-checkout
```

В указанном checkout заранее выполните `npm ci`; используйте отдельный stock checkout с exact SHA. Script задаёт только синтетические credentials, создаёт временные data/config и запрещает getUpdates. CI запускает его для двух закреплённых SHA; границы описаны в COMPATIBILITY. Установка зависимостей upstream — отдельная тестовая среда, её аудит не заменяет аудит плагина.

Для settings editing обязательно проверять durable acting intent до вызова с эффектом, отсутствие повторной mutation после ошибки доставки или неизвестного исхода, чужой owner/message, stale revision, отмену и TTL. `node scripts/check-settings.ts /path/to/exact/bitrix/plugin` проверяет настоящий bundle на изолированных данных без webhook. Второй аргумент `scripts/check-bridge.mjs` добавляет полный Bridge цикл с этим же bundle.

Для изменения общего контракта проверяйте `node scripts/check-panel.ts examples/notes`, runtime validation и JSON Schema. Требования автору — [PLUGIN_API](docs/PLUGIN_API.md).

Для lifecycle изменений запускайте `node scripts/check-lifecycle.mjs /path/to/isolated/iva-checkout`: штатные команды работают только с временным реестром, build/systemd/health подменены. Проверяйте queued/running перед эффектом, stale snapshot, отмену, повторы, частичный результат и отсутствие скрытого rollback. Настоящее Linux-переключение установки проверяется отдельно при нужном владельцу изменении.

Для dev.10 запускайте также `node scripts/check-forced-build.mjs /path/to/isolated/iva-checkout`: он воспроизводит upstream reuse bug и проверяет настоящий native toggle dispatcher с force build hook. Исходники ядра не менять; тесты создают только временные данные.

Для v2 запускайте `node --test test/dynamic.test.ts`, проверяйте пример `node scripts/check-panel.ts examples/dynamic-notes` и совпадение поставляемых копий schema/контракта/helper. Проверки используют настоящий Unix socket и синтетические настройки; боевую установку не выполняют.
