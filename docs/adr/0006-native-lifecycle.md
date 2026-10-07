# 0006 — Native enable/disable через отдельную задачу

Статус: принято для экспериментального dev.8. Контракт descriptor v1 не меняется.

## Решение

Panels централизованно предлагает enable/disable уже установленных trusted плагинов после явного opt-in оператора. Превью TTL15мин закрепляет name/enabled/trust/source/SHA/digest/назначенные units. UUID предложения сохраняется в приватном screen view; callback содержит индекс. Self-disable блокируется, install/update/remove/trust не добавляются.

Confirm сохраняет queued до передачи единственной systemd unit. Worker повторно проверяет предложение, сохраняет running и вызывает штатный CLI массивом аргументов. Native CLI сам меняет реестр/службы/сборку. Задача отделена от Eve/Router, Restart=no, предел900сек, CLI600сек. Ни неизвестный запуск, ни crash running, ни delivery retry не повторяют команду. queued/running требуют проверки оператора; только читаемая Последняя задача доступна из нового экрана.

Done требует exit0, target flag/trust/pin/source, ActiveState назначенных services/MCP, health Eve и смену CLI realpath при наличии mcp/extension. Неполный результат uncertain; автоматического обратного enable/disable нет. Лимит100 сохранённых jobs обслуживает оператор, сохраняя незавершённые.

## Последствия

Право управления расширяет доступ Panels к штатным данным/CLI Ивы. Trusted Bridge остаётся границей подтверждения, независимая rawtap аутентификация не добавляется. Внешние descriptor не могут вызывать lifecycle. Native manager не предоставляет CAS между snapshot и своим lock, поэтому внешние команды могут гоняться с запросом. Наличие mcp.json консервативно требует смены версии даже для пустого MCP; отсутствие такой смены оставляет uncertain. После disabled descriptor/адаптер не исполняется; базовая карточка и Management остаются. Дополнительный плагин автоматически получает эти кнопки без интеграционного кода, если удовлетворяет условиям регистрации.

## Проверки

Unit regression и реальные дочерние синтетические CLI; isolated stock native commands обеих версий с заменой build/systemd/health; stock Bridge preview/cancel. Production toggle, настоящая сборка и аварийное восстановление требуют отдельного подтверждения и не считаются пройденными из результата этих тестов.
