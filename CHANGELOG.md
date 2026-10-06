# История изменений

## 0.1.0-dev.2 — Unreleased

- Исправлена потеря обычного текста в collector пачке рядом с `/panels`: собственные части отделяются от обычных, сохраняется queue receipt и пересчитывается Content-Length.
- Идемпотентность переживает regroup и сдвиг индекса после частичного ack. Dev.1 state читается, новые batch keys несовместимы с обратным запуском dev.1.
- Интеграционная проверка штатных модулей Bridge на закреплённых 0.4.11/0.4.12 с отдельным процессом собранного сервиса, busy queue, retry и restart. Telegram и Eve синтетические.
- Linux launcher выполняет Node без промежуточного fork, сохраняет kernel lock и корректно принимает SIGTERM.

Рабочая установка и ручной Telegram smoke не выполнены.

## 0.1.0-dev.1 — экспериментальный первый этап

- Начальный отдельный service plugin iva-panels; режим passthrough по умолчанию.
- Read-only карточки регистрации Bitrix24 и file-delivery, команда `/panels`, возврат, обновление и закрытие в одном сообщении.
- Persistent screen state, owner/chat/message/revision/TTL checks, delivery-only edit retry и отказ от повторной неоднозначной отправки.
- HTTP forwarding с acceptance receipt для собственных событий, воспроизводимый standalone bundle, синтетические регрессионные тесты и приватность поставки.

Не выпущен и не установлен; полный штатный Bridge, Linux service lifecycle и живой Telegram не проверены.
