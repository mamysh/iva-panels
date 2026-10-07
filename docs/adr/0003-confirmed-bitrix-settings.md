# ADR 0003: подтверждаемое изменение настроек Bitrix24

Дата: 2026-10-07. Статус: принято по поручению владельца после подтверждения rich-меню.

Редактор локальной политики включается отдельно, по умолчанию выключен. Политику сохраняет existing bitrix24_settings через revision-bound prepare и UUID confirm/cancel. Никаких действий с порталными задачами/файлами, arbitrary tool/reply или прямого редактирования Bitrix settings file.

Действие связано с owner/chat/message/revision/TTL на доверенном Bridge. Эта граница не является independent raw tap verification; владелец общего секрета обладает существенными полномочиями. Prepared reply token хранится в приватном view, в Telegram callback уходит только индекс.

Для сбоев engine сохраняет acting перед возможным эффектом. Повтор editing доставляет сохранённое представление; acting после crash читает текущую политику и показывает неизвестный результат без повторения mutation. Точно однократное сохранение не обещается: источник окончательной правды — settings Bitrix. Цена: новый state phase, управляемый downgrade, возможный stale policy lock и конкуренция за одно global offer с другими экранами.
