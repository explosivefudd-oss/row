// =============================================================
// Shared cloud-sync helper. Each page calls initCloudSync({...}).
// =============================================================
(function () {
  'use strict';
  const SUPABASE_URL = 'https://fsyshmdctxdofuecxmmt.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_ckG9j-gTn7RieXFVkofszw_wpsfQy6l';

  window.initCloudSync = function (config) {
    const appKey         = config && config.appKey;
    const syncedKeys     = (config && config.syncedKeys)    || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied      = config && config.onApplied;
    if (!appKey || !window.supabase) return;
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;

    let supa = null, pushTimer = null, suppressSync = false, lastSyncedJson = null;

    // ---- key matching ----
    function matches(k) {
      if (!k) return false;
      if (syncedKeys.indexOf(k) !== -1) return true;
      for (let i = 0; i < syncedPrefixes.length; i++) {
        if (k.indexOf(syncedPrefixes[i]) === 0) return true;
      }
      return false;
    }
    function listAllKeys() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (matches(k)) out.push(k);
      }
      return out;
    }
    function collect() {
      const out = {};
      for (const k of listAllKeys()) {
        const v = localStorage.getItem(k);
        if (v == null) continue;
        try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
      }
      return out;
    }

    // ---- intercept localStorage writes ----
    const origSet    = localStorage.setItem.bind(localStorage);
    const origRemove = localStorage.removeItem.bind(localStorage);
    localStorage.setItem = function (k, v) {
      origSet(k, v);
      try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      origRemove(k);
      try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };

    // ---- apply data received from cloud ----
    function applyRemote(remote) {
      if (!remote || typeof remote !== 'object') return false;
      suppressSync = true;
      let changed = false;
      try {
        for (const k of Object.keys(remote)) {
          if (!matches(k)) continue;
          const incoming = JSON.stringify(remote[k]);
          const local = localStorage.getItem(k);
          if (local !== incoming) { try { origSet(k, incoming); changed = true; } catch (e) {} }
        }
        for (const k of listAllKeys()) {
          if (!(k in remote)) { try { origRemove(k); changed = true; } catch (e) {} }
        }
      } finally { suppressSync = false; }
      if (changed && typeof onApplied === 'function') { try { onApplied(); } catch (e) {} }
      return changed;
    }

    // ---- push local state to Supabase ----
    async function pushNow() {
      if (!supa) return;
      const state = collect();
      const json  = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: state, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) lastSyncedJson = json;
      } catch (e) {}
    }
    function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 250); }

    // keepalive fetch used when the page might be dying (iOS pagehide / visibilitychange hidden)
    function flushOnUnload() {
      const state = collect();
      const json  = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: state, updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {});
        lastSyncedJson = json;
      } catch (e) {}
    }

    // ---- pull latest from Supabase ----
    async function pullNow() {
      if (!supa) return;
      try {
        const { data, error } = await supa
          .from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (!error && data && data.data) {
          const incoming = JSON.stringify(data.data);
          if (incoming !== lastSyncedJson) {
            lastSyncedJson = incoming;
            applyRemote(data.data);
          }
        }
      } catch (e) {}
    }

    // ---- boot ----
    (async function init() {
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

      // Pull on load — get whatever is newest in the cloud
      try {
        const { data, error } = await supa
          .from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (!error && data && data.data && Object.keys(data.data).length > 0) {
          lastSyncedJson = JSON.stringify(data.data);
          applyRemote(data.data);
        } else if (Object.keys(collect()).length > 0) {
          schedulePush();
        }
      } catch (e) {}

      // Real-time subscription — remote change arrives within ~1 s
      supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + appKey,
        }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          const incoming = JSON.stringify(payload.new.data);
          if (incoming === lastSyncedJson) return;
          lastSyncedJson = incoming;
          applyRemote(payload.new.data);
        })
        .subscribe();
    })();

    // ---- event listeners ----

    // Standard unload — desktop browsers
    window.addEventListener('beforeunload', flushOnUnload);

    // iOS Safari: pagehide fires more reliably than beforeunload
    window.addEventListener('pagehide', flushOnUnload);

    // iOS Safari: visibilitychange is the most reliable "app switch" signal.
    // Push immediately when hidden; pull when the user comes back (another
    // device may have updated while they were away).
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        flushOnUnload();   // keepalive push — page may die immediately after
      } else {
        pullNow();         // back in foreground — fetch latest from cloud
      }
    });

    // BFCache restore (iOS often serves pages from cache without re-running JS)
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) pullNow();
    });

    // Window regains focus (switching back from another app or tab)
    window.addEventListener('focus', pullNow);

    // Cross-tab sync (another tab on the same device wrote to localStorage)
    window.addEventListener('storage', (e) => {
      if (e.key && matches(e.key)) schedulePush();
    });

    // Heartbeat: push any unsent changes every 30 s.
    // Catches the case where a push silently failed and nothing retried it.
    setInterval(() => {
      const json = JSON.stringify(collect());
      if (json !== lastSyncedJson) pushNow();
    }, 30_000);
  };
})();
