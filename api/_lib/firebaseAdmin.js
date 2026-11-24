const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

function getAdminServices() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured in Vercel.');
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); }
  catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON.'); }
  if (!getApps().length) {
    initializeApp({
      credential: cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id
    });
  }
  return { auth: getAuth(), db: getFirestore(), FieldValue };
}

async function requireUser(req) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    const error = new Error('Sign in is required.');
    error.status = 401;
    throw error;
  }
  const { auth, db, FieldValue } = getAdminServices();
  const decoded = await auth.verifyIdToken(token);
  return { user: decoded, db, FieldValue };
}

function requireAdmin(user) {
  if (String(user.email || '').toLowerCase() !== 'voyagestyles@gmail.com') {
    const error = new Error('Administrator access is required.');
    error.status = 403;
    throw error;
  }
}

function send(res, status, body) {
  res.status(status).setHeader('Cache-Control', 'no-store').json(body);
}

function safeReference(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

async function createCommission(tx, db, orderRef, order, now) {
  if (!order.affiliateUid || !order.affiliateCode || order.paymentStatus !== 'Verified') return;
  const commissionRef = db.collection('affiliateCommissions').doc(orderRef.id);
  const existing = await tx.get(commissionRef);
  if (existing.exists) return;
  const profileRef = db.collection('affiliateProfiles').doc(order.affiliateUid);
  const profile = await tx.get(profileRef);
  if (!profile.exists || profile.data().status !== 'active') return;
  const rate = Math.max(0, Math.min(50, Number(profile.data().commissionRate ?? 5)));
  const eligibleAmount = Math.max(0, Number(order.subtotal || 0) - Number(order.discount || 0));
  const amount = Math.round(eligibleAmount * rate / 100);
  if (!amount) return;
  tx.create(commissionRef, {
    uid: order.affiliateUid,
    affiliateCode: order.affiliateCode,
    orderId: orderRef.id,
    orderReference: order.reference || orderRef.id,
    commissionRate: rate,
    eligibleAmount,
    commissionAmount: amount,
    status: 'pending',
    createdAt: now
  });
}

module.exports = { getAdminServices, requireUser, requireAdmin, send, safeReference, createCommission };
