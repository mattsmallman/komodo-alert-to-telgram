// Durable Object for managing alert delays
export class AlertDebouncer {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.pendingAlerts = new Map(); // alertKey -> {timeout, alertData}
        this.MAX_PENDING_ALERTS = 1000; // Safety limit to prevent unbounded growth
    }

    async fetch(request) {
        const url = new URL(request.url);
        const action = url.pathname.split('/').pop();

        if (action === 'schedule') {
            const alertData = await request.json();
            return this.scheduleAlert(alertData);
        }

        return new Response('Not found', { status: 404 });
    }

    async scheduleAlert(alertData) {
        // For StackStateChange alerts, use the target state as the key component
        let alertKey;
        if (alertData.data?.type === 'StackStateChange') {
            const toState = alertData.data?.data?.to || 'unknown';
            alertKey = `${alertData.target.type}:${alertData.target.id}:state:${toState}`;
        } else {
            alertKey = `${alertData.target.type}:${alertData.target.id}:${alertData.level}`;
        }
        
        // Cancel existing timeout if any
        const existing = this.pendingAlerts.get(alertKey);
        if (existing) {
            clearTimeout(existing.timeout);
            console.log(`Cancelled existing alert for ${alertKey}`);
        }

        // For StackStateChange, if it's transitioning back to 'running', cancel any pending alerts for this stack
        if (alertData.data?.type === 'StackStateChange' && alertData.data?.data?.to === 'running') {
            // Cancel any pending alerts for this stack regardless of state
            const stackPrefix = `${alertData.target.type}:${alertData.target.id}:state:`;
            for (const [key, value] of this.pendingAlerts) {
                if (key.startsWith(stackPrefix)) {
                    clearTimeout(value.timeout);
                    this.pendingAlerts.delete(key);
                    console.log(`Cancelled pending alert for ${key} - stack returned to running`);
                }
            }
            return new Response(JSON.stringify({ success: true, message: 'Stack returned to running, cancelled pending alerts' }));
        }

        // If this is a resolved alert, cancel and don't reschedule
        if (alertData.resolved) {
            this.pendingAlerts.delete(alertKey);
            console.log(`Alert resolved, not sending for ${alertKey}`);
            return new Response(JSON.stringify({ success: true, message: 'Alert resolved, cancelled' }));
        }

        // Check if we've hit the safety limit
        if (this.pendingAlerts.size >= this.MAX_PENDING_ALERTS) {
            console.error(`Alert limit reached (${this.MAX_PENDING_ALERTS}). Rejecting new alert for ${alertKey}`);
            return new Response(JSON.stringify({
                success: false,
                message: 'Alert queue full - too many pending alerts'
            }), { status: 503 });
        }

        // Schedule new alert
        const debounceMs = (parseInt(this.env.DEBOUNCE_SECONDS) || 60) * 1000;
        const timeout = setTimeout(async () => {
            try {
                await this.sendAlert(alertData);
                this.pendingAlerts.delete(alertKey);
            } catch (error) {
                console.error(`Failed to send alert for ${alertKey}:`, error.message);
                // Delete from map even on failure to prevent memory leak
                this.pendingAlerts.delete(alertKey);
            }
        }, debounceMs);

        this.pendingAlerts.set(alertKey, { timeout, alertData });
        console.log(`Scheduled alert for ${alertKey} in ${debounceMs/1000} seconds (${this.pendingAlerts.size} pending)`);

        return new Response(JSON.stringify({ success: true, message: 'Alert scheduled' }));
    }

    async sendAlert(alertData) {
        // Extract alert information
        const alertLevel = alertData.level || "Unknown";
        const alertType = alertData.data?.type || "Unknown Type";
        const alertTargetId = alertData.target?.id || "Unknown Target";
        const alertTargetType = alertData.target?.type || "Unknown Target Type";
        const alertName = alertData.data?.data?.name || "Unnamed";
        const alertInfoData = alertData.data?.data || { info: "No alert data available" };

        // Select emoji based on alert level
        let levelEmoji = "ℹ️";
        switch (alertLevel.toUpperCase()) {
            case "CRITICAL": levelEmoji = "🔴"; break;
            case "ERROR": levelEmoji = "🚨"; break;
            case "WARNING": levelEmoji = "⚠️"; break;
            case "INFO": levelEmoji = "ℹ️"; break;
            case "OK": levelEmoji = "✅"; break;
        }

        // Create URL
        const baseUrl = this.env.KOMODO_URL;
        const targetTypePathMap = getTargetTypePathMap();
        const pathSegment = targetTypePathMap[alertTargetType];
        const url = pathSegment ? `${baseUrl}/${pathSegment}/${alertTargetId}` : baseUrl;

        // Create Telegram message with state change info
        let telegramMessage;
        if (alertType === 'StackStateChange') {
            const fromState = alertInfoData.from || 'unknown';
            const toState = alertInfoData.to || 'unknown';
            telegramMessage = `${levelEmoji} Stack State Change\n` +
                `*Stack*: [${alertName}](${url})\n` +
                `*State*: ${fromState} → ${toState}\n` +
                `*Duration*: Persisted for ${Math.floor((parseInt(this.env.DEBOUNCE_SECONDS) || 60))}+ seconds\n` +
                `*Link*: ${baseUrl}/${alertTargetType}/${alertTargetId}\n`;
        } else {
            telegramMessage = `${levelEmoji} ${alertLevel} - ${alertType}\n` +
                `*For*: [${alertName} (${alertTargetType})](${url})\n` +
                `*Resolved*: ❌\n` +
                `*Data*: ${JSON.stringify(alertInfoData, null, 2)}\n` +
                `*Link*: ${baseUrl}/${alertTargetType}/${alertTargetId}\n`;
        }

        // Send to Telegram
        const telegramUrl = `https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
        const response = await fetch(telegramUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: this.env.TELEGRAM_CHAT_ID,
                text: telegramMessage,
                parse_mode: 'Markdown'
            })
        });

        const result = await response.json();
        console.log(`Sent delayed alert for ${alertTargetType}:${alertTargetId}`, result.ok ? 'success' : result.description);
    }
}

function getTargetTypePathMap() {
    return {
        "stack": "stacks", "server": "servers", "alerter": "alerters",
        "deployment": "deployments", "build": "builds", "repo": "repos",
        "procedure": "procedures", "action": "actions", "builder": "builders",
        "template": "templates", "sync": "syncs"
    };
}

addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request, event.env));
});

async function handleRequest(request, env) {
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
    if (!apiKeyParam || apiKeyParam !== env.API_KEY_SECRET) {
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
        const alertInfoData = alertData.data?.data || { info: "No alert data available" };

        // Construct URL using target type path mapping
        const targetTypePathMap = getTargetTypePathMap();
        const pathSegment = targetTypePathMap[alertTargetType] || alertTargetType;
        const alerturl = `${env.KOMODO_URL}/${pathSegment}/${alertTargetId}`;
        console.log("Constructed URL:", alerturl);
        console.log("Extracted data:", {
            level: alertLevel,
            type: alertType,
            targetId: alertTargetId,
            targetType: alertTargetType,
            resolved: isResolved,
            name: alertName
        });

        // Use Durable Object to handle alert debouncing
        const doId = env.ALERT_DEBOUNCER.idFromName("global");
        const doStub = env.ALERT_DEBOUNCER.get(doId);
        
        const doResponse = await doStub.fetch(new Request("https://fake-host/schedule", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(alertData)
        }));

        const doResult = await doResponse.json();
        console.log("Durable Object response:", doResult);

        // Return success response
        return new Response(JSON.stringify({
            success: true,
            message: doResult.message,
            debounced: true
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