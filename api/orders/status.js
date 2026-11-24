const { requireUser, requireAdmin, send, safeReference, createCommission } = require('../../lib/firebaseAdmin');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
  try {
    const { user, db, FieldValue } = await requireUser(req);
    requireAdmin(user);
    const { action, orderId, status, commissionId } = req.body || {};

    if (action === 'markCommissionPaid') {
      if (!commissionId) return send(res, 400, { error: 'Commission reference is required.' });
      const ref = db.collection('affiliateCommissions').doc(String(commissionId));
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw Object.assign(new Error('Commission record not found.'), { status: 404 });
        if (snap.data().status === 'void') throw Object.assign(new Error('A void commission cannot be paid.'), { status: 409 });
        tx.update(ref, { status: 'paid', paidAt: FieldValue.serverTimestamp(), paidBy: user.email || 'admin' });
      });
      return send(res, 200, { ok: true });
    }

    if (!orderId) return send(res, 400, { error: 'Order ID is required.' });
    const orderRef = db.collection('orders').doc(String(orderId));
    await db.runTransaction(async tx => {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) throw Object.assign(new Error('Order not found.'), { status: 404 });
      const order = orderSnap.data();
      const reference = safeReference(order.reference || orderSnap.id);
      const trackingRef = db.collection('publicOrderTracking').doc(reference);
      const trackingSnap = await tx.get(trackingRef);
      const commissionRef = db.collection('affiliateCommissions').doc(orderSnap.id);
      const commissionSnap = await tx.get(commissionRef);

      const restoreStock = action === 'delete' || action === 'cancel' || (action === 'setStatus' && status === 'Cancelled');
      if (restoreStock && commissionSnap.exists && commissionSnap.data().status === 'paid') {
        throw Object.assign(new Error('This order has an affiliate commission already marked as paid. Resolve the payout before cancelling or deleting it.'), { status: 409 });
      }
      const deductions = Array.isArray(order.stockDeductions) ? order.stockDeductions : [];
      const productSnaps = restoreStock && order.stockDeducted && !order.stockRestored
        ? await Promise.all(deductions.map(d => tx.get(db.collection('products').doc(String(d.productId)))))
        : [];

      if (action === 'approvePayment') {
        const updated = { ...order, paymentStatus: 'Verified', status: 'Processing' };
        await createCommission(tx, db, orderRef, updated, FieldValue.serverTimestamp());
        tx.update(orderRef, {
          paymentStatus: 'Verified', status: 'Processing',
          paymentVerifiedAt: FieldValue.serverTimestamp(),
          paymentVerifiedBy: user.email || 'admin',
          updatedAt: FieldValue.serverTimestamp()
        });
        if (trackingSnap.exists) tx.update(trackingRef, {
          paymentStatus: 'Verified', status: 'Processing',
          updatedAt: FieldValue.serverTimestamp()
        });
      } else if (action === 'setStatus' || action === 'cancel') {
        const nextStatus = action === 'cancel' ? 'Cancelled' : String(status || '');
        const allowed = ['Pending', 'Submitted', 'Awaiting payment verification', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
        if (order.status === 'Cancelled' && nextStatus !== 'Cancelled') throw Object.assign(new Error('A cancelled order cannot be reopened. Create a new order instead.'), { status: 409 });
        if (!allowed.includes(nextStatus)) throw Object.assign(new Error('Invalid order status.'), { status: 400 });
        if (nextStatus === 'Cancelled' && !restoreStock) throw Object.assign(new Error('Invalid cancellation.'), { status: 400 });
        if (restoreStock && order.stockDeducted && !order.stockRestored) {
          deductions.forEach((deduction, index) => {
            const snap = productSnaps[index];
            if (snap && snap.exists && snap.data().stockQuantity !== undefined && snap.data().stockQuantity !== null) {
              tx.update(snap.ref, {
                stockQuantity: Math.max(0, Math.floor(Number(snap.data().stockQuantity) || 0)) + Math.max(0, Math.floor(Number(deduction.quantity) || 0)),
                updatedAt: FieldValue.serverTimestamp()
              });
            }
          });
        }
        tx.update(orderRef, {
          status: nextStatus,
          ...(nextStatus === 'Cancelled' ? { cancelledAt: FieldValue.serverTimestamp(), cancelledBy: user.email || 'admin', stockRestored: true } : {}),
          updatedAt: FieldValue.serverTimestamp()
        });
        if (trackingSnap.exists) tx.update(trackingRef, { status: nextStatus, updatedAt: FieldValue.serverTimestamp() });
        if (nextStatus === 'Cancelled' && commissionSnap.exists) tx.update(commissionRef, { status: 'void', voidedAt: FieldValue.serverTimestamp() });
      } else if (action === 'delete') {
        if (order.stockDeducted && !order.stockRestored) {
          deductions.forEach((deduction, index) => {
            const snap = productSnaps[index];
            if (snap && snap.exists && snap.data().stockQuantity !== undefined && snap.data().stockQuantity !== null) {
              tx.update(snap.ref, {
                stockQuantity: Math.max(0, Math.floor(Number(snap.data().stockQuantity) || 0)) + Math.max(0, Math.floor(Number(deduction.quantity) || 0)),
                updatedAt: FieldValue.serverTimestamp()
              });
            }
          });
        }
        tx.delete(orderRef);
        if (trackingSnap.exists) tx.delete(trackingRef);
        if (commissionSnap.exists) tx.update(commissionRef, { status: 'void', voidedAt: FieldValue.serverTimestamp(), orderDeleted: true });
      } else {
        throw Object.assign(new Error('Unsupported order action.'), { status: 400 });
      }
    });
    return send(res, 200, { ok: true });
  } catch (error) {
    console.error('Admin order action failed:', error);
    return send(res, error.status || 500, { error: error.message || 'Could not update this order.' });
  }
};
