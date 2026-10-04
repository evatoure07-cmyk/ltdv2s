const express = require('express');
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Secrets: keep these on Render, never in GitHub/browser code.
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK_URL || process.env.WEBHOOK_URL || '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const SUPABASE_URL = String(process.env.SUPABASE_URL || '')
  .trim()
  .replace(/\/rest\/v1\/?$/i, '')
  .replace(/\/+$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || 'ltd_state';
const STATE_ID = 1;

const CACHE_FILE = path.join(__dirname, 'data-cache.json');
let memoryCache = null;

app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname)));

function emptyData() {
  return { schemaVersion: 3, revision: 0, updatedAt: 0, orders: [], companies: [], products: [], categories: [] };
}

function normalizeData(input) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    ...emptyData(),
    ...src,
    schemaVersion: 3,
    revision: Number(src.revision || 0) || 0,
    updatedAt: Number(src.updatedAt || src._updatedAt || 0) || 0,
    orders: Array.isArray(src.orders) ? src.orders : [],
    companies: Array.isArray(src.companies) ? src.companies : [],
    products: Array.isArray(src.products) ? src.products : [],
    categories: Array.isArray(src.categories) ? src.categories : []
  };
}

function hasUsefulData(data) {
  const d = normalizeData(data);
  return d.orders.length > 0 || d.companies.length > 0 || d.products.length > 0 || d.categories.length > 0;
}

function readCache() {
  if (memoryCache) return normalizeData(memoryCache);
  try {
    memoryCache = normalizeData(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')));
    return normalizeData(memoryCache);
  } catch {
    return emptyData();
  }
}

function writeCache(data) {
  memoryCache = normalizeData(data);
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(memoryCache, null, 2)); }
  catch (e) { console.error('Cache write:', e.message); }
}

function storageConfig() {
  return {
    configured: Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY),
    readConfigured: Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY),
    writeConfigured: Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY),
    mode: 'supabase',
    table: SUPABASE_TABLE
  };
}

async function remoteFetch(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function supabaseHeaders(extra = {}) {
  const headers = {
    apikey: SUPABASE_SECRET_KEY,
    Accept: 'application/json',
    ...extra
  };
  // Legacy JWT service_role keys still use Bearer auth; modern sb_secret_* keys must not.
  if (SUPABASE_SECRET_KEY.startsWith('eyJ')) {
    headers.Authorization = `Bearer ${SUPABASE_SECRET_KEY}`;
  }
  return headers;
}

async function getRemoteData() {
  if (!storageConfig().configured) throw new Error('Supabase non configuré sur Render');
  const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(SUPABASE_TABLE)}?id=eq.${encodeURIComponent(STATE_ID)}&select=data,revision,updated_at&limit=1`;
  const r = await remoteFetch(url, { headers: supabaseHeaders() });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase GET ${r.status}: ${text.slice(0, 500)}`);
  let rows;
  try { rows = JSON.parse(text); }
  catch { throw new Error('Supabase a renvoyé une réponse invalide'); }
  if (!Array.isArray(rows) || !rows.length) return null;
  const row = rows[0] || {};
  const data = normalizeData(row.data || {});
  data.revision = Math.max(Number(data.revision || 0), Number(row.revision || 0));
  if (!data.updatedAt && row.updated_at) data.updatedAt = Date.parse(row.updated_at) || 0;
  return data;
}

async function saveRemoteData(data) {
  if (!storageConfig().configured) throw new Error('Supabase non configuré sur Render');
  const current = normalizeData(data);
  const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(SUPABASE_TABLE)}?on_conflict=id`;
  const payload = [{
    id: STATE_ID,
    data: current,
    revision: Number(current.revision || 0),
    updated_at: new Date(Number(current.updatedAt || Date.now())).toISOString()
  }];
  const r = await remoteFetch(url, {
    method: 'POST',
    headers: supabaseHeaders({
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation'
    }),
    body: JSON.stringify(payload)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase SAVE ${r.status}: ${text.slice(0, 500)}`);
  return { ok: true, status: r.status, bytes: Buffer.byteLength(JSON.stringify(current)) };
}

async function getDataSafe() {
  const cache = readCache();
  if (!storageConfig().configured) {
    return { data: cache, source: 'server-cache', remoteAvailable: false, remoteInitialized: false };
  }
  try {
    const remote = await getRemoteData();
    if (!remote) {
      return { data: cache, source: 'supabase-empty', remoteAvailable: true, remoteInitialized: false };
    }
    const cacheTs = Number(cache.updatedAt || 0);
    const remoteTs = Number(remote.updatedAt || 0);
    const data = cacheTs > remoteTs && hasUsefulData(cache) ? cache : remote;
    writeCache(data);
    return {
      data,
      source: cacheTs > remoteTs && hasUsefulData(cache) ? 'server-cache-newer' : 'supabase',
      remoteAvailable: true,
      remoteInitialized: true
    };
  } catch (e) {
    console.error('Supabase load failed:', e.message);
    return { data: cache, source: 'server-cache-fallback', remoteAvailable: false, remoteInitialized: false, remoteError: e.message };
  }
}

async function persistData(input) {
  const current = normalizeData(input);
  current.updatedAt = Number(current.updatedAt || Date.now()) || Date.now();
  writeCache(current);

  if (!storageConfig().configured) {
    return { ok: false, configured: false, cached: true, error: 'Supabase non configuré sur Render' };
  }
  try {
    const remote = await saveRemoteData(current);
    return { ok: true, configured: true, cached: true, ...remote };
  } catch (e) {
    console.error('Supabase save failed:', e.message);
    return { ok: false, configured: true, cached: true, error: e.message };
  }
}


const DISCORD_STATUS = {
  awaiting_payment: { emoji: '💵', label: 'En attente de paiement', color: 0xC9A84C },
  missing: { emoji: '🟠', label: 'Manque des choses', color: 0xD97706 },
  ready: { emoji: '🟡', label: 'Commande prête dans son coffre', color: 0xEAB308 },
  done: { emoji: '🟢', label: 'Livré', color: 0x16A34A },
  refused: { emoji: '🔴', label: 'Refusé', color: 0xDC2626 },
  pending: { emoji: '💵', label: 'En attente de paiement', color: 0xC9A84C },
  validated: { emoji: '🟠', label: 'Manque des choses', color: 0xD97706 },
  cancel: { emoji: '🔴', label: 'Refusé', color: 0xDC2626 }
};
const REACTION_TO_STATUS = new Map([
  ['💵','awaiting_payment'],
  ['🟠','missing'],
  ['🟡','ready'],
  ['🟢','done'],
  ['🔴','refused']
]);

let discordClient = null;
let discordReadyResolve = null;
const discordReadyPromise = new Promise(resolve => { discordReadyResolve = resolve; });

function discordStatusMeta(status) {
  return DISCORD_STATUS[status] || DISCORD_STATUS.awaiting_payment;
}
function safeThreadName(order, status) {
  const meta = discordStatusMeta(status);
  const company = String(order.company || 'Entreprise').replace(/\s+/g, ' ').trim();
  return `${meta.emoji} ${order.id} · ${company} · ${meta.label}`.slice(0, 100);
}
async function waitForDiscordReady(timeoutMs = 8000) {
  if (!DISCORD_BOT_TOKEN) return false;
  if (discordClient?.isReady()) return true;
  return await Promise.race([
    discordReadyPromise.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), timeoutMs))
  ]);
}
async function updateOrderFromDiscord(orderId, status, userTag = 'Discord') {
  const { data } = await getDataSafe();
  const current = normalizeData(data);
  const idx = current.orders.findIndex(o => o.id === orderId);
  if (idx < 0) throw new Error('Commande introuvable');
  const order = current.orders[idx];
  order.status = status;
  order.statusHistory = order.statusHistory || [];
  order.statusHistory.push({
    status,
    date: new Date().toLocaleDateString('fr-FR'),
    time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
    source: 'discord',
    by: userTag
  });
  current.updatedAt = Date.now();
  current.revision = Number(current.revision || 0) + 1;
  const saved = await persistData(current);
  if (!saved.ok) throw new Error(saved.error || 'Sauvegarde Supabase impossible');
  return order;
}
async function syncDiscordThreadStatus(order, status) {
  if (!order?.discord?.threadId || !(await waitForDiscordReady())) return false;
  try {
    const thread = await discordClient.channels.fetch(order.discord.threadId);
    if (thread?.setName) await thread.setName(safeThreadName(order, status), `Statut ${order.id}: ${discordStatusMeta(status).label}`);
    return true;
  } catch (e) {
    console.error('Discord thread rename failed:', e.message);
    return false;
  }
}
async function setupDiscordThread(order, webhookMessage) {
  if (!(await waitForDiscordReady())) return { ok: false, error: 'Bot Discord non configuré ou non prêt' };
  try {
    const channel = await discordClient.channels.fetch(webhookMessage.channel_id);
    if (!channel?.messages) throw new Error('Salon Discord introuvable ou non textuel');
    const starter = await channel.messages.fetch(webhookMessage.id);
    const thread = await starter.startThread({
      name: safeThreadName(order, order.status || 'awaiting_payment'),
      autoArchiveDuration: 1440,
      reason: `Commande ${order.id}`
    });
    const control = await thread.send({
      content:
        `**Pilotage de la commande ${order.id}**\n` +
        `Réagis avec le statut voulu :\n` +
        `🔴 = Refusé\n` +
        `🟠 = Manque des choses\n` +
        `🟡 = Commande prête dans son coffre\n` +
        `🟢 = Livré\n` +
        `💵 = En attente de paiement`
    });
    for (const emoji of ['🔴','🟠','🟡','🟢','💵']) {
      await control.react(emoji).catch(() => {});
    }
    return {
      ok: true,
      messageId: webhookMessage.id,
      channelId: webhookMessage.channel_id,
      threadId: thread.id,
      controlMessageId: control.id
    };
  } catch (e) {
    console.error('Discord thread setup failed:', e.message);
    return { ok: false, error: e.message };
  }
}

if (DISCORD_BOT_TOKEN) {
  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User]
  });

  discordClient.once('ready', () => {
    console.log('Discord bot connected as', discordClient.user?.tag);
    discordReadyResolve?.();
  });

  discordClient.on('messageReactionAdd', async (reaction, user) => {
    try {
      if (user?.bot) return;
      if (reaction.partial) await reaction.fetch();
      if (reaction.message?.partial) await reaction.message.fetch();
      const status = REACTION_TO_STATUS.get(reaction.emoji?.name);
      if (!status) return;

      const { data } = await getDataSafe();
      const current = normalizeData(data);
      const order = current.orders.find(o =>
        o?.discord?.controlMessageId === reaction.message.id
      );
      if (!order) return;

      const updated = await updateOrderFromDiscord(order.id, status, user.tag || user.username || 'Discord');
      await syncDiscordThreadStatus(updated, status);
      await reaction.users.remove(user.id).catch(() => {});
      await reaction.message.channel.send(
        `${discordStatusMeta(status).emoji} **Statut mis à jour : ${discordStatusMeta(status).label}**`
      ).catch(() => {});
    } catch (e) {
      console.error('Discord reaction status error:', e.message);
    }
  });

  discordClient.login(DISCORD_BOT_TOKEN).catch(e => {
    console.error('Discord bot login failed:', e.message);
    discordReadyResolve?.();
  });
} else {
  discordReadyResolve?.();
}

async function sendDiscord(order) {
  if (!DISCORD_WEBHOOK) return { ok: false, error: 'DISCORD_WEBHOOK non configuré' };
  const prodLines = (order.products || [])
    .map(p => `> **${p.name}** — ${p.qty} × $${p.price} = **$${p.qty * p.price}**`)
    .join('\n').slice(0, 1000) || '—';
  const meta = discordStatusMeta(order.status || 'awaiting_payment');
  const embed = {
    username: 'Maritza · LTD Sandy Shores',
    embeds: [{
      title: `${meta.emoji} Nouvelle commande — ${order.id}`,
      color: meta.color,
      fields: [
        { name: '🏢 Entreprise', value: String(order.company || '—').slice(0, 1024), inline: true },
        { name: '📞 Téléphone', value: String(order.tel || '—').slice(0, 1024), inline: true },
        { name: '🏦 IBAN', value: '||' + String(order.iban || '—').slice(0, 1000) + '||', inline: true },
        { name: '📦 Produits', value: prodLines, inline: false },
        { name: '⚖️ Poids', value: String(order.weight || 0) + ' kg', inline: true },
        { name: '🚚 Livraison', value: order.freeDelivery ? '✅ Offerte' : '$50', inline: true },
        { name: '💰 Total', value: '**$' + Number(order.total || 0).toLocaleString('fr-FR') + '**', inline: true },
        { name: '📍 Adresse', value: String(order.adresse || '—').slice(0, 1024), inline: false },
        { name: '📅 Date', value: String(order.date || '—'), inline: true },
        { name: '🕐 Horaire', value: String(order.horaire || '—'), inline: true },
        { name: '📌 Statut', value: `${meta.emoji} **${meta.label}**`, inline: false }
      ],
      footer: { text: 'LTD Sandy Shores · Commandes' },
      timestamp: new Date().toISOString()
    }]
  };
  const target = DISCORD_WEBHOOK + (DISCORD_WEBHOOK.includes('?') ? '&' : '?') + 'wait=true';
  const r = await remoteFetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(embed)
  });
  const body = await r.text();
  if (!r.ok) return { ok: false, error: `Discord ${r.status}: ${body.slice(0, 300)}` };

  let webhookMessage = null;
  try { webhookMessage = JSON.parse(body); } catch {}
  if (!webhookMessage?.id || !webhookMessage?.channel_id) {
    return { ok: true, status: r.status, thread: { ok: false, error: 'Réponse Discord sans identifiants de message' } };
  }
  const thread = await setupDiscordThread(order, webhookMessage);
  const discord = thread.ok ? thread : {
    messageId: webhookMessage.id,
    channelId: webhookMessage.channel_id
  };
  return { ok: true, status: r.status, thread, discord };
}

app.get('/api/data', async (req, res) => {
  const result = await getDataSafe();
  res.json({
    ...normalizeData(result.data),
    _source: result.source,
    _remoteAvailable: result.remoteAvailable,
    _remoteInitialized: result.remoteInitialized,
    _remoteError: result.remoteError || ''
  });
});

app.post('/api/save', async (req, res) => {
  try {
    const body = normalizeData(req.body);
    body.updatedAt = Date.now();
    body.revision = Math.max(Number(body.revision || 0), Number(readCache().revision || 0)) + 1;
    const remote = await persistData(body);
    if (!remote.ok) {
      return res.status(503).json({
        ok: false,
        localCached: true,
        remoteSaved: false,
        error: remote.error,
        configured: remote.configured,
        updatedAt: body.updatedAt,
        revision: body.revision
      });
    }
    res.json({
      ok: true,
      localCached: true,
      remoteSaved: true,
      updatedAt: body.updatedAt,
      revision: body.revision,
      bytes: remote.bytes
    });
  } catch (e) {
    console.error('Save failed:', e.message);
    res.status(500).json({ ok: false, localCached: false, remoteSaved: false, error: e.message });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    const order = req.body;
    if (!order || !order.id || !order.company || !Array.isArray(order.products)) {
      return res.status(400).json({ ok: false, error: 'Commande invalide' });
    }
    if (!order.status || order.status === 'pending') order.status = 'awaiting_payment';
    order.statusHistory = Array.isArray(order.statusHistory) ? order.statusHistory : [];
    if (!order.statusHistory.length || order.statusHistory[order.statusHistory.length - 1]?.status !== order.status) {
      order.statusHistory.push({
        status: order.status,
        date: new Date().toLocaleDateString('fr-FR'),
        time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
        source: 'order'
      });
    }

    const { data } = await getDataSafe();
    const current = normalizeData(data);
    const existing = current.orders.findIndex(o => o.id === order.id);
    if (existing < 0) current.orders.push(order);
    else current.orders[existing] = { ...current.orders[existing], ...order };

    const discord = await sendDiscord(order).catch(e => ({ ok: false, error: e.message }));
    const idx = current.orders.findIndex(o => o.id === order.id);
    if (idx >= 0 && discord?.discord) current.orders[idx].discord = discord.discord;

    current.updatedAt = Date.now();
    current.revision = Number(current.revision || 0) + 1;
    writeCache(current);
    const storage = await persistData(current);

    res.status(discord.ok ? 200 : 207).json({
      ok: true,
      saved: true,
      localCached: true,
      remoteSaved: storage.ok,
      storageError: storage.ok ? '' : storage.error,
      discord,
      updatedAt: current.updatedAt,
      revision: current.revision
    });
  } catch (e) {
    console.error('Order create failed:', e.message);
    res.status(500).json({ ok: false, saved: false, error: e.message });
  }
});

app.post('/api/notify', async (req, res) => {
  try {
    const result = await sendDiscord(req.body || {});
    res.status(result.ok ? 200 : 502).json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/discord/status', async (req, res) => {
  try {
    const { orderId, status } = req.body || {};
    const allowed = ['pending','awaiting_payment','missing','validated','ready','done','refused','cancel'];
    if (!orderId || !allowed.includes(status)) {
      return res.status(400).json({ ok: false, error: 'Statut invalide' });
    }
    const { data } = await getDataSafe();
    const current = normalizeData(data);
    const idx = current.orders.findIndex(o => o.id === orderId);
    if (idx < 0) return res.status(404).json({ ok: false, error: 'Commande introuvable' });
    current.orders[idx].status = status;
    current.orders[idx].statusHistory = current.orders[idx].statusHistory || [];
    current.orders[idx].statusHistory.push({
      status,
      date: new Date().toLocaleDateString('fr-FR'),
      time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
      source: 'admin'
    });
    current.updatedAt = Date.now();
    current.revision = Number(current.revision || 0) + 1;
    const saved = await persistData(current);
    const threadUpdated = await syncDiscordThreadStatus(current.orders[idx], status);
    res.status(saved.ok ? 200 : 503).json({ ok: saved.ok, remoteSaved: saved.ok, threadUpdated, error: saved.error || '' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/test-webhook', async (req, res) => {
  try {
    if (!DISCORD_WEBHOOK) return res.status(500).json({ ok: false, error: 'Webhook Discord non configuré sur Render' });
    const target = DISCORD_WEBHOOK + (DISCORD_WEBHOOK.includes('?') ? '&' : '?') + 'wait=true';
    const r = await remoteFetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '✅ Test webhook Maritza · LTD Sandy Shores — connexion Discord OK.' })
    });
    const body = await r.text();
    if (!r.ok) return res.status(502).json({ ok: false, status: r.status, error: body.slice(0, 500) });
    res.json({ ok: true, status: r.status, message: 'Message test envoyé sur Discord' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/diagnostics', async (req, res) => {
  const cfg = storageConfig();
  let remoteRead = false;
  let remoteInitialized = false;
  let remoteError = '';
  let remoteUpdatedAt = 0;
  if (cfg.readConfigured) {
    try {
      const d = await getRemoteData();
      remoteRead = true;
      remoteInitialized = Boolean(d);
      remoteUpdatedAt = d?.updatedAt || 0;
    } catch (e) { remoteError = e.message; }
  }
  const cache = readCache();
  res.json({
    ok: true,
    discordConfigured: Boolean(DISCORD_WEBHOOK),
    discordBotConfigured: Boolean(DISCORD_BOT_TOKEN),
    discordBotReady: Boolean(discordClient?.isReady()),
    storage: { ...cfg, remoteRead, remoteInitialized, remoteError, remoteUpdatedAt },
    cache: {
      updatedAt: cache.updatedAt || 0,
      revision: cache.revision || 0,
      orders: cache.orders.length,
      companies: cache.companies.length,
      products: cache.products.length
    }
  });
});

app.get('/api/backup', async (req, res) => {
  const { data } = await getDataSafe();
  res.setHeader('Content-Disposition', `attachment; filename="ltd-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(normalizeData(data));
});

app.get('/health', (req, res) => res.status(200).json({
  ok: true,
  storage: 'supabase',
  storageConfigured: storageConfig().configured,
  discordConfigured: Boolean(DISCORD_WEBHOOK),
  discordBotConfigured: Boolean(DISCORD_BOT_TOKEN),
  discordBotReady: Boolean(discordClient?.isReady())
}));

app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log('LTD Sandy Shores on port', PORT);
  console.log('Discord webhook configured:', Boolean(DISCORD_WEBHOOK));
  console.log('Persistent storage:', storageConfig());
});
