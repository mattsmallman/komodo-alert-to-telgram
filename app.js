addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
        return handleCORS(request);
    }

    // Only process POST requests
    if (request.method !== 'POST') {
        return new Response('This endpoint requires a POST request', { status: 405 });
    }

    // Check API key from URL parameters
    const url = new URL(request.url);
    const apiKeyParam = url.searchParams.get('api_key');

    // API key should be stored as an environment variable in Cloudflare
    if (!apiKeyParam || apiKeyParam !== API_KEY_SECRET) {
        return new Response('Unauthorized: Invalid or missing API key', {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        // Parse the alert JSON from your Rust application
        const alertData = await request.json();

        // Extract the relevant information (handle nested structures in case of different alert formats)
        const alertMessage = alertData.message ||
            alertData.data?.message ||
            alertData.alertData?.message ||
            "Alert triggered";

        const alertSeverity = alertData.severity ||
            alertData.data?.severity ||
            alertData.alertData?.severity ||
            "Unknown";

        // Format the message for Telegram
        const telegramMessage = `🚨 *ALERT*\nMessage: ${alertMessage}\nSeverity: ${alertSeverity}`;

        // Your Telegram bot token and chat ID (set these in Cloudflare Worker environment variables)
        const botToken = TELEGRAM_BOT_TOKEN; // Set in Cloudflare Worker environment
        const chatId = TELEGRAM_CHAT_ID; // Set in Cloudflare Worker environment

        // Send to Telegram
        const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
        const telegramResponse = await fetch(telegramUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                chat_id: chatId,
                text: telegramMessage,
                parse_mode: 'Markdown'
            })
        });

        const telegramResult = await telegramResponse.json();

        if (!telegramResult.ok) {
            throw new Error(`Telegram API error: ${telegramResult.description}`);
        }

        // Return success response
        return new Response(JSON.stringify({
            success: true,
            message: "Alert sent to Telegram"
        }), {
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            }
        });

    } catch (error) {
        // Handle errors
        return new Response(JSON.stringify({
            success: false,
            error: error.message
        }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            }
        });
    }
}

function handleCORS(request) {
    return new Response(null, {
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400'
        }
    });
}