# PATCH_REPORT — AISA Voice Bridge MVP / narrow repair

Дата: 2026-10-06. Статус: **LOCAL TESTS PASSED / VPS CALL NOT VERIFIED**.

База: только `AISA_VOICE_BRIDGE_MVP_2026-10-06.zip`.
SHA-256 исходного архива: `dae6be2f653847a7fe170fa6cc793c763370870d37b6b37f8ef04661e0f3a766`.

## Две исправленные проблемы

1. `greet()` теперь отправляет `session.instructions.append` с явным `delegation_id: null`. Текст приветствия сохранён точно. Тест сравнивает полный payload: `type`, `delegation_id`, `content`.
2. CLI сохраняет номер `+380991234567` и прежнюю строгую валидацию. Отдельная функция `normalizeZadarmaNumber()` проверяет номер через существующий `validateNumber()` и удаляет только начальный `+`. Нормализация выполняется один раз при создании CallSession; SIP endpoint теперь `PJSIP/380991234567@220546`.

## Изменённые файлы

- `src/openai-live.js` — одно добавленное поле события приветствия.
- `src/config.js` — функция нормализации; `validateNumber()` и environment schema не изменены.
- `src/call-session.js` — отдельный внутренний номер и его использование в SIP endpoint.
- `test/openai-live.test.js` — точная проверка полного greeting payload.
- `test/call-session.test.js` — маршрут без `+`, сохранение внешнего номера с `+`.
- `test/config.test.js` — две новые проверки нормализации и сохранения строгого формата CLI.
- `README.md` — уточнение формата SIP-маршрута, команда запуска сохранена.
- `PATCH_REPORT.md`, `TEST_RESULTS.txt` — отчёт и результаты этой правки.

## Тесты и границы

Полный существующий suite: **45/45 passed**, ошибок/пропусков нет. Сохранены все 43 прежние проверки, добавлены 2. Среда: Node.js v24.19.0. Полный вывод — `TEST_RESULTS.txt`.

Сравнение файлов с исходным ZIP подтвердило неизменность RTP parser/packetizer, audio queue/pacing, ARI и CLI entry point. В `call-session.js` изменены только import функции нормализации, отдельное поле номера и строка endpoint; ExternalMedia и cleanup lifecycle сохранены. Схема environment, PCMU 8000, конфигурационные snippets и зависимости не изменены; новых файлов/сервисов нет.

Контракт `session.instructions.append` проверен по официальной схеме: https://developers.openai.com/api/reference/typescript/resources/live — `delegation_id` required, nullable; для общей инструкции используется null. Противоречий с API или заданной архитектурой не обнаружено.

**Реальный VPS / Zadarma / GPT-Live звонок ещё не выполнялся.** Подключений к VPS, деплоя, использования пользовательских ключей и изменений `pjsip.conf` не было. Исправления проверены локально; фактический двусторонний разговор проверяется отдельным ручным звонком на VPS.
