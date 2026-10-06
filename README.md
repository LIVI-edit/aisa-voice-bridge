# AISA Voice Bridge — технический MVP

Один вручную запущенный исходящий звонок: Zadarma → Asterisk 20.6 → локальный Node.js → GPT-Live WebSocket. В Node.js звук остаётся G.711 μ-law, 8000 Гц. Базы данных и отдельные сервисы не нужны.

**Статус:** исходники и локальные проверки готовы. Реальный звонок не выполнялся. Успешный двусторонний разговор нужно подтвердить на существующем VPS.

## 1. Установка исходников

Нужен уже установленный Node.js **22 или новее**, npm и работающий Asterisk 20.6. Команды ниже выполняет владелец VPS. Node.js можно установить из официального дистрибутива: https://nodejs.org/en/download.

```bash
unzip AISA_VOICE_BRIDGE_MVP_2026-10-06.zip
cd aisa-voice-bridge
node --version
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

`npm test` использует только локальные заглушки и не совершает звонков. `node_modules` в архив не включён; для установки нужен доступ к npm registry. Зафиксированные версии: dotenv 16.6.1, ws 8.22.0.

## 2. Включение локального ARI

Сначала сохраните существующие настройки, если эти файлы существуют:

```bash
sudo cp -a /etc/asterisk/http.conf /etc/asterisk/http.conf.before-aisa-mvp
sudo cp -a /etc/asterisk/ari.conf /etc/asterisk/ari.conf.before-aisa-mvp
```

Откройте их для редактирования:

```bash
sudo nano /etc/asterisk/http.conf
sudo nano /etc/asterisk/ari.conf
```

Объедините текущие настройки с `deploy/asterisk/http.conf.example` и `ari.conf.example`. **Не копируйте примеры поверх существующих файлов целиком и не создавайте вторую секцию `[general]`.** В `http.conf` должны быть:

```ini
[general]
enabled=yes
bindaddr=127.0.0.1
bindport=8088
```

В существующей секции `[general]` файла `ari.conf` включите `enabled=yes`; добавьте отдельного пользователя:

```ini
[aisa_bridge]
type=user
read_only=no
password=REPLACE_WITH_LOCAL_ARI_PASSWORD
```

Замените placeholder своим длинным паролем. Например, локально создайте его командой `openssl rand -hex 24`; используйте один и тот же пароль здесь и в `.env`. Это пароль ARI, **не пароль Zadarma**.

Перечитать настройки и проверить доступ:

```bash
sudo asterisk -rx 'core reload'
sudo asterisk -rx 'http show status'
sudo asterisk -rx 'module show like res_ari'
sudo asterisk -rx 'module show like res_http_websocket'
sudo asterisk -rx 'module show like chan_rtp'
sudo asterisk -rx 'module show like res_stasis'
sudo asterisk -rx 'module show like bridge_simple'
sudo asterisk -rx 'pjsip show registrations'
ss -ltn '( sport = :8088 )'
curl --fail --silent --show-error --user aisa_bridge http://127.0.0.1:8088/ari/asterisk/info
```

`curl` спросит пароль интерактивно. HTTP должен слушать **127.0.0.1:8088**, а регистрация Zadarma оставаться `Registered`. Для REST нужны в том числе `res_ari_channels`, `res_ari_bridges`, `res_ari_asterisk`, для событий — `res_ari_events`. Если нужные модули отсутствуют, сначала устраните это в установленном Asterisk. Не продолжайте звонок при недоступном ARI.

Не открывайте порт 8088 в интернет. Этот код не использует dialplan для исходящего звонка: канал отправляется прямо в ARI-приложение. `pjsip.conf`, маршрут Zadarma и SIP-пароль менять не требуется.

## 3. Настройка `.env`

Из папки проекта:

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Заполните:

```dotenv
OPENAI_API_KEY=YOUR_OWN_OPENAI_API_KEY
ASTERISK_ARI_URL=http://127.0.0.1:8088/ari
ASTERISK_ARI_USER=aisa_bridge
ASTERISK_ARI_PASSWORD=YOUR_LOCAL_ARI_PASSWORD
ZADARMA_ENDPOINT=220546
RTP_BIND_ADDRESS=127.0.0.1
RTP_PAYLOAD_TYPE=0
```

`OPENAI_VOICE` и `OPENAI_INSTRUCTIONS` необязательны. Пустые значения используют голос по умолчанию и тестовый prompt из задания. Реальных секретов в поставке нет; `.env` исключён из git.

`RTP_PAYLOAD_TYPE` задаёт только принимаемый PT. Для Asterisk `format=ulaw` оставьте **0**. Исходящий RTP всегда имеет PT=0. Dynamic PT 96–127 допустим в parser как явный входной override; эта настройка не меняет кодек и не настраивает mapping в Asterisk.

## 4. Первый реальный тест — только вручную на VPS

Следующая команда **совершает звонок**. Замените пример на свой полный номер:

```bash
node src/index.js +380XXXXXXXXX
```

Программа сначала подключит ARI и GPT-Live, дождётся подтверждения PCMU, затем создаст `PJSIP/<NUMBER_WITHOUT_PLUS>@220546`. CLI по-прежнему требует номер с `+`: для `+380991234567` только SIP-маршрут нормализуется в `PJSIP/380991234567@220546`. Ожидание ответа — 45 секунд. После ответа создаст bridge и ExternalMedia, прочитает адрес и порт RTP из переменных канала и включит передачу звука.

Поднимите трубку. Дождитесь сообщения «Двусторонняя передача PCMU включена». Должно прозвучать короткое приветствие; скажите «Привет, ты меня слышишь?» и проведите короткий разговор. Приветствие после ответа запрашивается через `session.instructions.append`: точное время начала речи определяется моделью. Если она молчит, произнесите приветствие сами и проверьте ответ.

Аудио, полученное до готовности телефонного канала, отбрасывается. Оно не копится во время гудков и не воспроизводится с задержкой после ответа. Голосовое приветствие запрашивается повторно после подключения медиа.

Завершите звонок телефоном либо нажмите `Ctrl+C`. Дождитесь завершения процесса: закрытие OpenAI может занимать до 15 секунд. Код возврата 0 означает штатное завершение; 1 — ошибку, неотвеченный/ранний сброшенный вызов либо неподтверждённое завершение OpenAI.

## 5. Что проверить на VPS

1. Реально ли создаётся исходящий вызов и приходит состояние `Up`.
2. Передаётся ли голос в обе стороны, нет ли шума, эха или большой задержки.
3. Приходит ли от Asterisk RTP с PT=0; растут ли счётчики принятых пакетов после разговора.
4. Соответствует ли реальный RTP source адресу/порту, возвращённым ExternalMedia. Код принимает звук только от этого endpoint.
5. Закрываются ли звонок, ExternalMedia, bridge и OpenAI при сбросе телефона, `Ctrl+C` и обрыве OpenAI.
6. Умеет ли существующий Zadarma endpoint согласовать μ-law. Node.js ничего не перекодирует; если телефонная сторона согласовала другой кодек, Asterisk может сам преобразовывать его в `ulaw`. Полное отсутствие преобразования по всей телефонной цепочке требует проверки согласованного кодека. Программа не меняет `pjsip.conf`.

Для просмотра созданных ресурсов, в другом терминале:

```bash
sudo asterisk -rx 'core show channels concise'
sudo asterisk -rx 'bridge show all'
```

При отказе ARI во время cleanup программа напечатает ID ресурса, который не удалось удалить. Если он остался, удалить можно вручную, используя **только ID из этого запуска**:

```bash
curl --fail --user aisa_bridge -X DELETE http://127.0.0.1:8088/ari/channels/CHANNEL_ID_FROM_LOG
curl --fail --user aisa_bridge -X DELETE http://127.0.0.1:8088/ari/bridges/BRIDGE_ID_FROM_LOG
```

Нельзя удалять чужие активные каналы/bridges. `SIGKILL` и аварийное выключение VPS не позволяют Node.js выполнить cleanup.

## Ограничения

Один звонок на запуск, без автоповторов и восстановления соединения. Нет записи аудио, базы данных, UI, HubSpot или бизнес-логики AISA. Для теста запускайте только один экземпляр. После обычного запуска разговор длится до сброса/остановки; отдельный лимит длительности не добавлен.

В памяти допускается до 2 секунд аудио OpenAI. Переполнение завершает звонок с ошибкой. Выход идёт по одному кадру 160 байт примерно раз в 20 мс; при нехватке аудио отправляется μ-law тишина `0xff`. Задержка event loop не вызывает burst. Неполный хвост обычно переходит в следующий chunk; после паузы 60 мс дополняется тишиной. Это ограниченная буферизация MVP, без компенсации сетевого jitter. Повторные и старые входящие RTP отбрасываются.

## Проверенные контракты, 2026-10-06

- GPT-Live WebSocket: https://developers.openai.com/api/docs/guides/voice-websockets
- Live events/schema: https://developers.openai.com/api/reference/typescript/resources/live
- ExternalMedia: https://docs.asterisk.org/Development/Reference-Information/Asterisk-Framework-and-API-Examples/External-Media-and-ARI/
- Точный Asterisk 20.6.0 channels API: https://github.com/asterisk/asterisk/blob/20.6.0/rest-api/api-docs/channels.json
- Точный Asterisk 20.6.0 bridges API: https://github.com/asterisk/asterisk/blob/20.6.0/rest-api/api-docs/bridges.json

Автоматической замены модели, WebSocket API или архитектуры нет. Несовпадение подтверждённой модели/формата либо некорректный RTP endpoint приводят к STOP/HOLD и очистке ресурсов.
