addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
    // Only process POST requests
    if (request.method !== 'POST') {
        return new Response('This endpoint requires a POST request', { status: 405 })
    }

    try {
        // Parse the alert JSON from your Rust application
        const alertData = await request.json()

        // Extract the relevant information
        const alertMessage = alertData.message || "Alert triggered"
        const alertSeverity = alertData.severity || "Unknown"

        // Format the message for Telegram
        const telegramMessage = `🚨 *ALERT*\nMessage: ${alertMessage}\nSeverity: ${alertSeverity}`

        // Your Telegram bot token and chat ID (set these in Cloudflare Worker environment variables)
        const botToken = TELEGRAM_BOT_TOKEN // Set in Cloudflare Worker environment
        const chatId = TELEGRAM_CHAT_ID // Set in Cloudflare Worker environment

        // Send to Telegram
        const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`
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
        })

        const telegramResult = await telegramResponse.json()

        // Return success response
        return new Response(JSON.stringify({
            success: true,
            message: "Alert sent to Telegram"
        }), {
            headers: { 'Content-Type': 'application/json' }
        })

    } catch (error) {
        // Handle errors
        return new Response(JSON.stringify({
            success: false,
            error: error.message
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        })
    }
}