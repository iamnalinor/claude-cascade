# Happ Cascade

Одна подписка для Happ и Throne объединяет серверы из двух исходных подписок. Cloudflare Worker скачивает списки и собирает Xray JSON. VPN-трафик обрабатывает Xray на устройстве.

```text
Обычный запрос     устройство → выбранный узел
Российский адрес   устройство → сайт
Целевой запрос     устройство → выбранный узел → EXIT2 → сайт
```

## Как устроен каскад

1. При обновлении Happ или Throne запрашивает подписку у Worker на `workers.dev`. Worker обращается к провайдерам, собирает конфиги и отправляет их приложению.
2. Когда запрос совпал с целевым правилом, Xray на устройстве выбирает `EXIT2`. В его `sockopt.dialerProxy` записан тег первого узла. Устройство открывает сетевое соединение к первому узлу, а рукопожатие с `EXIT2` передаёт внутри этого соединения.
3. Первый узел открывает соединение к `EXIT2` со своей выходной стороны. При исправном каскаде `EXIT2` видит IP первого хопа, а сайт видит IP `EXIT2`. Страна первого хопа зависит от выбранного узла и сети провайдера.
4. Если первый узел или `EXIT2` недоступен, запрос по целевому правилу падает. В сгенерированном профиле для этого маршрута есть один выход и одна цепочка. [Sockopt в Xray](https://xtls.github.io/en/config/transports/sockopt.html)

## Куда идёт трафик

| Назначение | Маршрут |
| --- | --- |
| `anthropic.com` и его поддомены | Через `EXIT2` |
| `claude.ai` и его поддомены | Через `EXIT2` |
| `claude.com` и его поддомены | Через `EXIT2` |
| `claude.app` и его поддомены | Через `EXIT2` |
| `claudeusercontent.com` и его поддомены | Через `EXIT2` |
| `claudemcpcontent.com` и его поддомены | Через `EXIT2` |
| `withpersona.com` и его поддомены | Через `EXIT2` |
| Ровно `ip.net.coffee` | Через `EXIT2`. Показывает его IP |
| `.ru`, `.su`, `.рф`, `geosite:category-ru`, IP из `geoip:ru` | Напрямую |
| Остальное | Маршруты исходного Xray JSON. Для списков ссылок по умолчанию используется выбранный узел |

Xray применяет правила сверху вниз. Целевые домены и `ip.net.coffee` имеют приоритет над RU и правилами провайдера. В профиле с несколькими выходами каскад использует первый выход из исходного конфига или выход, выбранный параметром `mainTag` в настройках источника. Остальные запросы могут идти через исходный балансировщик. [Код маршрутов](src/routing.ts) · [Маршрутизация Xray](https://xtls.github.io/en/config/routing.html)

Режим `IPOnDemand` позволяет проверить `geoip:ru` до правил провайдера. Для доменов, которые не совпали с более ранними правилами, Xray может запросить DNS уже на этом шаге, используя DNS-настройки профиля. Из-за этого среди следующих правил провайдера может совпасть IP-правило, которое раньше пропускалось в режимах `AsIs` или `IPIfNonMatch`.

Последний профиль **Все → EXIT2** отправляет зарубежный трафик через один EXIT2. Xray проверяет полные каскады с доступными узлами обеих подписок запросами к `https://www.gstatic.com/generate_204` и выбирает рабочий маршрут с наименьшей измеренной задержкой. Российский трафик идёт напрямую по тем же правилам. Пока нет успешного замера или все каскады недоступны, зарубежные соединения блокируются. [Проверки доступности Xray](https://xtls.github.io/en/config/observatory.html)

### Что происходит при сбое

| Ситуация | Что увидишь |
| --- | --- |
| `EXIT2` выключен, порт закрыт или REALITY не проходит | **Запрос к совпавшему домену завершается ошибкой или тайм-аутом.** Правило выбирает один выход. Он не переключается на прямое соединение или на первый VPN. Сайты с другими маршрутами продолжают работать |
| Выбранный первый узел недоступен | Каскад через него тоже падает. Можно выбрать другой профиль и проверить снова |
| Приложение передало Xray только IP и имя нельзя получить из DNS, SNI или HTTP | Доменное правило не срабатывает. Xray выбирает маршрут по IP и остальным правилам |
| Один источник отказал или вернул неподдерживаемый формат | Worker отдаёт профили рабочих источников. Число отказов и отклонённых профилей видно в заголовках `x-subscription-*` |
| Профиль провайдера открывает слушатель за пределами loopback или включает служебный API Xray | Worker отклоняет профиль. Для обычного клиентского прокси без явного `listen` Worker указывает `127.0.0.1` |
| Оба источника отказали или Worker недоступен | Обновление подписки падает. Уже загруженный конфиг работает на устройстве независимо от Worker, пока доступны нужные узлы |
| У провайдера исчерпан лимит устройств | Happ должен отправить собственный `x-hwid`. Worker передаёт его провайдеру без подмены. Регистрация нового устройства и освобождение слота происходят у провайдера |

## Быстрый тест существующего Worker

1. Импортируй закрытый URL из `.local/subscription-url.txt` или обнови существующую подписку в приложении. Открытый `/health` проверяет только Worker.
2. Подключись к одному узлу. Открой [ip.net.coffee](https://ip.net.coffee/) или запроси тот же хост напрямую из терминала с настроенным прокси приложения.

   ```sh
   curl -fsS --socks5-hostname 127.0.0.1:10808 https://ip.net.coffee/cdn-cgi/trace |
     awk -F= '$1 == "ip" { print $2 }'
   ```

3. Сверь `ip=` с публичным исходящим IP `EXIT2`. Для проверки отказа временно останови **свою тестовую** службу `happ-exit`. Запрос к `ip.net.coffee` и целевые запросы должны падать. После проверки запусти службу снова.

Throne отображает полные каскадные профили как `Custom Xray Config` и оставляет свою колонку `Address` пустой. Worker сохраняет исходные названия серверов в Throne и Happ. Worker отдаёт совместимый формат XDNS для Throne 1.2.4 с Xray 26.7.28 и Happ Android 4.8.0 с Xray 26.9.9.

Из полного JSON Worker принимает локальные слушатели SOCKS, HTTP, `mixed`, `dokodemo-door` и `tunnel` с обычным входящим транспортом. Созданием системного VPN-интерфейса занимается приложение. Настройки журнала провайдера удаляются, чтобы подписка не могла указать путь для записи на устройстве.

## Как получить и заменить конфиг EXIT2

`EXIT_OUTBOUND` хранится в **Cloudflare → Workers & Pages → happ-cascade → Settings → Variables and Secrets**. Значение — один клиентский Xray outbound с `protocol: "vless"`, адресом и портом, UUID и параметрами TLS или REALITY. Для второго хопа используется транспорт RAW (`raw` или `tcp`) с проверкой сервера. Для первого хопа действуют транспортные настройки провайдера. Клиентский outbound — это один объект из массива `outbounds`. Ansible формирует серверный конфиг на VPS, приватный ключ REALITY остаётся на VPS.

### Вариант A. Развернуть свой VPS

Нужен SSH-пользователь с `sudo`, Debian 12/13 или Ubuntu 24.04/26.04 с systemd, amd64 или arm64. Укажи свободный TCP-порт. Для REALITY по умолчанию используется 443. Убедись, что входящий порт доступен. Если используешь DNS для ноды, запись должна вести прямо на VPS.

```sh
cp ansible/inventory.example.yml ansible/inventory.yml
# Заполни SSH-хост, пользователя, exit_address, порт и параметры TLS-цели.
ansible-playbook -i ansible/inventory.yml ansible/exit.yml --tags preflight
ansible-playbook -i ansible/inventory.yml ansible/exit.yml
```

`reality_target_host` — отдельный HTTPS-хост, доступный с VPS. Он должен обслуживать `reality_server_name` с TLS 1.3 и ALPN `h2`. Плейбук проверяет это перед установкой. Он скачивает зафиксированный релиз Xray, сверяет SHA-256, проверяет конфиг и запускает `happ-exit`. При необходимости на маленьком VPS добавь `exit_memory_max` и `exit_cpu_quota` в inventory. Эти параметры ограничивают только службу выхода.

Для хоста с именем `exit2` плейбук сохранит готовый клиентский конфиг в **`.local/exit2-outbound.json`**. В нём есть данные для подключения, включая UUID. Файл игнорируется Git. [Пример inventory](ansible/inventory.example.yml) · [Параметры REALITY](https://xtls.github.io/en/config/transports/reality.html)

### Вариант B. Использовать готовый узел

- Для узла из Throne запусти `bun --no-env-file scripts/throne.ts`. Скрипт читает две активные подписки этой установки и сохраняет отдельный подходящий VLESS в `.local/staging-outbound.json`.
- Если у тебя уже есть клиентский outbound, положи его в `.local/exit2-outbound.json`.
- Если есть только ссылка `vless://…`, положи её одной строкой в `.local/exit2-link.txt`. Скрипт сам соберёт outbound для поддерживаемой ссылки.

### Загрузить в Worker

```sh
bun install --frozen-lockfile
bun --no-env-file scripts/throne.ts
bun --no-env-file scripts/prepare-secrets.ts .local/exit2-outbound.json
bun run deploy --secrets-file .local/worker-secrets.json
```

Подставь путь к своему файлу из выбранного варианта. Подготовка сохраняет прежний токен, поэтому существующий URL для Happ продолжает работать после обновления подписки.

Для замены только выхода через Dashboard открой **Variables and Secrets → EXIT_OUTBOUND → Edit**, вставь содержимое клиентского JSON и сохрани. Затем обнови подписку в Happ или Throne. Если у тебя ссылка `vless://`, используй скрипт выше для её преобразования.

Для ручного деплоя в `.env` нужны `CLOUDFLARE_ACCOUNT_ID` и `CLOUDFLARE_API_TOKEN` с доступом на запись в Workers Scripts. Можно войти через `bunx --no-install wrangler login`. Для Wrangler нужен Node.js 22+ в `PATH`. Значения `UPSTREAM_A`, `UPSTREAM_B`, `EXIT_OUTBOUND` и `SUB_ACCESS_TOKEN` загружаются как секреты Cloudflare. [Права Workers](https://developers.cloudflare.com/workers/authorization/workers/)

При первой настройке получить ссылку можно локально. Подставь адрес из **Settings → Domains & Routes**.

```sh
WORKER_ORIGIN=https://happ-cascade.YOUR-SUBDOMAIN.workers.dev \
bun --no-env-file -e '
const { SUB_ACCESS_TOKEN } = await Bun.file(".local/worker-secrets.json").json();
console.log(new URL("/sub/" + SUB_ACCESS_TOKEN, process.env.WORKER_ORIGIN).href);
'
```

## CI и автодеплой

GitHub Actions запускает `bun lint` на PR и push в `main`. Публикация выполняется через **Cloudflare Workers Builds** в настройках существующего Worker.

| Поле Cloudflare | Значение |
| --- | --- |
| Git repository | `iamnalinor/happ-cascade` |
| Production branch | `main` |
| Root directory | `/` |
| Build command | `bun install --frozen-lockfile && bun lint` |
| Deploy command | `bun run deploy` |
| Preview builds | Выключены |

Если репозиторий ещё не подключён, открой **Workers & Pages → happ-cascade → Settings → Builds → Connect** и выбери его в GitHub. Действующие runtime secrets уже находятся в настройках Worker и используются при автодеплое. Cloudflare берёт версию Bun из `packageManager` в `package.json`. Для Wrangler подходит Node.js из стандартного образа Workers Builds. [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) · [Версии инструментов в образе](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)

## Проверки и откат

```sh
bun lint
bun test
bun run build
XRAY_BIN=xray python3 tests/check-cascade.py
bun --no-env-file scripts/throne.ts --worker https://happ-cascade.YOUR-SUBDOMAIN.workers.dev
XRAY_BIN=xray bun run check:xray .local/worker-smoke.json
```

Для отката на прежний выход снова загрузи его клиентский outbound командой `prepare-secrets.ts` и выполни `bun run deploy --secrets-file .local/worker-secrets.json`. Затем обнови подписку в приложении. Код Worker отдельно откатывается через **Deployments** в Cloudflare. Чтобы быстро вернуть старое поведение на устройстве, переключись на исходную подписку.
