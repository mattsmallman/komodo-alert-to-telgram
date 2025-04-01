# Komodo Alert to Telegram

A Cloudflare Worker that forwards Komodo alerts to Telegram. This worker receives alert webhooks from Komodo and forwards them to a specified Telegram chat with formatted messages including emojis based on alert levels.

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

You can test the deployment by sending a POST request to your worker URL:

```bash
curl -X POST "https://your-worker.your-subdomain.workers.dev?api_key=your_api_key_secret" \
-H "Content-Type: application/json" \
-d '{
  "level": "INFO",
  "data": {
    "type": "test",
    "data": {
      "name": "Test Alert"
    }
  },
  "target": {
    "id": "test-id",
    "type": "server"
  }
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

- Forwards Komodo alerts to Telegram
- Formats messages with appropriate emojis based on alert level
- Includes clickable links to Komodo resources
- Supports CORS for web integrations
- Comprehensive error handling and logging

## Security

- Webhook authentication using API key
- CORS headers for controlled web access
- Environment variables for sensitive configuration

## Support

For issues or questions, please open an issue in the GitHub repository.
