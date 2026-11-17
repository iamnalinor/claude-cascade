# Claude Cascade

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
| `yoti.com` и его поддомены | Через `EXIT2` |
| `arkoselabs.com` и его поддомены | Через `EXIT2` |
| `workos.com` и его поддомены | Через `EXIT2` |
| `sift.com` и его поддомены | Через `EXIT2` |
| `siftscience.com` и его поддомены | Через `EXIT2` |
| Ровно `ip.net.coffee` | Через `EXIT2`. Показывает его IP |
| Входящие сети Anthropic `160.79.104.0/23`, `153.61.224.0/22`, `2607:6bc0::/48` | Через `EXIT2`, даже если в соединении нет имени хоста |
| `.ru`, `.su`, `.рф`, `geosite:category-ru`, IP из `geoip:ru` | Напрямую |
| Остальные соединения на `3478` и `5349` по TCP или UDP | Через `EXIT2`. Это стандартные порты STUN/TURN |
| Остальное | Маршруты исходного Xray JSON. Для списков ссылок по умолчанию используется выбранный узел |

Xray применяет правила сверху вниз. Целевые домены и `ip.net.coffee` имеют приоритет над RU и правилами провайдера. В профиле с несколькими выходами каскад использует первый выход из исходного конфига или выход, выбранный параметром `mainTag` в настройках источника. Остальные запросы могут идти через исходный балансировщик. [Код маршрутов](src/routing.ts) · [Маршрутизация Xray](https://xtls.github.io/en/config/routing.html)

При `IPOnDemand` Xray может разрешить домен при проверке входящих сетей Anthropic или `geoip:ru`. В профилях без DNS-настроек провайдера собственные запросы Xray идут к `1.1.1.1` по HTTPS через выбранный первый узел. В профиле **Все → EXIT2** резолвер доступен через рабочий каскад. Если провайдер задал DNS, Worker сохраняет его настройки. DNS браузера и системы зависит от того, как Happ или Throne перехватывает трафик. [DNS Xray](https://xtls.github.io/en/config/dns.html) · [Сети Anthropic](https://platform.claude.com/docs/en/api/ip-addresses)

Последний профиль **Все → EXIT2** отправляет зарубежный трафик через один EXIT2. Xray проверяет полные каскады с доступными узлами обеих подписок запросами к `https://www.gstatic.com/generate_204` и выбирает рабочий маршрут с наименьшей измеренной задержкой. Российский трафик идёт напрямую по тем же правилам. Пока нет успешного замера или все каскады недоступны, зарубежные соединения блокируются. [Проверки доступности Xray](https://xtls.github.io/en/config/observatory.html)

### Что происходит при сбое

| Ситуация | Что увидишь |
| --- | --- |
| `EXIT2` недоступен или первый VPN не пропускает его транспорт | **Запрос к совпавшему домену завершается ошибкой или тайм-аутом.** Правило выбирает один выход. Он не переключается на прямое соединение или на первый VPN. Сайты с другими маршрутами продолжают работать |
| Выбранный первый узел недоступен | Каскад через него тоже падает. Можно выбрать другой профиль и проверить снова |
| Приложение передало только IP или TLS/QUIC скрыли настоящее имя | Входящие сети Anthropic всё равно идут через `EXIT2`. Адреса общих CDN и внешних сервисов вне доменных и IP-правил обрабатываются по обычному маршруту |
| WebRTC выбрал нестандартный порт или приложение обходит VPN | Стандартные порты STUN/TURN и трафик из доменного списка покрыты в Xray. Для других зарубежных адресов в туннеле подходит **Все → EXIT2**. Захват IPv6 и трафика приложений настраивается в клиенте |
| Один источник отказал или вернул неподдерживаемый формат | Worker отдаёт профили рабочих источников. Число отказов и отклонённых профилей видно в заголовках `x-subscription-*` |
| Провайдер использует устаревший `proxySettings` | Worker преобразует транспортный вариант в `sockopt.dialerProxy`. Throne 1.2.4 сохраняет поддержку остальных вариантов. В Happ профили с такими цепочками пропускаются, а совместимые узлы из тех же профилей остаются в `Все → EXIT2` |
| Профиль провайдера открывает слушатель за пределами loopback или включает служебный API Xray | Worker отклоняет профиль. Для обычного клиентского прокси без явного `listen` Worker указывает `127.0.0.1` |
| Оба источника отказали или Worker недоступен | Обновление подписки падает. Уже загруженный конфиг работает на устройстве независимо от Worker, пока доступны нужные узлы |
| У провайдера исчерпан лимит устройств | Happ должен отправить собственный `x-hwid`. Worker передаёт его провайдеру без подмены. Регистрация нового устройства и освобождение слота происходят у провайдера |

## Быстрый тест существующего Worker

1. Импортируй закрытый URL из `.local/subscription-url.txt` или обнови существующую подписку в приложении. Открытый `/health` проверяет только Worker.
2. Подключись к одному узлу и открой [ip.net.coffee/cdn-cgi/trace](https://ip.net.coffee/cdn-cgi/trace) или запроси этот адрес из терминала с настроенным прокси приложения. Строка `ip=` показывает, какой адрес видит сам Net.Coffee. Карточки на странице проверки Claude делают отдельные запросы к другим хостам.

   ```sh
   curl -fsS --socks5-hostname 127.0.0.1:10808 https://ip.net.coffee/cdn-cgi/trace |
     awk -F= '$1 == "ip" { print $2 }'
   ```

3. Сверь `ip=` с публичным исходящим IP `EXIT2`. Для проверки отказа временно останови **свою тестовую** службу `happ-exit`. Запрос к `ip.net.coffee` и целевые запросы должны падать. После проверки запусти службу снова.

Throne отображает полные каскадные профили как `Custom Xray Config` и оставляет свою колонку `Address` пустой. Worker сохраняет исходные названия серверов в Throne и Happ. Worker отдаёт совместимый формат XDNS для Throne 1.2.4 с Xray 26.7.28 и Happ Android 4.8.0 с Xray 26.9.9.

Из полного JSON Worker принимает локальные слушатели SOCKS, HTTP, `mixed`, `dokodemo-door` и `tunnel` с обычным входящим транспортом. Созданием системного VPN-интерфейса занимается приложение. Настройки журнала провайдера удаляются, чтобы подписка не могла указать путь для записи на устройстве.

## Как получить и заменить конфиг EXIT2

`EXIT_OUTBOUND` хранится в **Cloudflare → Workers & Pages → claude-cascade → Settings → Variables and Secrets**. Значение — один клиентский объект из массива `outbounds` в Xray. Worker добавляет к нему `sockopt.dialerProxy` с тегом первого VPN.

| Протокол EXIT2 | Настройки |
| --- | --- |
| `vless` | RAW (`raw` или `tcp`) с TLS или REALITY |
| `hysteria` | Hysteria2 с TLS и без дополнительных настроек транспорта. Первый VPN должен пропускать UDP до EXIT2 |
| `http` | HTTP CONNECT, TCP. TLS поддерживается для HTTPS-прокси |
| `socks` | SOCKS5. Для UDP нужен SOCKS5-сервер с поддержкой UDP и первый VPN, который пропускает UDP |

HTTP и SOCKS5 без TLS передают данные авторизации открытым текстом на участке между первым VPN и EXIT2. Ansible формирует конфиг собственного VLESS-сервера на VPS. Приватный ключ REALITY остаётся на VPS.

### Вариант A. Развернуть свой VPS

Нужен SSH-пользователь с `sudo`, Debian 12/13 или Ubuntu 24.04/26.04 с systemd, amd64 или arm64. Укажи свободный TCP-порт. Для REALITY по умолчанию используется 443. Убедись, что входящий порт доступен. Если используешь DNS для ноды, запись должна вести прямо на VPS.

```sh
cp ansible/inventory.example.yml ansible/inventory.yml
# Заполни SSH-хост, пользователя, exit_address, порт и параметры TLS-цели.
ansible-playbook -i ansible/inventory.yml ansible/exit.yml --tags preflight
ansible-playbook -i ansible/inventory.yml ansible/exit.yml
```

`reality_target_host` — отдельный HTTPS-хост, доступный с VPS. Он должен обслуживать `reality_server_name` с TLS 1.3 и ALPN `h2`. Плейбук проверяет это перед установкой. Он скачивает зафиксированный релиз Xray, сверяет SHA-256, проверяет конфиг и запускает `happ-exit`. При необходимости на маленьком VPS добавь `exit_memory_max` и `exit_cpu_quota` в inventory. Эти параметры ограничивают только службу выхода.

Если первый провайдер подменяет адрес назначения по SNI, укажи в inventory `exit_security: tls` и публичный IPv4 в `exit_address`. Плейбук создаст сертификат для этого IP и добавит его в клиентский конфиг как единственный доверенный сертификат. TLS с IP-адресом не отправляет SNI. При замене сертификата заново загрузи экспортированный outbound в Worker. [Настройки TLS в Xray](https://xtls.github.io/en/config/transports/tls.html#tlsobject)

Для хоста с именем `exit2` плейбук сохранит готовый клиентский конфиг в **`.local/exit2-outbound.json`**. В нём есть данные для подключения, включая UUID. Файл игнорируется Git. [Пример inventory](ansible/inventory.example.yml) · [Параметры REALITY](https://xtls.github.io/en/config/transports/reality.html)

### Вариант B. Использовать готовый узел

- Для узла из Throne запусти `bun --no-env-file scripts/throne.ts`. Скрипт читает две активные подписки этой установки и сохраняет отдельный подходящий VLESS в `.local/staging-outbound.json`.
- Если у тебя уже есть клиентский outbound, положи его в `.local/exit2-outbound.json`.
- Если есть ссылка `vless://…` или URL HTTP, HTTPS либо SOCKS5, положи его одной строкой в `.local/exit2-link.txt`. Передай этот файл в `prepare-secrets.ts`. Формат URL с авторизацией — `http://user:password@proxy.example.com:8080`. Hysteria2 передаётся как Xray JSON.

### Если прокси EXIT2 принимает соединения только с одного IP

Укажи прокси в `EXIT_OUTBOUND` и выбери в Happ или Throne VPN-узел, который открывает соединения с разрешённого публичного IP. Проверь этот IP в исходном профиле VPN без каскада. Затем выбери тот же узел в подписке Cascade и открой `ip.net.coffee`. Теперь сайт должен показать выходной адрес прокси EXIT2.

Если VPN с разрешённым IP недоступен из твоей сети, можно собрать полный Xray-профиль с двумя VPN-выходами и отдать его Worker через приватную HTTPS-подписку. Задай выходу с разрешённым IP тег `allowed-egress`, а в его `streamSettings.sockopt.dialerProxy` укажи тег доступного входного VPN, например `entry`. Укажи `mainTag: "allowed-egress"` в записи этого источника в `SOURCES`. Worker добавит к выбранному выходу прокси из `EXIT_OUTBOUND`.

```text
устройство → входной VPN → VPN с разрешённым IP → EXIT2 → сайт
```

Можно скопировать текущий клиентский конфиг VPN в этот профиль и обновить копию вручную, если изменятся адрес, ключи или транспорт. У каждого выхода должен быть свой тег. Если входной VPN уже даёт нужный IP, достаточно одного VPN-хопа. [Цепочки Xray](https://xtls.github.io/en/config/transports/sockopt.html#dialerproxy)

### Загрузить в Worker

```sh
bun install --frozen-lockfile
bun --no-env-file scripts/throne.ts
bun --no-env-file scripts/prepare-secrets.ts .local/exit2-outbound.json
bun run deploy --secrets-file .local/worker-secrets.json
```

Подставь путь к своему файлу из выбранного варианта. Подготовка сохраняет прежний токен, поэтому существующий URL для Happ продолжает работать после обновления подписки.

Для замены только выхода через Dashboard открой **Variables and Secrets → EXIT_OUTBOUND → Edit**, вставь содержимое клиентского JSON и сохрани. Затем обнови подписку в Happ или Throne. Если у тебя URL прокси, используй скрипт выше для его преобразования.

Для ручного деплоя в `.env` нужны `CLOUDFLARE_ACCOUNT_ID` и `CLOUDFLARE_API_TOKEN` с доступом на запись в Workers Scripts. Можно войти через `bunx --no-install wrangler login`. Для Wrangler нужен Node.js 22+ в `PATH`. Значения `UPSTREAM_A`, `UPSTREAM_B`, `EXIT_OUTBOUND` и `SUB_ACCESS_TOKEN` загружаются как секреты Cloudflare. [Права Workers](https://developers.cloudflare.com/workers/authorization/workers/)

При первой настройке получить ссылку можно локально. Подставь адрес из **Settings → Domains & Routes**.

```sh
WORKER_ORIGIN=https://claude-cascade.YOUR-SUBDOMAIN.workers.dev \
bun --no-env-file -e '
const { SUB_ACCESS_TOKEN } = await Bun.file(".local/worker-secrets.json").json();
console.log(new URL("/sub/" + SUB_ACCESS_TOKEN, process.env.WORKER_ORIGIN).href);
'
```

## CI и автодеплой

GitHub Actions запускает `bun lint` на PR и push в `main`. Публикация выполняется через **Cloudflare Workers Builds** в настройках существующего Worker.

| Поле Cloudflare | Значение |
| --- | --- |
| Git repository | `iamnalinor/claude-cascade` |
| Production branch | `main` |
| Root directory | `/` |
| Build command | `bun install --frozen-lockfile && bun lint` |
| Deploy command | `bun run deploy` |
| Preview builds | Выключены |

Если репозиторий ещё не подключён, открой **Workers & Pages → claude-cascade → Settings → Builds → Connect** и выбери его в GitHub. Действующие runtime secrets находятся в настройках Worker и используются при автодеплое. Cloudflare берёт версию Bun из `packageManager` в `package.json`. Для Wrangler подходит Node.js из стандартного образа Workers Builds. [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) · [Версии инструментов в образе](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)

## Проверки и откат

```sh
bun lint
bun test
bun run build
XRAY_BIN=xray python3 tests/check-cascade.py
bun --no-env-file scripts/throne.ts --worker https://claude-cascade.YOUR-SUBDOMAIN.workers.dev
XRAY_BIN=xray bun run check:xray .local/worker-smoke.json
```

Для отката на прежний выход снова загрузи его клиентский outbound командой `prepare-secrets.ts` и выполни `bun run deploy --secrets-file .local/worker-secrets.json`. Затем обнови подписку в приложении. Код Worker отдельно откатывается через **Deployments** в Cloudflare. Чтобы быстро вернуть старое поведение на устройстве, переключись на исходную подписку.
