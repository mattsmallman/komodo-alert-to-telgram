// Komodo alert types that open and later resolve. Komodo sends them once with
// resolved=false, again if the level changes, and once more with resolved=true.
const LIFECYCLE_TYPES = new Set([
    'ServerUnreachable', 'ServerCpu', 'ServerMem', 'ServerDisk',
    'ServerVersionMismatch', 'SwarmUnhealthy', 'ResourceSyncPendingUpdates'
]);

// State changes arrive as one-off events (resolved=true). They are debounced
// so a stack that flaps and recovers within the window produces no message.
const STATE_CHANGE_TYPES = new Set(['StackStateChange', 'ContainerStateChange']);

// All other types (build failures, image updates, tests, custom alerts...) are
// one-off events that Komodo also marks resolved=true. They are sent at once.

const TARGET_PATHS = {
    swarm: 'swarms', server: 'servers', stack: 'stacks',
    deployment: 'deployments', build: 'builds', repo: 'repos',
    procedure: 'procedures', action: 'actions', builder: 'builders',
    alerter: 'alerters', resourcesync: 'resource-syncs'
};

const LEVEL_EMOJI = { CRITICAL: '🔴', WARNING: '⚠️', OK: '✅' };

const STATE_EMOJI = {
    running: '▶️', stopped: '🛑', exited: '🛑', restarting: '🔄',
    down: '⬇️', not_deployed: '⬇️', unhealthy: '🩺', dead: '💀', paused: '⏸️'
};

const MAX_SEND_ATTEMPTS = 3;
// Telegram rejects messages over 4096 characters. Cap the body and each line
// so the total stays under the limit.
const MAX_BODY_LENGTH = 2500;
const MAX_LINE_LENGTH = 300;
const RETRY_DELAY_MS = 30 * 1000;

// Durable Object for managing alert delays. Pending alerts live in storage and
// are sent from alarm(), so they survive the object being evicted.
export class AlertDebouncer {
    constructor(state, env) {
        this.state = state;
        this.storage = state.storage;
        this.env = env;
    }

    async fetch(request) {
        const action = new URL(request.url).pathname.split('/').pop();
        if (action !== 'schedule') {
            return new Response('Not found', { status: 404 });
        }

        const alert = await request.json();
        const type = alert.data?.type;
        let message;
        if (STATE_CHANGE_TYPES.has(type)) {
            message = await this.handleStateChange(alert);
        } else if (LIFECYCLE_TYPES.has(type)) {
            message = await this.handleLifecycle(alert);
        } else {
            message = await this.sendNow(alert);
        }
        await this.rescheduleAlarm();
        console.log(`${alertKey(alert)}: ${message}`);
        return Response.json({ success: true, message });
    }

    debounceMs() {
        const seconds = parseInt(this.env.DEBOUNCE_SECONDS);
        return (Number.isNaN(seconds) ? 60 : seconds) * 1000;
    }

    // Sends an alert immediately. On failure it is stored as a one-off retry
    // entry, which alarm() sends and then deletes.
    async sendNow(alert) {
        try {
            await this.send(formatAlert(alert, this.env));
            return 'Sent';
        } catch (error) {
            console.error(`Send failed for ${alertKey(alert)}, will retry:`, error.message);
            const key = `retry:${crypto.randomUUID()}`;
            await this.storage.put(key, { alert, dueAt: Date.now() + RETRY_DELAY_MS, attempts: 1, retry: true });
            return 'Send failed, retry scheduled';
        }
    }

    // Entry shape: { alert, dueAt, sentLevel }
    // dueAt is set while a message is waiting to be sent.
    // sentLevel is the level last sent to Telegram, so resolution can follow up.
    async handleLifecycle(alert) {
        const key = alertKey(alert);
        const entry = await this.storage.get(key);

        if (alert.resolved) {
            await this.storage.delete(key);
            if (entry?.sentLevel) {
                return `Resolved, follow-up: ${await this.sendNow(alert)}`;
            }
            return 'Resolved before being sent, cancelled';
        }

        if (entry?.sentLevel === alert.level) {
            await this.storage.put(key, { ...entry, alert, dueAt: null });
            return 'Already sent at this level';
        }

        const dueAt = entry?.dueAt ?? Date.now() + this.debounceMs();
        await this.storage.put(key, { alert, dueAt, sentLevel: entry?.sentLevel ?? null });
        return 'Scheduled';
    }

    // Entry shape: { alert, dueAt, sentState }
    // The baseline is the state last reported to Telegram, or the state before
    // the first unsent change. Returning to the baseline cancels the pending message.
    async handleStateChange(alert) {
        const key = alertKey(alert);
        const entry = await this.storage.get(key);
        const to = alert.data.data.to;
        const baseline = entry?.sentState ?? entry?.alert.data.data.from ?? alert.data.data.from;

        if (to === baseline) {
            if (entry?.sentState) {
                await this.storage.put(key, { ...entry, dueAt: null });
            } else {
                await this.storage.delete(key);
            }
            return `Returned to ${to}, pending message cancelled`;
        }

        // A move to running is only worth a message if a problem was reported.
        if (to === 'running' && !entry?.sentState) {
            await this.storage.delete(key);
            return 'Now running and nothing was reported, ignored';
        }

        const firstTs = entry?.dueAt ? entry.alert.ts : alert.ts;
        const merged = {
            ...alert,
            ts: firstTs,
            data: { ...alert.data, data: { ...alert.data.data, from: baseline } }
        };
        const dueAt = entry?.dueAt ?? Date.now() + this.debounceMs();
        await this.storage.put(key, { alert: merged, dueAt, sentState: entry?.sentState ?? null });
        return `Scheduled ${baseline} → ${to}`;
    }

    async alarm() {
        const now = Date.now();
        const entries = await this.storage.list();
        for (const [key, entry] of entries) {
            if (!entry.dueAt || entry.dueAt > now) continue;
            try {
                await this.send(formatAlert(entry.alert, this.env));
            } catch (error) {
                // Falls through to the "sent" bookkeeping below once attempts run out.
                const attempts = (entry.attempts || 0) + 1;
                console.error(`Send failed for ${key} (attempt ${attempts}):`, error.message);
                if (attempts < MAX_SEND_ATTEMPTS) {
                    await this.storage.put(key, { ...entry, attempts, dueAt: now + RETRY_DELAY_MS });
                    continue;
                }
                // Give up on this message, but record it as reported so that the
                // recovery or resolved message is still sent later.
                console.error(`Giving up on ${key} after ${attempts} attempts`);
            }

            const type = entry.alert.data.type;
            if (entry.retry) {
                await this.storage.delete(key);
            } else if (STATE_CHANGE_TYPES.has(type)) {
                const to = entry.alert.data.data.to;
                if (to === 'running') {
                    await this.storage.delete(key);
                } else {
                    await this.storage.put(key, { alert: entry.alert, dueAt: null, sentState: to });
                }
            } else {
                await this.storage.put(key, { alert: entry.alert, dueAt: null, sentLevel: entry.alert.level });
            }
        }
        await this.rescheduleAlarm();
    }

    async rescheduleAlarm() {
        const entries = await this.storage.list();
        let next = null;
        for (const entry of entries.values()) {
            if (entry.dueAt && (next === null || entry.dueAt < next)) next = entry.dueAt;
        }
        if (next === null) {
            await this.storage.deleteAlarm();
        } else {
            await this.storage.setAlarm(next);
        }
    }

    async send(html) {
        const url = `https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
        const post = (body) => fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: this.env.TELEGRAM_CHAT_ID, disable_web_page_preview: true, ...body })
        }).then(r => r.json());

        let result = await post({ text: html, parse_mode: 'HTML' });
        if (!result.ok && result.error_code === 400) {
            console.error('Telegram rejected HTML message, retrying as plain text:', result.description, html);
            result = await post({ text: htmlToText(html) });
        }
        if (!result.ok) {
            throw new Error(`Telegram error: ${result.description}`);
        }
    }
}

function targetType(alert) {
    return (alert.target?.type || '').toLowerCase();
}

function alertKey(alert) {
    const type = alert.data?.type;
    const base = `${targetType(alert)}:${alert.target?.id}`;
    if (STATE_CHANGE_TYPES.has(type)) return `${base}:state`;
    if (type === 'ServerDisk') return `${base}:${type}:${alert.data.data.path}`;
    return `${base}:${type}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function htmlToText(html) {
    return html
        .replace(/<a href="([^"]*)">(.*?)<\/a>/g, '$2 ($1)')
        .replace(/<[^>]+>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function resourceUrl(alert, env) {
    const path = TARGET_PATHS[targetType(alert)];
    const base = (env.KOMODO_URL || '').replace(/\/+$/, '');
    if (!path || !base || !alert.target?.id) return null;
    return `${base}/${path}/${alert.target.id}`;
}

function formatTime(ts, env) {
    if (!ts) return null;
    const options = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
    const timeZone = env.TIMEZONE || 'UTC';
    try {
        return new Date(ts).toLocaleString('en-GB', { ...options, timeZone });
    } catch (error) {
        console.error(`Invalid TIMEZONE "${timeZone}", using UTC:`, error.message);
        return `${new Date(ts).toLocaleString('en-GB', { ...options, timeZone: 'UTC' })} UTC`;
    }
}

function formatDuration(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return 'under a minute';
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return `${hours} h ${minutes % 60} min`;
}

function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max)}… (truncated)` : text;
}

function percent(used, total) {
    return total ? `${(100 * used / total).toFixed(1)}%` : 'unknown';
}

function gib(value) {
    return `${Number(value).toFixed(1)} GiB`;
}

function stateLabel(state, suffix = '') {
    const label = String(state || 'unknown').replace(/_/g, ' ') + suffix;
    return STATE_EMOJI[state] ? `${label} ${STATE_EMOJI[state]}` : label;
}

function hostLabel(d) {
    if (d.swarm_name) return ['Swarm', d.swarm_name];
    if (d.server_name) return ['Server', d.server_name];
    return null;
}

// Returns { title, lines } for an alert. The title names the resource in bold;
// formatAlert turns the name into a link.
function describe(alert) {
    const d = alert.data?.data || {};
    const type = alert.data?.type;
    const ok = alert.level === 'OK';
    const name = `<b>${escapeHtml(d.name)}</b>`;
    const region = d.region ? ` (${escapeHtml(d.region)})` : '';
    const host = hostLabel(d);
    const lines = [];

    switch (type) {
        case 'Test':
            return { title: `Alerter ${name} is working`, lines };

        case 'SwarmUnhealthy':
            if (d.err?.error) lines.push(['Error', d.err.error]);
            return { title: ok ? `Swarm ${name} is healthy again` : `Swarm ${name} is unhealthy`, lines };

        case 'ServerUnreachable':
            if (!ok && d.err?.error) lines.push(['Error', d.err.error]);
            return { title: ok ? `Server ${name}${region} is reachable again` : `Server ${name}${region} is unreachable`, lines };

        case 'ServerCpu':
            return { title: `Server ${name}${region} CPU ${ok ? 'back to' : 'at'} ${Number(d.percentage).toFixed(1)}%`, lines };

        case 'ServerMem':
            lines.push(['Used', `${gib(d.used_gb)} of ${gib(d.total_gb)}`]);
            return { title: `Server ${name}${region} memory ${ok ? 'back to' : 'at'} ${percent(d.used_gb, d.total_gb)}`, lines };

        case 'ServerDisk':
            lines.push(['Mount', d.path]);
            lines.push(['Used', `${gib(d.used_gb)} of ${gib(d.total_gb)}`]);
            return { title: `Server ${name}${region} disk ${ok ? 'back to' : 'at'} ${percent(d.used_gb, d.total_gb)}`, lines };

        case 'ServerVersionMismatch':
            if (!ok) lines.push(['Periphery', d.server_version], ['Core', d.core_version]);
            return { title: ok ? `Server ${name}${region} version matches Core again` : `Server ${name}${region} version does not match Core`, lines };

        case 'StackStateChange':
        case 'ContainerStateChange': {
            const kind = type === 'StackStateChange' ? 'Stack' : 'Deployment';
            const again = d.to === 'running' ? ' again' : '';
            lines.push(['Was', stateLabel(d.from)]);
            if (host) lines.push(host);
            return { title: `${kind} ${name} is ${stateLabel(d.to, again)}`, lines };
        }

        case 'DeploymentImageUpdateAvailable':
            lines.push(['Image', d.image]);
            if (host) lines.push(host);
            return { title: `Update available for deployment ${name}`, lines };

        case 'DeploymentAutoUpdated':
            lines.push(['Image', d.image]);
            if (host) lines.push(host);
            return { title: `Deployment ${name} was updated automatically`, lines };

        case 'StackImageUpdateAvailable':
            lines.push(['Service', d.service], ['Image', d.image]);
            if (host) lines.push(host);
            return { title: `Update available for stack ${name}`, lines };

        case 'StackAutoUpdated':
            lines.push([d.images?.length > 1 ? 'Images' : 'Image', (d.images || []).join(', ')]);
            if (host) lines.push(host);
            return { title: `Stack ${name} was updated automatically`, lines };

        case 'AwsBuilderTerminationFailed':
            lines.push(['Instance', d.instance_id], ['Reason', d.message]);
            return { title: 'AWS builder instance failed to terminate', lines };

        case 'ResourceSyncPendingUpdates':
            return { title: ok ? `Sync ${name} has no pending updates` : `Sync ${name} has pending updates`, lines };

        case 'BuildFailed':
            if (d.version) lines.push(['Version', `v${d.version.major}.${d.version.minor}.${d.version.patch}`]);
            return { title: `Build ${name} failed`, lines };

        case 'RepoBuildFailed':
            return { title: `Repo build ${name} failed`, lines };

        case 'ProcedureFailed':
            return { title: `Procedure ${name} failed`, lines };

        case 'ActionFailed':
            return { title: `Action ${name} failed`, lines };

        case 'ScheduleRun':
            return { title: `Scheduled run started for ${escapeHtml(d.resource_type || 'resource').toLowerCase()} ${name}`, lines };

        case 'Custom':
            return { title: `<b>${escapeHtml(d.message)}</b>`, lines, body: d.details };

        default:
            return {
                title: `${escapeHtml(type || 'Unknown alert')}${d.name ? ` for ${name}` : ''}`,
                lines,
                body: JSON.stringify(d, null, 2),
                pre: true
            };
    }
}

function formatAlert(alert, env) {
    const { title, lines, body, pre } = describe(alert);
    const d = alert.data?.data || {};
    const url = resourceUrl(alert, env);

    let emoji = LEVEL_EMOJI[alert.level] || 'ℹ️';
    if (STATE_CHANGE_TYPES.has(alert.data?.type)) emoji = d.to === 'running' ? '✅' : '⚠️';
    if (['Test', 'ScheduleRun'].includes(alert.data?.type)) emoji = 'ℹ️';
    if (/UpdateAvailable|AutoUpdated/.test(alert.data?.type)) emoji = '⬆️';

    // Link the resource name in the title to its Komodo page.
    const linkedTitle = url && d.name
        ? title.replace(`<b>${escapeHtml(d.name)}</b>`, `<a href="${escapeHtml(url)}"><b>${escapeHtml(d.name)}</b></a>`)
        : title;

    const out = [`${emoji} ${linkedTitle}`];
    for (const [label, value] of lines) {
        out.push(`${label}: ${escapeHtml(truncate(String(value ?? ''), MAX_LINE_LENGTH))}`);
    }
    if (body) {
        const text = truncate(body, MAX_BODY_LENGTH);
        out.push(pre ? `<pre>${escapeHtml(text)}</pre>` : escapeHtml(text));
    }

    const lifecycleResolved = LIFECYCLE_TYPES.has(alert.data?.type) && alert.resolved;
    if (lifecycleResolved && alert.resolved_ts && alert.ts) {
        out.push(`Lasted: ${formatDuration(alert.resolved_ts - alert.ts)}`);
    } else {
        const time = formatTime(alert.ts, env);
        if (time) out.push(`Time: ${time}`);
    }

    return out.join('\n');
}

// Komodo's Custom alerter only has a URL setting, so the key has to travel in
// the URL. It can be a query parameter (?api_key=KEY) or basic-auth
// credentials (https://komodo:KEY@host/), which the HTTP client sends as an
// Authorization header and so keeps out of query-string logs.
function requestKey(request) {
    const auth = request.headers.get('Authorization') || '';
    if (auth.startsWith('Basic ')) {
        try {
            const decoded = atob(auth.slice(6));
            return decoded.slice(decoded.indexOf(':') + 1);
        } catch {
            return null;
        }
    }
    return new URL(request.url).searchParams.get('api_key');
}

function safeEqual(a, b) {
    const encoder = new TextEncoder();
    const x = encoder.encode(a);
    const y = encoder.encode(b);
    let diff = x.length ^ y.length;
    for (let i = 0; i < x.length; i++) {
        diff |= x[i] ^ (y[i] ?? 0);
    }
    return diff === 0;
}

function jsonResponse(body, status = 200) {
    return Response.json(body, { status });
}

export default {
    async fetch(request, env) {
        if (request.method !== 'POST') {
            return jsonResponse({ success: false, error: 'This endpoint requires a POST request' }, 405);
        }

        const key = requestKey(request);
        if (!key || !env.API_KEY_SECRET || !safeEqual(key, env.API_KEY_SECRET)) {
            console.log('Authentication failed: invalid or missing API key');
            return jsonResponse({ success: false, error: 'Invalid or missing API key' }, 401);
        }

        let alert;
        try {
            alert = await request.json();
        } catch {
            return jsonResponse({ success: false, error: 'Body is not valid JSON' }, 400);
        }
        if (!alert?.data?.type || !alert?.target) {
            return jsonResponse({ success: false, error: 'Body is not a Komodo alert' }, 400);
        }

        try {
            console.log('Received alert:', JSON.stringify(alert));
            const stub = env.ALERT_DEBOUNCER.get(env.ALERT_DEBOUNCER.idFromName('global'));
            const doResponse = await stub.fetch(new Request('https://debouncer/schedule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(alert)
            }));
            const doResult = await doResponse.json();
            return jsonResponse({ success: true, message: doResult.message });
        } catch (error) {
            console.error('Error processing alert:', error.message, error.stack);
            return jsonResponse({ success: false, error: error.message }, 500);
        }
    }
};
