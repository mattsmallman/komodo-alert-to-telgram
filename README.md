# Komodo Alert to Telegram

A Cloudflare Worker that sends [Komodo](https://komo.do) alerts to a Telegram chat.

Komodo has no built-in Telegram alerter. This worker receives alerts from a Komodo Custom alerter, writes a short message for each alert type, and waits before sending alerts that often flap.

## Example messages

```
⚠️ Server web-01 disk at 91.2%
Mount: /mnt/data
Used: 1824.0 GiB of 2000.0 GiB
Time: 26 Sept, 18:58

✅ Server web-01 disk back to 64.0%
Lasted: 42 min

⚠️ Stack media is down ⬇️
Was: running ▶️
Server: nas-01
Time: 26 Sept, 19:02

⬆️ Update available for stack media
Service: jellyfin
Image: jellyfin/jellyfin:latest
Server: nas-01
Time: 26 Sept, 19:10
```

Resource names link to their page in Komodo.

## How alerts are handled

| Alert types | What happens |
|---|---|
| Server CPU, memory, disk, unreachable and version mismatch, swarm health, sync pending updates | Waits `DEBOUNCE_SECONDS`. If the alert clears in that time, nothing is sent. If it was sent, a resolved message follows with how long it lasted. A change from warning to critical is sent again. |
| Stack and deployment state changes | Waits `DEBOUNCE_SECONDS`. If the stack returns to its previous state in that time, nothing is sent. If a problem was reported, a message is sent when it is running again. |
| Everything else: build, repo, action and procedure failures, image updates, auto updates, schedule runs, test and custom alerts | Sent immediately. |

Pending alerts are kept in a Durable Object and sent by an alarm, so a restart does not lose them. A failed send is retried twice. If Telegram rejects the formatted message, it is resent as plain text.

## Setup

You need a Cloudflare account, Node.js 22 or later, and a Komodo instance.

### 1. Create a Telegram bot

1. Message [@BotFather](https://t.me/botfather) and send `/newbot`. Keep the token it gives you.
2. Add the bot to the chat or group that should receive alerts, and send a message there.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates`. The chat ID is `result[].message.chat.id`. Group IDs start with `-`.

### 2. Deploy the worker

```bash
git clone https://github.com/mattsmallman/komodo-alert-to-telegram.git
cd komodo-alert-to-telegram
npm install
npx wrangler login

npx wrangler secret put API_KEY_SECRET      # a long random string, for example from `openssl rand -hex 32`
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put KOMODO_URL          # for example https://komodo.example.com

npm run deploy
```

Wrangler prints the worker URL, for example `https://komodo-alert-to-telegram.<subdomain>.workers.dev`.

### 3. Add the alerter in Komodo

1. In Komodo, go to **Settings → Variables** and add a secret variable `TELEGRAM_ALERTER_KEY` with the same value as `API_KEY_SECRET`.
2. Go to **Alerters → New Alerter**. Set the endpoint type to **Custom** and the URL to:

   ```
   https://komodo:[[TELEGRAM_ALERTER_KEY]]@komodo-alert-to-telegram.<subdomain>.workers.dev/
   ```

   Komodo sends the key as a basic-auth header, which keeps it out of request logs. Use a key of letters and digits only, so it needs no URL encoding. The older form `https://…workers.dev/?api_key=[[TELEGRAM_ALERTER_KEY]]` also works.
3. Choose the alert types and resources you want, and enable the alerter.
4. Press **Test**. A message saying the alerter is working should arrive in Telegram.

## Configuration

Secrets, set with `npx wrangler secret put`:

| Name | Purpose |
|---|---|
| `API_KEY_SECRET` | Key that Komodo must send with each alert |
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `TELEGRAM_CHAT_ID` | Chat that receives alerts |
| `KOMODO_URL` | Base URL of your Komodo instance, used for links |

Variables, set in [wrangler.toml](wrangler.toml) under `[vars]`:

| Name | Default | Purpose |
|---|---|---|
| `DEBOUNCE_SECONDS` | `60` | How long to wait before sending server and state alerts. `0` sends at once. |
| `TIMEZONE` | `UTC` | [IANA time zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) for times in messages, for example `Europe/London` |

## Development

```bash
cp .dev.vars.example .dev.vars   # then fill in real values
npm run dev                      # local worker on http://localhost:8787
npm test                         # tests, using Node's built-in test runner
npm run check                    # confirm the worker builds
```

Send a test alert to the local worker:

```bash
curl -X POST "http://localhost:8787/?api_key=$(grep API_KEY_SECRET .dev.vars | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{
    "ts": 1790000000000,
    "resolved": true,
    "level": "OK",
    "target": { "type": "Alerter", "id": "test-id" },
    "data": { "type": "Test", "data": { "id": "test-id", "name": "Telegram" } }
  }'
```

The alert format is defined in Komodo's [`alert.rs`](https://github.com/moghtech/komodo/blob/main/client/core/rs/src/entities/alert.rs). When Komodo adds an alert type, add a case to `describe()` in [app.js](app.js). Unknown types are sent as JSON until then.

## Releases

Pull requests run the tests and a build check. Pushing a version tag deploys to Cloudflare and creates a GitHub release:

```bash
git tag v1.2.0
git push origin v1.2.0
```

The deploy workflow needs two repository secrets:
- `CLOUDFLARE_API_TOKEN`: an API token with the **Edit Cloudflare Workers** template.
- `CLOUDFLARE_ACCOUNT_ID`: shown on the Workers overview page in the Cloudflare dashboard.

## Licence

MIT. You may use, copy and change this code. Keep the copyright notice in [LICENSE](LICENSE) to credit the original.
