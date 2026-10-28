# 0012. Первая установка через штатное согласие и плагинный bootstrap

Кандидат0.4.0-rc.1, без изменения ядра.

До установки Panels ещё не обслуживает чат, поэтому согласие принимает штатный
`plugin propose` Ивы. Публичный пакет содержит готовый install.mjs: read-only plan
и propose. Пакет нельзя считать установленным после отправки предложения.
Unknown send не повторяется: приватный маркер сохраняется до вызова native CLI.

Первый запуск **установленной, включённой и доверенной** службы проверяет exact
менеджер0.5.7/ae313753a1ae и12source pins:10прежних manager плюс poller config/entry.
Проверяются current/data layout, один owner, локальный origin, исходное соединение,
штатный user unit и отсутствие drop-in. Новый порт назначает менеджер Ивы.
Существующий config без setup journal означает ручную установку; он не меняется.

Конфиг берётся из приватного локального env, без model output. По умолчанию
classic buttons/dynamic API; legacy Bitrix adapter и lifecycle не включаются.
Bootstrap меняет только собственный config/journal и отдельный drop-in user Bridge.
ExecStart использует Node из актуального PATH, current-relative poller entry и
явный ASSISTANT_HOST через env; исходный unit и .env не переписываются.

Перед записью маршрута сохраняется intent и запускается независимый120s timer.
Recovery bundle копируется в данные плагина; timer и foreground используют один
Linux flock. Применяются atomic/exclusive файлы0600 и fsync. После restart Bridge
проверяются его состояние/ExecStart, исходный Eve и health через Router.
Connected записывается до остановки timer; запоздалый timer ничего не делает.

Crash в routing на следующем старте вызывает rollback, а не повтор подключения.
Удаляется только собственный drop-in с ожидаемым хешем. Чужое изменение или ошибка
reload/restart даёт uncertain. Без user manager/ядра ОС timer не является HA;
восстановление после reboot опирается на durable journal.

После connected фиксируется attempted уведомления. Engine.issue сохраняет свой
send intent и показывает привязанную welcome-карточку. Неизвестная доставка не
повторяется после рестарта. Начальная карточка не доказывает реальный бизнес-flow.

Снимок не является полным backup Ивы: до установки маршрут состоит из сохранённого
native unit/.env, которые мастер не меняет; его собственное переопределение
удаляется при откате. Данные плагинов и registry назад не восстанавливаются.
Не гарантируется CAS с параллельным внешним администратором: стороннее изменение
останавливает автоматическое восстановление для ручной сверки.

Проверки: state-machine failure/crash/fencing, реальные файлы и flock; отдельный
Linux smoke со штатным propose/install-proposal, установленными bundles и HTTP.
Systemd и Telegram в этом smoke заменены. Приёмка новой Ивы/настоящего Telegram
с настоящей кнопкой владельца выполняется отдельно до объявления stable.
