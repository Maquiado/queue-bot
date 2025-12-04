require('dotenv').config()
const admin = require('firebase-admin')
const crypto = require('crypto')
const express = require('express')
const cors = require('cors')

if (process.env.FIRESTORE_EMULATOR_HOST) {
  admin.initializeApp()
} else {
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT
  if (!saJson && !saPath) {
    console.error('FIREBASE_SERVICE_ACCOUNT ausente')
    process.exit(1)
  }
  let serviceAccount
  try {
    serviceAccount = saJson ? JSON.parse(saJson) : require(saPath)
  } catch (e) {
    console.error('FIREBASE_SERVICE_ACCOUNT inválido')
    process.exit(1)
  }
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n')
  }
  const projectId = serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT
  admin.initializeApp(projectId ? { credential: admin.credential.cert(serviceAccount), projectId } : { credential: admin.credential.cert(serviceAccount) })
}

const db = admin.firestore()
const BOT_ID = process.env.BOT_ID || crypto.randomBytes(8).toString('hex')
const LOCK_TTL_MS = parseInt(process.env.LOCK_TTL_MS || '20000', 10)
const lockRef = db.collection('locks').doc('queue-bot')

async function acquireLock() {
  const now = Date.now()
  return db.runTransaction(async (t) => {
    const snap = await t.get(lockRef)
    if (!snap.exists) {
      t.set(lockRef, { owner: BOT_ID, expiresAt: admin.firestore.Timestamp.fromMillis(now + LOCK_TTL_MS) })
      return true
    }
    const data = snap.data() || {}
    const owner = data.owner
    const expiresAt = data.expiresAt
    const expired = !expiresAt || (expiresAt.toMillis && expiresAt.toMillis() <= now)
    if (expired || owner === BOT_ID) {
      t.set(lockRef, { owner: BOT_ID, expiresAt: admin.firestore.Timestamp.fromMillis(now + LOCK_TTL_MS) }, { merge: true })
      return true
    }
    return false
  })
}

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '10', 10)
const POLL_INTERVAL_MS_MIN = parseInt(process.env.POLL_INTERVAL_MS_MIN || '5000', 10)
const POLL_INTERVAL_MS_MAX = parseInt(process.env.POLL_INTERVAL_MS_MAX || '30000', 10)
let currentInterval = POLL_INTERVAL_MS_MIN
const queueCache = new Map()
const assignedSet = new Set()
let lastSeenTs = 0
const sseClients = new Set()
const MATCHMAKING_URL = process.env.MATCHMAKING_URL || ''

async function loadAssignments() {
  const snap = await db.collection('assignments').where('active', '==', true).limit(500).get()
  snap.forEach((doc) => {
    const data = doc.data() || {}
    const pid = data.playerId || doc.id
    assignedSet.add(pid)
  })
}

async function processQueue() {
  try {
    let q = db.collection('queue').orderBy('timestamp', 'asc').limit(BATCH_SIZE)
    if (lastSeenTs > 0) {
      q = db.collection('queue')
        .where('timestamp', '>', admin.firestore.Timestamp.fromMillis(lastSeenTs))
        .orderBy('timestamp', 'asc')
        .limit(BATCH_SIZE)
    }
    const snapshot = await q.get()

    if (snapshot.empty) {
      console.log('Nenhum item na fila')
      return false
    }

    let count = 0
    snapshot.forEach((doc) => {
      const data = doc.data()
      const ts = data.timestamp && data.timestamp.toMillis ? data.timestamp.toMillis() : 0
      lastSeenTs = Math.max(lastSeenTs, ts)
      queueCache.set(doc.id, { id: doc.id, ...data })
      count += 1
    })
    console.log(`Sincronizados ${count} itens para cache`)
    await maybeHandoff()
    broadcastQueue()
    return count > 0
  } catch (err) {
    console.error('Erro ao processar fila', err)
    return false
  }
}

console.log('queue-bot iniciado')
async function loop() {
  const hasLock = await acquireLock()
  if (!hasLock) {
    console.log('Sem lock, aguardando')
    currentInterval = Math.min(POLL_INTERVAL_MS_MAX, currentInterval * 2)
    setTimeout(loop, currentInterval)
    return
  }
  const processed = await processQueue()
  if (processed) {
    currentInterval = Math.max(POLL_INTERVAL_MS_MIN, Math.floor(currentInterval / 2))
  } else {
    currentInterval = Math.min(POLL_INTERVAL_MS_MAX, currentInterval * 2)
  }
  setTimeout(loop, currentInterval)
}

loop()

const app = express()
const PORT = parseInt(process.env.PORT || '3001', 10)
const allowedOrigins = (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean)
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true)
    return cb(new Error('Not allowed by CORS'))
  },
  methods: ['GET', 'POST'],
  credentials: false,
}))
app.use(express.json())
app.get('/queue', (req, res) => {
  const arr = Array.from(queueCache.values()).sort((a, b) => {
    const ta = a.timestamp && a.timestamp.toMillis ? a.timestamp.toMillis() : 0
    const tb = b.timestamp && b.timestamp.toMillis ? b.timestamp.toMillis() : 0
    return ta - tb
  })
  res.json({ size: arr.length, players: arr })
})
app.get('/health', (req, res) => {
  res.json({ cacheSize: queueCache.size, assignedCount: assignedSet.size, lastSeenTs })
})
app.get('/queue/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  sseClients.add(res)
  const arr = Array.from(queueCache.values()).sort((a, b) => {
    const ta = a.timestamp && a.timestamp.toMillis ? a.timestamp.toMillis() : 0
    const tb = b.timestamp && b.timestamp.toMillis ? b.timestamp.toMillis() : 0
    return ta - tb
  })
  res.write(`event: init\n`)
  res.write(`data: ${JSON.stringify({ size: arr.length, players: arr })}\n\n`)
  req.on('close', () => {
    sseClients.delete(res)
  })
})
app.get('/queue/summary', (req, res) => {
  const by = String(req.query.by || 'region,rank').split(',').map((s) => s.trim()).filter(Boolean)
  const arr = Array.from(queueCache.values())
  const summary = {}
  by.forEach((field) => {
    const m = {}
    arr.forEach((p) => {
      const v = p[field] == null ? 'unknown' : p[field]
      m[v] = (m[v] || 0) + 1
    })
    summary[field] = m
  })
  res.json({ by, summary })
})
app.get('/batches/pending', async (req, res) => {
  try {
    const snap = await db.collection('matchmaking_batches').where('status', '==', 'pending').limit(20).get()
    if (snap.empty) {
      res.status(404).json({ message: 'none' })
      return
    }
    const items = []
    snap.forEach((doc) => items.push({ id: doc.id, ...doc.data() }))
    items.sort((a, b) => {
      const ta = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0
      const tb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0
      return tb - ta
    })
    res.json({ size: items.length, latest: items[0], items })
  } catch (e) {
    res.status(500).json({ error: 'query_failed' })
  }
})
app.post('/ready-check/:batchId', async (req, res) => {
  try {
    const batchId = req.params.batchId
    const ref = db.collection('matchmaking_batches').doc(batchId)
    const snap = await ref.get()
    if (!snap.exists) {
      res.status(404).json({ error: 'batch_not_found' })
      return
    }
    await ref.set({ status: 'ready_requested', readyRequestedAt: admin.firestore.Timestamp.now() }, { merge: true })
    const data = await ref.get()
    res.json({ id: ref.id, ...data.data() })
  } catch (e) {
    res.status(500).json({ error: 'ready_request_failed' })
  }
})
app.post('/queue/frame', async (req, res) => {
  try {
    const { id, playerId, frameColor, frameStyle } = req.body || {}
    const pid = id || playerId
    if (!pid) {
      res.status(400).json({ error: 'missing_id' })
      return
    }
    let key = pid
    if (!queueCache.has(key)) {
      for (const [docId, p] of queueCache.entries()) {
        if (p.userId === pid || p.uid === pid || p.discordId === pid || p.id === pid) {
          key = docId
          break
        }
      }
    }
    const existing = queueCache.get(key) || { id: key }
    if (frameColor != null) existing.frameColor = frameColor
    if (frameStyle != null) existing.frameStyle = frameStyle
    queueCache.set(key, existing)
    broadcastQueue()
    res.json({ ok: true, player: existing })
  } catch (e) {
    res.status(500).json({ error: 'frame_update_failed' })
  }
})
app.listen(PORT, () => {
  console.log(`api ${PORT}`)
})

async function maybeHandoff() {
  const candidates = Array.from(queueCache.values())
    .filter((p) => !assignedSet.has(p.id))
    .sort((a, b) => {
      const ta = a.timestamp && a.timestamp.toMillis ? a.timestamp.toMillis() : 0
      const tb = b.timestamp && b.timestamp.toMillis ? b.timestamp.toMillis() : 0
      return ta - tb
    })
    .slice(0, 10)
  if (candidates.length < 10) return
  const batchRef = db.collection('matchmaking_batches').doc()
  await batchRef.set({
    players: candidates.map((p) => p.id),
    createdAt: admin.firestore.Timestamp.now(),
    status: 'pending',
  })
  for (const p of candidates) {
    const aRef = db.collection('assignments').doc(p.id)
    await aRef.set({ playerId: p.id, batchId: batchRef.id, createdAt: admin.firestore.Timestamp.now(), active: true }, { merge: true })
    assignedSet.add(p.id)
  }
  console.log(`handoff ${batchRef.id} 10 jogadores`)
  broadcastQueue()
  if (MATCHMAKING_URL) {
    try {
      await fetch(MATCHMAKING_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: batchRef.id, players: candidates.map((p) => p.id) }) })
      console.log(`notificado ${MATCHMAKING_URL} ${batchRef.id}`)
    } catch (e) {
      console.log('notificacao_falhou')
    }
  }
}

function broadcastQueue() {
  if (!sseClients.size) return
  const arr = Array.from(queueCache.values()).sort((a, b) => {
    const ta = a.timestamp && a.timestamp.toMillis ? a.timestamp.toMillis() : 0
    const tb = b.timestamp && b.timestamp.toMillis ? b.timestamp.toMillis() : 0
    return ta - tb
  })
  const payload = `event: queue\n` + `data: ${JSON.stringify({ size: arr.length, players: arr })}\n\n`
  sseClients.forEach((res) => {
    try { res.write(payload) } catch (_) {}
  })
}

loadAssignments().then(() => {}).catch(() => {})
