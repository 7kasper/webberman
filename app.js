(() => {
    'use strict';

    const STORAGE_KEY = 'webberman.v1';
    const DEFAULT_URL = 'ws://localhost:7070';
    const DEFAULT_BANK = 'default';
    const DEFAULT_COMPOSER_WIDTH = 380;
    const MIN_COMPOSER_WIDTH = 260;
    const MAX_COMPOSER_WIDTH = 900;
    const PREVIEW_LIMIT = 240;

    const $ = (id) => document.getElementById(id);

    // ===== state =====
    let ws = null;
    let composerMode = 'composed';
    let params = [];
    let currentTemplateId = null;
    const messageLog = []; // every entry: { t, dir, text }

    const persisted = loadPersisted();
    let banks = persisted.banks;
    let currentBank = persisted.currentBank;
    let templates = banks[currentBank];
    let lastUrl = persisted.lastUrl;
    let welcomeDismissed = persisted.welcomeDismissed;
    let composerWidth = persisted.composerWidth;

    // ===== utils =====
    const formatTime = (t) => {
        const d = new Date(t);
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    };

    const generateId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

    const tryParseJson = (text) => {
        if (typeof text !== 'string') return null;
        const t = text.trim();
        if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
        try { return JSON.parse(t); } catch { return null; }
    };

    const escapeHtml = (s) => String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    // ===== highlighters =====
    // pretty-print a parsed object with full token classes
    const highlightJson = (obj) => {
        const json = JSON.stringify(obj, null, 2);
        return tokenizeJson(json);
    };

    // permissive: works on partial / invalid input. used by the live raw overlay
    const highlightRawJson = (text) => {
        if (!text) return '';
        // append a single space so the pre never collapses a trailing newline
        return tokenizeJson(text) + ' ';
    };

    // shared tokenizer — strings (with optional close), keywords, numbers, brackets, punct
    const tokenizeJson = (text) => {
        const re = /("(?:\\.|[^"\\])*"?)|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([\[\]{}])|([,:])/g;
        let out = '';
        let last = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            if (m.index > last) out += escapeHtml(text.slice(last, m.index));
            const [, str, kw, num, bracket, punct] = m;
            if (str !== undefined) {
                const safe = escapeHtml(str);
                const after = text.slice(re.lastIndex);
                const isKey = /^\s*:/.test(after) && /"$/.test(str); // closed string followed by colon
                out += isKey
                    ? `<span class="j-key">${safe}</span>`
                    : `<span class="j-string">${safe}</span>`;
            } else if (kw !== undefined) {
                out += kw === 'null'
                    ? `<span class="j-null">${kw}</span>`
                    : `<span class="j-bool">${kw}</span>`;
            } else if (num !== undefined) {
                out += `<span class="j-number">${num}</span>`;
            } else if (bracket !== undefined) {
                out += `<span class="j-bracket">${bracket}</span>`;
            } else if (punct !== undefined) {
                out += `<span class="j-punct">${punct}</span>`;
            }
            last = re.lastIndex;
        }
        if (last < text.length) out += escapeHtml(text.slice(last));
        return out;
    };

    // ===== json tree (interactive, collapsible) =====
    const formatPrimitive = (value) => {
        if (value === null) return `<span class="j-null">null</span>`;
        if (typeof value === 'boolean') return `<span class="j-bool">${value}</span>`;
        if (typeof value === 'number') return `<span class="j-number">${value}</span>`;
        if (typeof value === 'string') return `<span class="j-string">${escapeHtml(JSON.stringify(value))}</span>`;
        return escapeHtml(String(value));
    };

    const formatKeyPrefix = (key, isArrayIndex) => {
        if (key === null) return '';
        if (isArrayIndex) {
            return `<span class="j-number tree-index">${key}</span><span class="j-punct">:</span> `;
        }
        return `<span class="j-key">"${escapeHtml(key)}"</span><span class="j-punct">:</span> `;
    };

    const inlineSummary = (value) => {
        if (value === null || typeof value !== 'object') return formatPrimitive(value);
        const isArray = Array.isArray(value);
        const count = isArray ? value.length : Object.keys(value).length;
        if (count === 0) return `<span class="j-bracket">${isArray ? '[]' : '{}'}</span>`;
        const noun = isArray
            ? (count === 1 ? 'item' : 'items')
            : (count === 1 ? 'key' : 'keys');
        return `<span class="j-bracket">${isArray ? '[' : '{'}</span><span class="tree-ellipsis">…</span><span class="j-bracket">${isArray ? ']' : '}'}</span> <span class="tree-count">${count} ${noun}</span>`;
    };

    const renderJsonTree = (value, keyLabel = null, isArrayIndex = false, expandedDefault = false, trailingComma = false) => {
        const isObj = value !== null && typeof value === 'object';
        const trail = trailingComma ? '<span class="j-punct">,</span>' : '';

        if (!isObj) {
            const row = document.createElement('div');
            row.className = 'tree-leaf';
            row.innerHTML = formatKeyPrefix(keyLabel, isArrayIndex) + formatPrimitive(value) + trail;
            return row;
        }

        const isArray = Array.isArray(value);
        const open = isArray ? '[' : '{';
        const close = isArray ? ']' : '}';
        const entries = isArray
            ? value.map((v, i) => [i, v, true])
            : Object.entries(value).map(([k, v]) => [k, v, false]);
        const count = entries.length;

        const node = document.createElement('div');
        node.className = 'tree-node';
        if (expandedDefault && count > 0) node.classList.add('expanded');

        const head = document.createElement('div');
        head.className = 'tree-head';

        const arrow = count === 0
            ? `<span class="tree-arrow placeholder"></span>`
            : `<span class="tree-arrow">▶</span>`;

        const collapsed = `<span class="tree-collapsed">${inlineSummary(value)}${trail}</span>`;
        const expandedOpen = `<span class="tree-expanded-open"><span class="j-bracket">${open}</span></span>`;

        head.innerHTML = arrow + formatKeyPrefix(keyLabel, isArrayIndex) + collapsed + expandedOpen;
        node.appendChild(head);

        if (count > 0) {
            const children = document.createElement('div');
            children.className = 'tree-children';
            entries.forEach(([k, v, isArrIdx], i) => {
                children.appendChild(renderJsonTree(v, k, isArrIdx, false, i < count - 1));
            });
            node.appendChild(children);

            const closeRow = document.createElement('div');
            closeRow.className = 'tree-close';
            closeRow.innerHTML = `<span class="j-bracket">${close}</span>${trail}`;
            node.appendChild(closeRow);

            head.addEventListener('click', (e) => {
                e.stopPropagation();
                node.classList.toggle('expanded');
            });
        }

        return node;
    };

    const isErrorResponse = (parsed) => {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
        if (parsed.error !== undefined && parsed.error !== null && parsed.error !== false) return true;
        if (typeof parsed.code === 'number' && parsed.code >= 400) return true;
        return false;
    };

    const setStatus = (state, title) => {
        const dot = $('statusDot');
        dot.dataset.state = state;
        dot.title = title || state;
    };

    // ===== persistence =====
    function loadPersisted() {
        const empty = {
            banks: { [DEFAULT_BANK]: [] },
            currentBank: DEFAULT_BANK,
            lastUrl: null,
            welcomeDismissed: false,
            composerWidth: DEFAULT_COMPOSER_WIDTH,
        };
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return empty;
            const p = JSON.parse(raw);
            let banks, currentBank;
            if (p.banks && typeof p.banks === 'object' && !Array.isArray(p.banks)) {
                banks = {};
                for (const [name, tpls] of Object.entries(p.banks)) {
                    banks[name] = (Array.isArray(tpls) ? tpls : []).map(migrateTemplate);
                }
                if (Object.keys(banks).length === 0) banks[DEFAULT_BANK] = [];
                currentBank = typeof p.currentBank === 'string' && banks[p.currentBank]
                    ? p.currentBank
                    : Object.keys(banks)[0];
            } else if (Array.isArray(p.templates)) {
                // migrate v1 single-bank format
                banks = { [DEFAULT_BANK]: p.templates.map(migrateTemplate) };
                currentBank = DEFAULT_BANK;
            } else {
                banks = { [DEFAULT_BANK]: [] };
                currentBank = DEFAULT_BANK;
            }
            return {
                banks,
                currentBank,
                lastUrl: typeof p.lastUrl === 'string' && p.lastUrl ? p.lastUrl : null,
                welcomeDismissed: !!p.welcomeDismissed,
                composerWidth: clampWidth(typeof p.composerWidth === 'number' ? p.composerWidth : DEFAULT_COMPOSER_WIDTH),
            };
        } catch {
            return empty;
        }
    }

    const migrateTemplate = (t) => {
        const out = { ...t };
        if (out.route !== undefined) {
            if (out.path === undefined) out.path = out.route;
            delete out.route;
            out.id = generateId();
        } else if (!out.id) {
            out.id = generateId();
        }
        return out;
    };

    const buildState = () => ({
        banks,
        currentBank,
        lastUrl,
        welcomeDismissed,
        composerWidth,
    });

    const persist = () => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(buildState()));
        } catch (err) {
            addEvent('error', `could not save state: ${err.message} — use "↓ export everything" to back up to a file`);
        }
    };
    const persistTemplates = persist;

    const verifyStorage = () => {
        try {
            const k = '__webberman_probe__';
            localStorage.setItem(k, '1');
            const ok = localStorage.getItem(k) === '1';
            localStorage.removeItem(k);
            return ok;
        } catch {
            return false;
        }
    };

    // ===== connection =====
    const connect = () => {
        const url = $('urlInput').value.trim();
        if (!url) return;
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return disconnect();
        }

        try {
            ws = new WebSocket(url);
        } catch (err) {
            addEvent('error', `failed to connect: ${err.message}`);
            return;
        }

        setStatus('connecting', 'connecting…');
        $('connectBtn').textContent = 'connecting…';
        addEvent('event', `→ connecting to ${url}`);

        ws.addEventListener('open', () => {
            setStatus('connected', `connected to ${url}`);
            $('connectBtn').textContent = 'disconnect';
            addEvent('event', `✓ connected to ${url}`);
            if (url !== lastUrl) {
                lastUrl = url;
                persist();
            }
        });

        ws.addEventListener('message', (e) => {
            const data = typeof e.data === 'string' ? e.data : '[binary data]';
            addMessage('in', data);
        });

        ws.addEventListener('close', (e) => {
            setStatus('disconnected', 'disconnected');
            $('connectBtn').textContent = 'connect';
            const reason = e.reason ? ` reason="${e.reason}"` : '';
            addEvent('event', `✕ closed (code=${e.code}${reason})`);
            ws = null;
        });

        ws.addEventListener('error', () => {
            setStatus('error', 'connection error');
            addEvent('error', 'connection error');
        });
    };

    const disconnect = () => {
        if (ws) {
            try { ws.close(1000, 'client closing'); } catch {}
        }
    };

    const sendOverWs = (text) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            addEvent('error', 'not connected — cannot send');
            return false;
        }
        try {
            ws.send(text);
            addMessage('out', text);
            return true;
        } catch (err) {
            addEvent('error', `send failed: ${err.message}`);
            return false;
        }
    };

    // ===== stream =====
    const ensureStreamReady = () => {
        const hint = $('stream').querySelector('.empty-hint');
        if (hint) hint.remove();
    };

    const updateCounter = () => {
        const n = messageLog.reduce((acc, e) => acc + (e.dir === 'in' || e.dir === 'out' ? 1 : 0), 0);
        $('msgCounter').textContent = n;
    };

    const appendToStream = (node) => {
        ensureStreamReady();
        const stream = $('stream');
        stream.appendChild(node);
        if ($('autoScroll').checked) stream.scrollTop = stream.scrollHeight;
    };

    const arrowFor = (dir) => ({ in: '←', out: '→', event: '·', error: '!' }[dir] || '·');

    // event-style entries (connect/close/client errors) — single-line, no body
    const isEventDir = (dir) => dir === 'event' || dir === 'error';

    const renderMessageEntry = (entry) => {
        const { t, dir, text } = entry;
        const parsed = tryParseJson(text);
        const isJson = parsed !== null;
        const isError = dir === 'in' && isErrorResponse(parsed);

        const previewSrc = isJson ? JSON.stringify(parsed) : text;
        const previewText = previewSrc.length > PREVIEW_LIMIT
            ? previewSrc.slice(0, PREVIEW_LIMIT) + '…'
            : previewSrc;

        const msg = document.createElement('div');
        msg.className = 'msg' + (isError ? ' error' : '');
        msg.dataset.dir = dir;

        const tagText = isError ? 'error' : (isJson ? 'json' : 'text');
        const tagClass = isError ? 'error' : (isJson ? 'json' : 'text');

        const header = document.createElement('div');
        header.className = 'msg-header';
        header.innerHTML = `
            <span class="msg-arrow">${arrowFor(dir)}</span>
            <span class="msg-time">${formatTime(t)}</span>
            <span class="msg-tag ${tagClass}">${tagText}</span>
            <span class="msg-preview"></span>
            <span class="msg-toggle">▶</span>
        `;
        const previewEl = header.querySelector('.msg-preview');
        if (isJson) previewEl.innerHTML = tokenizeJson(previewText);
        else previewEl.textContent = previewText;

        const body = document.createElement('div');
        body.className = 'msg-body';
        if (isJson) {
            const tree = document.createElement('div');
            tree.className = 'tree-root';
            tree.appendChild(renderJsonTree(parsed, null, false, true));
            body.appendChild(tree);
        } else {
            const pre = document.createElement('pre');
            pre.textContent = text;
            body.appendChild(pre);
        }

        header.addEventListener('click', () => msg.classList.toggle('expanded'));

        msg.appendChild(header);
        msg.appendChild(body);
        appendToStream(msg);
    };

    const renderEventEntry = (entry) => {
        const { t, dir, text } = entry;
        const msg = document.createElement('div');
        msg.className = 'msg';
        msg.dataset.dir = dir;
        const header = document.createElement('div');
        header.className = 'msg-header';
        header.innerHTML = `
            <span class="msg-arrow">${arrowFor(dir)}</span>
            <span class="msg-time">${formatTime(t)}</span>
            <span class="msg-tag text">${dir}</span>
            <span class="msg-preview"></span>
        `;
        header.querySelector('.msg-preview').textContent = text;
        msg.appendChild(header);
        appendToStream(msg);
    };

    const renderEntry = (entry) => {
        if (isEventDir(entry.dir)) renderEventEntry(entry);
        else renderMessageEntry(entry);
    };

    const addMessage = (dir, text) => {
        const entry = { t: Date.now(), dir, text };
        messageLog.push(entry);
        updateCounter();
        renderMessageEntry(entry);
    };

    const addEvent = (kind, text) => {
        const entry = { t: Date.now(), dir: kind, text };
        messageLog.push(entry);
        updateCounter();
        renderEventEntry(entry);
    };

    const clearStream = () => {
        $('stream').innerHTML = '<div class="empty-hint">no messages yet — connect to a websocket to begin.</div>';
        messageLog.length = 0;
        updateCounter();
    };

    // ===== log export / import =====
    const exportLog = () => {
        if (messageLog.length === 0) {
            addEvent('error', 'message log is empty');
            return;
        }
        const data = {
            kind: 'webberman.log',
            version: 1,
            exportedAt: new Date().toISOString(),
            url: lastUrl,
            entries: messageLog,
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.download = `webberman-log-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    };

    const importLog = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const data = JSON.parse(reader.result);
                    const raw = Array.isArray(data.entries)
                        ? data.entries
                        : (Array.isArray(data) ? data : null);
                    if (!raw) throw new Error('no "entries" array found');
                    addEvent('event', `↑ importing ${raw.length} entries from ${file.name}`);
                    let count = 0;
                    for (const e of raw) {
                        if (!e || typeof e !== 'object') continue;
                        if (typeof e.text !== 'string' || typeof e.dir !== 'string') continue;
                        const entry = {
                            t: typeof e.t === 'number' ? e.t : Date.now(),
                            dir: e.dir,
                            text: e.text,
                        };
                        messageLog.push(entry);
                        renderEntry(entry);
                        count++;
                    }
                    updateCounter();
                    addEvent('event', `✓ imported ${count} entries from ${file.name}`);
                } catch (err) {
                    addEvent('error', `import failed: ${err.message}`);
                }
            };
            reader.onerror = () => addEvent('error', 'could not read file');
            reader.readAsText(file);
        });
        input.click();
    };

    // ===== raw editor overlay =====
    const updateRawOverlay = () => {
        const text = $('rawInput').value;
        $('rawOverlay').innerHTML = highlightRawJson(text);
        syncRawScroll();
    };

    const syncRawScroll = () => {
        const ta = $('rawInput');
        const ov = $('rawOverlay');
        ov.scrollTop = ta.scrollTop;
        ov.scrollLeft = ta.scrollLeft;
    };

    // ===== composer =====
    const switchMode = (mode) => {
        composerMode = mode;
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
        $('rawMode').classList.toggle('hidden', mode !== 'raw');
        $('composedMode').classList.toggle('hidden', mode !== 'composed');
        if (mode === 'raw') updateRawOverlay();
    };

    const renderParams = () => {
        const list = $('paramsList');
        list.innerHTML = '';
        params.forEach((p, idx) => {
            const row = document.createElement('div');
            row.className = 'param-row';
            row.innerHTML = `
                <input type="text" class="p-key" placeholder="key" value="${escapeHtml(p.key)}">
                <input type="text" class="p-val" placeholder="value" value="${escapeHtml(p.value)}">
                <select class="p-type">
                    <option value="string"${p.type === 'string' ? ' selected' : ''}>string</option>
                    <option value="number"${p.type === 'number' ? ' selected' : ''}>number</option>
                    <option value="bool"${p.type === 'bool' ? ' selected' : ''}>bool</option>
                    <option value="json"${p.type === 'json' ? ' selected' : ''}>json</option>
                </select>
                <button class="remove" title="remove">✕</button>
            `;
            row.querySelector('.p-key').addEventListener('input', (e) => { params[idx].key = e.target.value; updatePreview(); });
            row.querySelector('.p-val').addEventListener('input', (e) => { params[idx].value = e.target.value; updatePreview(); });
            row.querySelector('.p-type').addEventListener('change', (e) => { params[idx].type = e.target.value; updatePreview(); });
            row.querySelector('.remove').addEventListener('click', () => { params.splice(idx, 1); renderParams(); updatePreview(); });
            list.appendChild(row);
        });
    };

    const coerceParam = (p) => {
        const raw = p.value;
        switch (p.type) {
            case 'number': {
                const n = Number(raw);
                return isNaN(n) ? raw : n;
            }
            case 'bool': return raw === 'true' || raw === '1';
            case 'json': {
                try { return JSON.parse(raw); } catch { return raw; }
            }
            default: return raw;
        }
    };

    const buildComposedMessage = (path, paramList) => {
        const obj = {};
        if (path) obj.path = path;
        const paramObj = {};
        let hasParams = false;
        for (const p of paramList) {
            if (!p.key) continue;
            paramObj[p.key] = coerceParam(p);
            hasParams = true;
        }
        if (hasParams) obj.params = paramObj;
        return obj;
    };

    const updatePreview = () => {
        const obj = buildComposedMessage($('composedPath').value.trim(), params);
        $('composedPreview').innerHTML = highlightJson(obj);
    };

    const sendRaw = () => {
        const text = $('rawInput').value;
        if (!text.trim()) return;
        sendOverWs(text);
    };

    const sendComposed = () => {
        const obj = buildComposedMessage($('composedPath').value.trim(), params);
        if (Object.keys(obj).length === 0) {
            addEvent('error', 'composed message is empty');
            return;
        }
        sendOverWs(JSON.stringify(obj));
    };

    const formatRaw = () => {
        const parsed = tryParseJson($('rawInput').value);
        if (parsed !== null) {
            $('rawInput').value = JSON.stringify(parsed, null, 2);
            updateRawOverlay();
        }
    };

    // ===== templates (current bank) =====
    const newTemplate = () => {
        currentTemplateId = null;
        $('templateName').value = '';
        $('composedPath').value = '';
        $('rawInput').value = '';
        params = [];
        renderParams();
        updatePreview();
        updateRawOverlay();
        renderTemplates();
        $('templateName').focus();
    };

    const loadTemplate = (tpl) => {
        currentTemplateId = tpl.id;
        $('templateName').value = tpl.name || '';
        if (tpl.kind === 'raw') {
            switchMode('raw');
            $('rawInput').value = tpl.raw || '';
            updateRawOverlay();
        } else {
            switchMode('composed');
            $('composedPath').value = tpl.path || '';
            params = (tpl.params || []).map(p => ({ ...p }));
            renderParams();
            updatePreview();
        }
        renderTemplates();
    };

    const collectComposerData = () => {
        const name = $('templateName').value.trim();
        if (composerMode === 'raw') {
            return { name, kind: 'raw', raw: $('rawInput').value };
        }
        return {
            name,
            kind: 'composed',
            path: $('composedPath').value.trim(),
            params: params.map(p => ({ ...p })),
        };
    };

    const saveTemplate = () => {
        const data = collectComposerData();
        if (!data.name) {
            addEvent('error', 'template needs a name');
            $('templateName').focus();
            return;
        }
        if (currentTemplateId) {
            const idx = templates.findIndex(t => t.id === currentTemplateId);
            if (idx >= 0) {
                templates[idx] = { ...templates[idx], ...data };
                persist();
                renderTemplates();
                addEvent('event', `✓ updated template "${data.name}" in bank "${currentBank}"`);
                return;
            }
        }
        const tpl = { id: generateId(), ...data };
        templates.push(tpl);
        currentTemplateId = tpl.id;
        persist();
        renderTemplates();
        addEvent('event', `✓ saved template "${data.name}" to bank "${currentBank}"`);
    };

    const sendTemplate = (tpl) => {
        if (tpl.kind === 'raw') {
            const text = tpl.raw || '';
            if (!text.trim()) {
                addEvent('error', `template "${tpl.name}" is empty`);
                return;
            }
            sendOverWs(text);
        } else {
            const obj = buildComposedMessage(tpl.path || '', tpl.params || []);
            if (Object.keys(obj).length === 0) {
                addEvent('error', `template "${tpl.name}" is empty`);
                return;
            }
            sendOverWs(JSON.stringify(obj));
        }
    };

    const renderTemplates = () => {
        $('tplCounter').textContent = templates.length;
        const list = $('templatesList');
        list.innerHTML = '';
        if (templates.length === 0) {
            list.innerHTML = '<div class="empty-hint small">no templates in this bank yet.</div>';
            return;
        }
        templates.forEach((tpl, idx) => {
            const item = document.createElement('div');
            item.className = 'template-item' + (tpl.id === currentTemplateId ? ' active' : '');
            const display = tpl.kind === 'raw' ? '(raw)' : (tpl.path || '/');
            item.innerHTML = `
                <span class="template-name"></span>
                <span class="template-path"></span>
                <span class="send-hint">click to send</span>
                <span class="template-actions">
                    <button class="load" title="load into composer">✎</button>
                    <button class="delete" title="delete">✕</button>
                </span>
            `;
            item.querySelector('.template-name').textContent = tpl.name;
            item.querySelector('.template-path').textContent = display;
            item.title = 'click to send · ✎ to load into composer';

            item.addEventListener('click', (e) => {
                if (e.target.closest('.template-actions')) return;
                sendTemplate(tpl);
            });
            item.querySelector('.load').addEventListener('click', (e) => {
                e.stopPropagation();
                loadTemplate(tpl);
            });
            item.querySelector('.delete').addEventListener('click', (e) => {
                e.stopPropagation();
                templates.splice(idx, 1);
                if (currentTemplateId === tpl.id) currentTemplateId = null;
                persist();
                renderTemplates();
            });
            list.appendChild(item);
        });
    };

    // ===== banks =====
    const renderBanks = () => {
        const sel = $('bankSelect');
        sel.innerHTML = '';
        Object.keys(banks).forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (name === currentBank) opt.selected = true;
            sel.appendChild(opt);
        });
    };

    const switchBank = (name) => {
        if (!banks[name] || name === currentBank) return;
        currentBank = name;
        templates = banks[currentBank];
        currentTemplateId = null;
        persist();
        renderBanks();
        renderTemplates();
        addEvent('event', `↻ switched to bank "${name}"`);
    };

    const uniqueBankName = (base) => {
        if (!banks[base]) return base;
        let i = 2;
        while (banks[`${base} (${i})`]) i++;
        return `${base} (${i})`;
    };

    const newBank = () => {
        const name = prompt('new bank name?');
        if (!name) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        if (banks[trimmed]) {
            addEvent('error', `bank "${trimmed}" already exists`);
            return;
        }
        banks[trimmed] = [];
        currentBank = trimmed;
        templates = banks[currentBank];
        currentTemplateId = null;
        persist();
        renderBanks();
        renderTemplates();
        addEvent('event', `+ created bank "${trimmed}"`);
    };

    const renameBank = () => {
        const next = prompt(`rename bank "${currentBank}" to:`, currentBank);
        if (!next) return;
        const trimmed = next.trim();
        if (!trimmed || trimmed === currentBank) return;
        if (banks[trimmed]) {
            addEvent('error', `bank "${trimmed}" already exists`);
            return;
        }
        // preserve insertion order via re-keying
        const rebuilt = {};
        for (const [k, v] of Object.entries(banks)) {
            rebuilt[k === currentBank ? trimmed : k] = v;
        }
        banks = rebuilt;
        currentBank = trimmed;
        templates = banks[currentBank];
        persist();
        renderBanks();
        renderTemplates();
        addEvent('event', `↻ renamed bank to "${trimmed}"`);
    };

    const deleteBank = () => {
        if (Object.keys(banks).length <= 1) {
            addEvent('error', 'cannot delete the last bank');
            return;
        }
        if (!confirm(`delete bank "${currentBank}" and its ${templates.length} template(s)?`)) return;
        delete banks[currentBank];
        const removed = currentBank;
        currentBank = Object.keys(banks)[0];
        templates = banks[currentBank];
        currentTemplateId = null;
        persist();
        renderBanks();
        renderTemplates();
        addEvent('event', `✕ deleted bank "${removed}"`);
    };

    const exportBank = () => {
        const data = {
            kind: 'webberman.bank',
            version: 1,
            name: currentBank,
            templates,
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safeName = currentBank.replace(/[^a-z0-9._-]+/gi, '_');
        a.download = `${safeName}.webberman.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        addEvent('event', `↓ exported bank "${currentBank}" (${templates.length} template(s))`);
    };

    const exportConfig = () => {
        const data = {
            kind: 'webberman.config',
            version: 1,
            exportedAt: new Date().toISOString(),
            state: buildState(),
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.download = `webberman-config-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        addEvent('event', `↓ exported full config (${Object.keys(banks).length} bank(s))`);
    };

    const importConfig = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const data = JSON.parse(reader.result);
                    const state = data.state || data;
                    if (!state || typeof state !== 'object' || !state.banks || typeof state.banks !== 'object') {
                        throw new Error('not a valid webberman config (missing "banks")');
                    }
                    const newBanks = {};
                    for (const [name, tpls] of Object.entries(state.banks)) {
                        newBanks[name] = (Array.isArray(tpls) ? tpls : []).map(migrateTemplate);
                    }
                    if (Object.keys(newBanks).length === 0) newBanks[DEFAULT_BANK] = [];
                    banks = newBanks;
                    currentBank = (typeof state.currentBank === 'string' && banks[state.currentBank])
                        ? state.currentBank
                        : Object.keys(banks)[0];
                    templates = banks[currentBank];
                    currentTemplateId = null;
                    if (typeof state.lastUrl === 'string' && state.lastUrl) {
                        lastUrl = state.lastUrl;
                        $('urlInput').value = lastUrl;
                    }
                    if (typeof state.welcomeDismissed === 'boolean') welcomeDismissed = state.welcomeDismissed;
                    if (typeof state.composerWidth === 'number') applyComposerWidth(state.composerWidth);
                    persist();
                    renderBanks();
                    renderTemplates();
                    newTemplate();
                    addEvent('event', `↑ imported config from ${file.name} (${Object.keys(banks).length} bank(s))`);
                } catch (err) {
                    addEvent('error', `import failed: ${err.message}`);
                }
            };
            reader.onerror = () => addEvent('error', 'could not read file');
            reader.readAsText(file);
        });
        input.click();
    };

    const importBank = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const data = JSON.parse(reader.result);
                    const tpls = Array.isArray(data.templates)
                        ? data.templates
                        : (Array.isArray(data) ? data : null);
                    if (!tpls) throw new Error('no "templates" array found');
                    const baseName = (typeof data.name === 'string' && data.name)
                        ? data.name
                        : file.name.replace(/\.webberman\.json$/i, '').replace(/\.json$/i, '');
                    const finalName = uniqueBankName(baseName || 'imported');
                    banks[finalName] = tpls.map(t => migrateTemplate(t));
                    currentBank = finalName;
                    templates = banks[currentBank];
                    currentTemplateId = null;
                    persist();
                    renderBanks();
                    renderTemplates();
                    addEvent('event', `↑ imported bank "${finalName}" (${tpls.length} template(s))`);
                } catch (err) {
                    addEvent('error', `import failed: ${err.message}`);
                }
            };
            reader.onerror = () => addEvent('error', `could not read file: ${reader.error?.message || 'unknown'}`);
            reader.readAsText(file);
        });
        input.click();
    };

    // ===== splitter =====
    const clampWidth = (w) => Math.max(MIN_COMPOSER_WIDTH, Math.min(MAX_COMPOSER_WIDTH, Math.round(w)));

    const applyComposerWidth = (w) => {
        composerWidth = clampWidth(w);
        document.documentElement.style.setProperty('--composer-width', composerWidth + 'px');
    };

    let dragging = false;
    const onSplitterDown = (e) => {
        dragging = true;
        document.body.classList.add('resizing');
        e.preventDefault();
    };
    const onSplitterMove = (e) => {
        if (!dragging) return;
        const w = window.innerWidth - e.clientX - 3; // 3 = half of splitter width
        applyComposerWidth(w);
    };
    const onSplitterUp = () => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('resizing');
        persist();
    };

    // ===== welcome modal =====
    const showWelcome = () => { $('welcomeModal').hidden = false; };
    const dismissWelcome = () => {
        $('welcomeModal').hidden = true;
        if (!welcomeDismissed) {
            welcomeDismissed = true;
            persist();
        }
    };

    // ===== bank menu popover =====
    const toggleBankMenu = (force) => {
        const menu = $('bankMenu');
        const next = typeof force === 'boolean' ? !force : !menu.hidden;
        // hidden=true to close, hidden=false to open — we set the opposite
        menu.hidden = next;
    };
    const closeBankMenu = () => { $('bankMenu').hidden = true; };

    // ===== wiring =====
    const init = () => {
        // apply persisted width before first paint
        applyComposerWidth(composerWidth);

        $('connectBtn').addEventListener('click', connect);
        $('clearBtn').addEventListener('click', clearStream);
        $('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });

        $('exportLogBtn').addEventListener('click', exportLog);
        $('importLogBtn').addEventListener('click', importLog);

        if (lastUrl) $('urlInput').value = lastUrl;

        // tabs
        document.querySelectorAll('.tab').forEach(t => {
            t.addEventListener('click', () => switchMode(t.dataset.mode));
        });

        // raw editor
        $('sendRawBtn').addEventListener('click', sendRaw);
        $('formatRawBtn').addEventListener('click', formatRaw);
        $('rawInput').addEventListener('input', updateRawOverlay);
        $('rawInput').addEventListener('scroll', syncRawScroll);
        $('rawInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendRaw(); }
        });

        // composed mode
        $('sendComposedBtn').addEventListener('click', sendComposed);
        $('addParamBtn').addEventListener('click', () => {
            params.push({ key: '', value: '', type: 'string' });
            renderParams();
            updatePreview();
        });
        $('composedPath').addEventListener('input', updatePreview);
        $('composedPath').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); sendComposed(); }
        });

        // templates
        $('saveTemplateBtn').addEventListener('click', saveTemplate);
        $('newTemplateBtn').addEventListener('click', newTemplate);
        $('templateName').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); saveTemplate(); }
        });

        // banks
        $('bankSelect').addEventListener('change', (e) => switchBank(e.target.value));
        $('bankMenuBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            const menu = $('bankMenu');
            menu.hidden = !menu.hidden;
        });
        document.addEventListener('click', (e) => {
            if (!$('bankMenu').hidden && !e.target.closest('.bank-control')) closeBankMenu();
        });
        $('bankMenu').querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                closeBankMenu();
                if (action === 'new') newBank();
                else if (action === 'rename') renameBank();
                else if (action === 'delete') deleteBank();
                else if (action === 'export') exportBank();
                else if (action === 'import') importBank();
                else if (action === 'export-all') exportConfig();
                else if (action === 'import-all') importConfig();
            });
        });

        // splitter
        $('splitter').addEventListener('mousedown', onSplitterDown);
        document.addEventListener('mousemove', onSplitterMove);
        document.addEventListener('mouseup', onSplitterUp);

        // welcome modal
        $('dismissWelcome').addEventListener('click', dismissWelcome);
        $('closeWelcome').addEventListener('click', dismissWelcome);
        $('welcomeModal').addEventListener('click', (e) => {
            if (e.target === $('welcomeModal')) dismissWelcome();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (!$('welcomeModal').hidden) dismissWelcome();
                else if (!$('bankMenu').hidden) closeBankMenu();
            }
        });
        if (!welcomeDismissed) showWelcome();

        // initial render
        switchMode('composed');
        renderBanks();
        renderTemplates();
        renderParams();
        updatePreview();
        updateRawOverlay();
        setStatus('disconnected', 'disconnected');

        // storage health check — warn if browser is blocking persistent storage
        if (!verifyStorage()) {
            addEvent('error', 'localStorage is unavailable in this browser/context. your settings & banks won\'t persist between sessions. use the bank menu (⋯) → "↓ export everything" to back up to a file.');
        } else if (location.protocol === 'file:') {
            // file:// can be flaky depending on browser config — leave a quiet hint after a fresh load
            const seen = sessionStorage.getItem('__webberman_seen__');
            if (!seen) {
                sessionStorage.setItem('__webberman_seen__', '1');
                if (Object.keys(banks).length === 1 && banks[DEFAULT_BANK] && banks[DEFAULT_BANK].length === 0 && !lastUrl) {
                    // fresh state — could be first run, or storage might have been cleared.
                    // tip is intentionally subtle so it isn't annoying after a real first run.
                    addEvent('event', 'tip: if your saved state keeps disappearing on refresh, your browser may be clearing file:// storage. use the bank menu (⋯) → "↓ export everything" for a reliable backup.');
                }
            }
        }
    };

    document.addEventListener('DOMContentLoaded', init);
})();
