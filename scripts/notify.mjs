// BrickFeed — postino delle notifiche push.
// Gira su GitHub Actions: legge le fonti di ogni utente da Firestore (mai nel
// codice), controlla se ci sono notizie nuove e manda un push ai dispositivi
// iscritti. Ad ogni giro salva su Firestore le chiavi già notificate.
import admin from 'firebase-admin';
import webpush from 'web-push';

const VAPID_PUBLIC = 'BKodQ5y7xAtsmjFySGu-mDiMrKJVK4uVhDpNAsbgTy5zUaSUglRrPJo3Vjm6FtJp7H0Y85lYsVF6bZVgWYkVnMU';
const APP_URL = 'https://itavix.github.io/brickfeed/';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; BrickFeedNotifier/1.0)' };
const NOTIFIED_CAP = 800;

webpush.setVapidDetails('mailto:clauditavi@gmail.com', VAPID_PUBLIC, process.env.VAPID_PRIVATE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});
const db = admin.firestore();

/* ---------------- fetch helpers ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getOnce(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally { clearTimeout(t); }
}

async function get(url, timeoutMs = 15000) {
  try {
    return await getOnce(url, timeoutMs);
  } catch (e) {
    // rate limit: la pausa lunga risolve (verificato: 12s bastano a Reddit)
    if (/HTTP 429/.test(e.message)) {
      await sleep(12000);
      try { return await getOnce(url, timeoutMs); } catch (e2) { e = e2; }
    }
    // ultima spiaggia: proxy testuale (corsproxy vieta l'uso server-side, allorigins no)
    try {
      const text = await getOnce('https://api.allorigins.win/raw?url=' + encodeURIComponent(url), timeoutMs);
      if (text && text.length > 10) return text;
    } catch (_) {}
    throw e;
  }
}

const strip = h => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

// chiave di contenuto: identica alla logica dell'app per i profili social
const key = (title, extra = '') => (title + ' ' + extra).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);

/* ---------------- parser leggeri (regex) ---------------- */
function parseXmlItems(xml) {
  const out = [];
  const blocks = xml.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi) || [];
  for (const b of blocks) {
    const title = strip((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(b) || [, ''])[1]
      .replace(/<!\[CDATA\[|\]\]>/g, ''));
    const date = (/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\//i.exec(b) || [, ''])[1].trim();
    if (title) out.push({ title, date: date ? Date.parse(date) || 0 : 0 });
  }
  return out;
}

/* ---------------- fetch per tipo di fonte ---------------- */
async function fetchReddit(value) {
  // il JSON è bloccato per gli IP dei runner: il feed Atom basta (titoli + date)
  const m = /^\/?u(?:ser)?\//i.exec(value.trim());
  const base = m
    ? 'https://www.reddit.com/user/' + value.trim().slice(m[0].length) + '/submitted'
    : 'https://www.reddit.com/r/' + value.trim() + '/new';
  return parseXmlItems(await get(base + '/.rss'));
}

async function fetchRssSource(value) {
  let url = value.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const candidates = [url];
  if (!/(feed|rss|atom|\.xml)/i.test(url)) candidates.push(url.replace(/\/$/, '') + '/feed/');
  let lastErr;
  for (const u of candidates) {
    try {
      const items = parseXmlItems(await get(u));
      if (items.length) return items;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('feed vuoto');
}

async function fetchInstagram(value) {
  // dal server solo il ponte è raggiungibile (il mirror è dietro Cloudflare);
  // l'app, all'apertura, integra comunque i profili che il ponte non copre.
  const handle = value.replace(/^@/, '');
  const xml = await get('https://rb.vern.cc/?action=display&bridge=InstagramBridge&context=Username&u=' + encodeURIComponent(handle) + '&media_type=all&format=Atom');
  const items = parseXmlItems(xml);
  if (!items.length) throw new Error('profilo non nel ponte');
  return items;
}

// il titolo grezzo dei profili social va ripulito come nell'app (Follow…, hashtag)
const cleanTitle = t => t
  .replace(/follow\s+@?[\w.]+[^.!\n]*[.!]?/gi, '')
  .replace(/(?:#[\w]+[ \t]*){2,}/g, '')
  .replace(/\s{2,}/g, ' ').trim();

/* ---------------- ciclo principale ---------------- */
const snap = await db.collection('brickfeed').get();
console.log('utenti:', snap.size);

for (const doc of snap.docs) {
  const d = doc.data() || {};
  const sources = Array.isArray(d.sources) ? d.sources : [];
  const subs = d.pushSubs && typeof d.pushSubs === 'object' ? d.pushSubs : {};
  const subEntries = Object.entries(subs).filter(([, s]) => s && s.endpoint);
  if (!sources.length || !subEntries.length) { console.log(doc.id, '— salto (niente fonti o iscrizioni)'); continue; }

  // modalità di prova: manda un push di test a tutti i dispositivi iscritti e basta
  if (process.env.TEST_PUSH === '1') {
    const payload = JSON.stringify({ title: 'BrickFeed', body: 'Notifica di prova: il postino funziona ✓', url: APP_URL });
    for (const [devId, sub] of subEntries) {
      try { await webpush.sendNotification(sub, payload); console.log(doc.id, '→ push di PROVA inviato a', devId); }
      catch (e) { console.log(doc.id, '→ push di prova fallito per', devId, e.statusCode || e.message); }
    }
    continue;
  }

  const notified = new Set(Array.isArray(d.notified) ? d.notified : []);
  const firstRun = notified.size === 0;
  const fresh = [];
  const allKeys = [];

  for (const src of sources) {
    // Reddit rate-limita le richieste ravvicinate dallo stesso IP: spaziatura larga
    await sleep(src.type === 'reddit' ? 8000 : 1500);
    try {
      let items = [];
      if (src.type === 'reddit') items = await fetchReddit(src.value);
      else if (src.type === 'rss' || (src.type === 'instagram' && src.feed)) items = await fetchRssSource(src.feed || src.value);
      if (src.type === 'instagram') {
        try { items = items.concat(await fetchInstagram(src.value)); } catch { if (!items.length) throw new Error('irraggiungibile'); }
      }
      for (const it of items) {
        const title = cleanTitle(it.title);
        if (!title) continue;
        const k = key(title);
        allKeys.push(k);
        // niente notifiche per roba più vecchia di 2 giorni (quando la data c'è)
        if (!notified.has(k) && (!it.date || Date.now() - it.date < 48 * 36e5)) {
          fresh.push({ title, k });
        }
      }
    } catch (e) { console.log(doc.id, '— fonte', src.type, 'fallita:', e.message); }
  }

  // dedup delle nuove per chiave
  const seenK = new Set();
  const newItems = fresh.filter(f => !seenK.has(f.k) && (seenK.add(f.k), true) && !firstRun);

  if (newItems.length) {
    const body = newItems[0].title.slice(0, 110) + (newItems.length > 1 ? `  (+${newItems.length - 1} altre)` : '');
    const payload = JSON.stringify({
      title: newItems.length === 1 ? 'Nuova notizia' : newItems.length + ' nuove notizie',
      body, url: APP_URL,
    });
    for (const [devId, sub] of subEntries) {
      try {
        await webpush.sendNotification(sub, payload);
        console.log(doc.id, '→ push inviato a', devId);
      } catch (e) {
        console.log(doc.id, '→ push fallito per', devId, e.statusCode || e.message);
        if (e.statusCode === 404 || e.statusCode === 410) {
          await doc.ref.update({ ['pushSubs.' + devId]: admin.firestore.FieldValue.delete() }).catch(() => {});
        }
      }
    }
  } else {
    console.log(doc.id, firstRun ? '— primo giro: memorizzo lo stato senza notificare' : '— nessuna novità');
  }

  // aggiorna lo stato notificato (unione, con tetto)
  const merged = [...new Set([...notified, ...allKeys])].slice(-NOTIFIED_CAP);
  await doc.ref.set({ notified: merged }, { merge: true });
}

console.log('fatto');
