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

    // Log the request for debugging
    console.log("Request received:", request.url);
    console.log("API key check:", apiKeyParam ? "Key provided" : "No key provided");

    // API key should be stored as an environment variable in Cloudflare
    if (!apiKeyParam || apiKeyParam !== API_KEY_SECRET) {
        console.log("Authentication failed: Invalid API key");
        return new Response('Unauthorized: Invalid or missing API key', {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        // Parse the alert JSON
        const alertData = await request.json();

        // Log the full structure for debugging
        console.log("Received alert data:", JSON.stringify(alertData));

        // Extract information based on the specific structure you provided
        const alertLevel = alertData.level || "Unknown";
        const alertType = alertData.data?.type || "Unknown Type";
        const alertTargetId = alertData.target?.id || "Unknown Target";
        const alertTargetType = alertData.target?.type || "Unknown Target Type";
        const isResolved = alertData.resolved ? "Yes" : "No";
        const alertName = alertData.data?.data?.name || "Unnamed";

        console.log("Extracted data:", {
            level: alertLevel,
            type: alertType,
            targetId: alertTargetId,
            targetType: alertTargetType,
            resolved: isResolved,
            name: alertName
        });

        // Select emoji based on alert level
        let levelEmoji = "ℹ️"; // Default info emoji

        switch (alertLevel.toUpperCase()) {
            case "CRITICAL":
                levelEmoji = "🔴";
                break;
            case "ERROR":
                levelEmoji = "🚨";
                break;
            case "WARNING":
                levelEmoji = "⚠️";
                break;
            case "INFO":
                levelEmoji = "ℹ️";
                break;
            case "OK":
                levelEmoji = "✅";
                break;
            default:
                // Use default emoji
                console.log("Unknown alert level:", alertLevel);
        }

        // create url
        const baseUrl = KOMODO_URL;

        const targetTypePathMap = {
            "stack": "stacks",
            "server": "servers",
            "alerter": "alerters",
            "deployment": "deployments",
            "build": "builds",
            "repo": "repos",
            "procedure": "procedures",
            "action": "actions",
            "builder": "builders",
            "template": "templates",
            "sync": "syncs"
        };

        const pathSegment = targetTypePathMap[alertTargetType];
        const url = pathSegment
            ? `${baseUrl}/${pathSegment}/${alertTargetId}`
            : baseUrl;

        if (!pathSegment) {
            console.log("Unknown alert target type:", alertTargetType);
        }

        const resolvedStausEmoji = isResolved === "Yes" ? "✅" : "❌";

        // Create a more descriptive message for Telegram
        const telegramMessage = `${levelEmoji} ${alertLevel} - ${alertType}\n` +
            `*For*: [${alertName} (${alertTargetType})](${url})\n` +
            `*Resolved*: ${resolvedStausEmoji}\n`;

        console.log("Formatted message:", telegramMessage);

        // Your Telegram bot token and chat ID (set in environment variables)
        const botToken = TELEGRAM_BOT_TOKEN;
        const chatId = TELEGRAM_CHAT_ID;

        console.log("Sending to Telegram:", {
            botTokenPrefix: botToken ? botToken.substring(0, 5) + "..." : "Not set",
            chatId: chatId || "Not set"
        });

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
        console.log("Telegram API response:", JSON.stringify(telegramResult));

        if (!telegramResult.ok) {
            console.log("Telegram API error:", telegramResult.description);
            throw new Error(`Telegram API error: ${telegramResult.description}`);
        }

        console.log("Successfully sent message to Telegram");

        // Return success response
        return new Response(JSON.stringify({
            success: true,
            message: "Alert sent to Telegram",
            formatted_message: telegramMessage
        }), {
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            }
        });

    } catch (error) {
        // Log the error
        console.error("Error processing request:", error.message);
        console.error("Error stack:", error.stack);

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