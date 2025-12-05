const admin = require('firebase-admin');

function init() {
  if (admin.apps.length) return;
  const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '';
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || undefined;
  let credential = null;
  if (svcJson) {
    try {
      const obj = JSON.parse(svcJson);
      if (obj && typeof obj.private_key === 'string') obj.private_key = obj.private_key.replace(/\\n/g, '\n');
      credential = admin.credential.cert(obj);
    } catch (_) {}
  }
  if (!credential) credential = admin.credential.applicationDefault();
  admin.initializeApp({ credential, projectId });
}

init();

const db = admin.firestore();

module.exports = {
  admin,
  db,
  FieldValue: admin.firestore.FieldValue,
  Timestamp: admin.firestore.Timestamp
};

