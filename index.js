const { db, FieldValue, Timestamp } = require('./firebase');
const { sortTeams } = require('./elo');

let autoEnabled = false;
let unsubConfig = null;
let unsubQueue = null;
let processing = false;
const queueState = new Map();

function start() {
  if (unsubConfig) return;
  unsubConfig = db.collection('config').doc('matchmakingSettings').onSnapshot(
    (snap) => {
      autoEnabled = !!(snap.exists && snap.data().automaticQueueEnabled);
      if (autoEnabled) startQueueListener(); else stopQueueListener();
    },
    (err) => { console.error('config listener error', err); }
  );
}

function startQueueListener() {
  if (unsubQueue) return;
  unsubQueue = db.collection('queue').orderBy('timestamp', 'asc').limit(100).onSnapshot(
    (snap) => handleQueueChanges(snap),
    (err) => { console.error('queue listener error', err); }
  );
}

function stopQueueListener() {
  if (unsubQueue) { unsubQueue(); unsubQueue = null; }
}

function handleQueueChanges(snap) {
  snap.docChanges().forEach((change) => {
    const id = change.doc.id;
    if (change.type === 'removed') {
      queueState.delete(id);
      return;
    }
    queueState.set(id, { id, ...change.doc.data() });
  });
  maybeFormGroup();
}

function isBanned(entry) {
  const v = entry.matchmakingBanUntil;
  if (!v) return false;
  try {
    const d = typeof v.toDate === 'function' ? v.toDate() : new Date(v);
    return d && d.getTime() > Date.now();
  } catch (_) {
    return false;
  }
}

async function maybeFormGroup() {
  if (!autoEnabled || processing) return;
  const all = Array.from(queueState.values());
  const elig = [];
  const seen = new Set();
  for (const p of all) {
    if (!p || !p.uid) continue;
    if (isBanned(p)) continue;
    if (seen.has(p.uid)) continue;
    seen.add(p.uid);
    elig.push(p);
    if (elig.length === 10) break;
  }
  if (elig.length < 10) return;
  processing = true;
  try {
    await formReadyCheck(elig);
    elig.forEach((p) => queueState.delete(p.id));
  } catch (e) {
    console.error('form readycheck error', e);
  } finally {
    processing = false;
  }
}

async function formReadyCheck(players) {
  const readyMs = Number(process.env.READY_CHECK_MS || 30000);
  const readyRef = db.collection('aguardandoPartidas').doc();
  await db.runTransaction(async (tx) => {
    const queueRefs = players.map((p) => db.collection('queue').doc(p.id));
    const docs = await Promise.all(queueRefs.map((r) => tx.get(r)));
    if (docs.some((d) => !d.exists)) throw new Error('Fila mudou: jogadores ausentes');
    const arr = docs.map((d) => ({ id: d.id, ...d.data() }));
    const acc = {};
    const uids = [];
    arr.forEach((p) => { acc[p.uid] = (p.tipo === 'manual' || p.source === 'manual') ? 'accepted' : 'pending'; uids.push(p.uid); });
    const times = sortTeams(arr);
    tx.set(readyRef, {
      status: 'pending',
      timestampFim: Timestamp.fromDate(new Date(Date.now() + readyMs)),
      jogadores: arr,
      playerAcceptances: acc,
      uids,
      times,
      createdAt: FieldValue.serverTimestamp()
    });
    queueRefs.forEach((r) => tx.delete(r));
  });
}

start();
