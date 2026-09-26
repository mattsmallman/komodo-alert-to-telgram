import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { AlertDebouncer } from '../app.js';

// Telegram API stub. Set `failMode` to make sends fail.
let sent;
let failMode;
globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (failMode === 'all' || (failMode === 'html' && body.parse_mode === 'HTML')) {
        return { json: async () => ({ ok: false, error_code: 400, description: 'rejected' }) };
    }
    sent.push(body);
    return { json: async () => ({ ok: true }) };
};

let now;
Date.now = () => now;

let map;
let alarmAt;
let debouncer;

beforeEach(() => {
    sent = [];
    failMode = null;
    now = 1_800_000_000_000;
    map = new Map();
    alarmAt = null;
    const storage = {
        get: async k => structuredClone(map.get(k)),
        put: async (k, v) => { map.set(k, structuredClone(v)); },
        delete: async k => map.delete(k),
        list: async () => new Map(map),
        setAlarm: async t => { alarmAt = t; },
        deleteAlarm: async () => { alarmAt = null; }
    };
    const env = { DEBOUNCE_SECONDS: '60', KOMODO_URL: 'https://komodo.example.com/' };
    debouncer = new AlertDebouncer({ storage }, env);
});

async function post(alert) {
    const request = new Request('https://x/schedule', { method: 'POST', body: JSON.stringify(alert) });
    return (await (await debouncer.fetch(request)).json()).message;
}

async function wait(seconds) {
    now += seconds * 1000;
    if (alarmAt !== null && alarmAt <= now) await debouncer.alarm();
}

const texts = () => sent.map(m => m.text);

function stack(from, to) {
    return {
        ts: now, resolved: true, level: 'WARNING',
        target: { type: 'Stack', id: 's1' },
        data: { type: 'StackStateChange', data: { id: 's1', name: 'media_stack', server_name: 'nas-01', from, to } }
    };
}

function cpu(level, resolved, percentage) {
    return {
        ts: now - (resolved ? 300_000 : 0), resolved_ts: resolved ? now : null, resolved, level,
        target: { type: 'Server', id: 'srv1' },
        data: { type: 'ServerCpu', data: { id: 'srv1', name: 'web-01', percentage } }
    };
}

function event(type, targetType, data, level = 'WARNING') {
    return { ts: now, resolved: true, level, target: { type: targetType, id: 'x1' }, data: { type, data } };
}

test('stack that flaps back to running sends nothing', async () => {
    await post(stack('running', 'unhealthy'));
    await wait(30);
    await post(stack('unhealthy', 'running'));
    await wait(60);
    assert.equal(sent.length, 0);
    assert.equal(map.size, 0);
});

test('stack changes in one window send one message from the baseline, then a recovery', async () => {
    await post(stack('running', 'restarting'));
    await wait(20);
    await post(stack('restarting', 'down'));
    await wait(50);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Stack .*media_stack.* is down/);
    assert.match(sent[0].text, /Was: running/);
    assert.match(sent[0].text, /Server: nas-01/);
    assert.match(sent[0].text, /href="https:\/\/komodo\.example\.com\/stacks\/s1"/);

    await post(stack('down', 'running'));
    await wait(61);
    assert.equal(sent.length, 2);
    assert.match(sent[1].text, /is running again/);
    assert.equal(map.size, 0);
});

test('move to running with nothing reported is ignored', async () => {
    await post(stack('down', 'running'));
    await wait(61);
    assert.equal(sent.length, 0);
});

test('cpu alert that resolves inside the window sends nothing', async () => {
    await post(cpu('WARNING', false, 91.2));
    await wait(20);
    await post(cpu('OK', true, 20));
    await wait(60);
    assert.equal(sent.length, 0);
});

test('cpu warning, escalation and resolution', async () => {
    await post(cpu('WARNING', false, 91.2));
    await wait(61);
    await post(cpu('CRITICAL', false, 98.4));
    await wait(61);
    await post(cpu('CRITICAL', false, 99));
    await wait(61);
    await post(cpu('OK', true, 21.5));
    assert.deepEqual(texts().map(t => t.split('\n')[0].replace(/<[^>]+>/g, '')), [
        '⚠️ Server web-01 CPU at 91.2%',
        '🔴 Server web-01 CPU at 98.4%',
        '✅ Server web-01 CPU back to 21.5%'
    ]);
    assert.match(sent[2].text, /Lasted: 5 min/);
});

test('one-off events are sent at once', async () => {
    await post(event('BuildFailed', 'Build', { id: 'x1', name: 'api', version: { major: 1, minor: 4, patch: 2 } }));
    await post(event('Test', 'Alerter', { id: 'x1', name: 'telegram' }, 'OK'));
    assert.equal(sent.length, 2);
    assert.match(sent[0].text, /Build .*api.* failed\nVersion: v1\.4\.2/);
    assert.match(sent[1].text, /Alerter .*telegram.* is working/);
});

test('custom alert text is escaped', async () => {
    await post(event('Custom', 'System', { message: 'Backup <done>', details: 'took 5 min & 2 GB' }, 'OK'));
    assert.match(sent[0].text, /Backup &lt;done&gt;/);
    assert.match(sent[0].text, /took 5 min &amp; 2 GB/);
});

test('rejected HTML is resent as plain text with the link kept', async () => {
    failMode = 'html';
    await post(event('ActionFailed', 'Action', { id: 'x1', name: 'nightly' }));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].parse_mode, undefined);
    assert.match(sent[0].text, /Action nightly \(https:\/\/komodo\.example\.com\/actions\/x1\) failed/);
});

test('failed one-off send is retried by the alarm', async () => {
    failMode = 'all';
    const message = await post(event('ProcedureFailed', 'Procedure', { id: 'x1', name: 'backup' }));
    assert.equal(message, 'Send failed, retry scheduled');
    failMode = null;
    await wait(31);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Procedure .*backup.* failed/);
    assert.equal(map.size, 0);
});

test('long unknown alert bodies are truncated', async () => {
    await post(event('SomethingNew', 'Server', { name: 'web-01', blob: 'x'.repeat(10_000) }));
    assert.ok(sent[0].text.length < 4096);
    assert.match(sent[0].text, /\(truncated\)/);
});

test('DEBOUNCE_SECONDS=0 sends without delay', async () => {
    debouncer.env.DEBOUNCE_SECONDS = '0';
    await post(cpu('WARNING', false, 91.2));
    await wait(0);
    assert.equal(sent.length, 1);
});

test('after retries run out the alert still counts as reported, so recovery is sent', async () => {
    await post(stack('running', 'down'));
    failMode = 'all';
    await wait(61);
    await wait(31);
    await wait(31);
    assert.equal(sent.length, 0);
    failMode = null;
    await post(stack('down', 'running'));
    await wait(61);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /is running again/);
});

test('long line values are truncated', async () => {
    await post({
        ts: now, resolved: false, level: 'CRITICAL', target: { type: 'Server', id: 'x3' },
        data: { type: 'ServerUnreachable', data: { id: 'x3', name: 'edge', err: { error: 'e'.repeat(10_000) } } }
    });
    await wait(61);
    assert.ok(sent[0].text.length < 1000);
    assert.match(sent[0].text, /\(truncated\)/);
});

test('invalid TIMEZONE falls back to UTC', async () => {
    debouncer.env.TIMEZONE = 'Not/AZone';
    await post(event('ActionFailed', 'Action', { id: 'x1', name: 'nightly' }));
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Time: .* UTC$/);
});

describe('HTTP entry point', () => {
    const env = () => ({
        API_KEY_SECRET: 'secret',
        ALERT_DEBOUNCER: { idFromName: () => 'id', get: () => debouncer }
    });
    const alert = () => JSON.stringify(event('Test', 'Alerter', { id: 'x1', name: 'telegram' }, 'OK'));
    const call = (url, init) => worker.fetch(new Request(url, init), env());

    test('rejects methods other than POST', async () => {
        const res = await call('https://w/?api_key=secret', { method: 'GET' });
        assert.equal(res.status, 405);
    });

    test('rejects a missing or wrong key', async () => {
        assert.equal((await call('https://w/', { method: 'POST', body: alert() })).status, 401);
        assert.equal((await call('https://w/?api_key=nope', { method: 'POST', body: alert() })).status, 401);
        assert.equal(sent.length, 0);
    });

    test('accepts the key as a query parameter', async () => {
        const res = await call('https://w/?api_key=secret', { method: 'POST', body: alert() });
        assert.equal(res.status, 200);
        assert.equal(sent.length, 1);
    });

    test('accepts the key as basic-auth credentials', async () => {
        const headers = { Authorization: `Basic ${btoa('komodo:secret')}` };
        const res = await call('https://w/', { method: 'POST', body: alert(), headers });
        assert.equal(res.status, 200);
        assert.equal(sent.length, 1);
    });

    test('rejects a body that is not a Komodo alert', async () => {
        assert.equal((await call('https://w/?api_key=secret', { method: 'POST', body: 'not json' })).status, 400);
        assert.equal((await call('https://w/?api_key=secret', { method: 'POST', body: '{}' })).status, 400);
    });
});
