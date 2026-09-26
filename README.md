# Komodo Alert to Telegram

A Cloudflare Worker that forwards Komodo alerts to Telegram. It receives alerts from a Komodo Custom alerter, formats each alert type as a short readable message, and debounces alerts that often flap.

## Deployment

### Prerequisites

1. [Node.js](https://nodejs.org/) installed
2. [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed
3. A Cloudflare account
4. A Telegram bot token and chat ID

### Setup Steps

1. Clone this repository:
```bash
git clone https://github.com/yourusername/komodo-alert-to-telegram.git
cd komodo-alert-to-telegram
```

2. Install dependencies:
```bash
npm install
```

3. Authenticate with Cloudflare:
```bash
wrangler login
```

4. Configure environment variables in Cloudflare:

You'll need to set the following environment variables in your Cloudflare Workers dashboard or using wrangler:

```bash
wrangler secret put API_KEY_SECRET
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put KOMODO_URL
```

Required variables:
- `API_KEY_SECRET`: Secret key for authenticating webhook requests
- `TELEGRAM_BOT_TOKEN`: Your Telegram bot token from [@BotFather](https://t.me/botfather)
- `TELEGRAM_CHAT_ID`: The Telegram chat ID where alerts should be sent
- `KOMODO_URL`: Base URL of your Komodo server for generating links

Optional variables:
- `DEBOUNCE_SECONDS`: Delay before sending alerts (default: 60 seconds)
- `TIMEZONE`: IANA time zone for times in messages, for example `Europe/London` (default: `UTC`)

5. Deploy to Cloudflare Workers:
```bash
wrangler deploy
```

### Usage

Once deployed, you'll get a URL for your worker. Use this URL as your webhook endpoint in Komodo, adding your API key as a query parameter:

```
https://your-worker.your-subdomain.workers.dev?api_key=your_api_key_secret
```

### Testing

Use the Test button on the alerter in Komodo, or send a test alert yourself:

```bash
curl -X POST "https://your-worker.your-subdomain.workers.dev?api_key=your_api_key_secret" \
-H "Content-Type: application/json" \
-d '{
  "ts": 1790000000000,
  "resolved": true,
  "level": "OK",
  "data": {
    "type": "Test",
    "data": { "id": "test-id", "name": "Test Alerter" }
  },
  "target": { "type": "Alerter", "id": "test-id" }
}'
```

### Local Development

1. Create a `.dev.vars` file with your development environment variables:
```
API_KEY_SECRET=your_development_api_key
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
KOMODO_URL=https://your-komodo-server
```

2. Run the worker locally:
```bash
wrangler dev
```

## Features

- A readable message for each Komodo alert type, with a link to the resource in Komodo.
- Server, disk, memory, CPU, version and swarm alerts wait `DEBOUNCE_SECONDS` before sending. If they resolve in that time, nothing is sent. If they were sent, a resolved message follows with how long the problem lasted. A change of level (warning to critical) is sent again.
- Stack and deployment state changes are debounced. A return to the previous state within the window cancels the message. A return to running after a reported problem sends a recovery message.
- Build, action and procedure failures, image updates, schedule runs, test and custom alerts are sent at once.
- Pending alerts are kept in Durable Object storage and sent by an alarm, so they survive restarts.
- If Telegram rejects a formatted message, it is resent as plain text.

## Security

- Webhook authentication using API key
- CORS headers for controlled web access
- Environment variables for sensitive configuration

## Support

For issues or questions, please open an issue in the GitHub repository.
