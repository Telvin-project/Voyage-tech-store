const { requireUser, send, safeReference, createCommission } = require('./_lib/firebaseAdmin');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
  try {
    const { user, db, FieldValue } = await requireUser(req);
    const body = req.body || {};
    const reference = safeReference(body.reference);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!reference || !items.length) return send(res, 400, { error: 'Order reference and items are required.' });
    if (items.length > 30) return send(res, 400, { error: 'This order contains too many line items.' });

    const orderRef = db.collection('orders').doc();
    const trackingRef = db.collection('publicOrderTracking').doc(reference);
    const code = String(body.affiliateCode || '').trim().toUpperCase();
    const couponCode = String(body.couponCode || '').trim().toUpperCase();
    const deductions = [];
    const stockUpdates = [];
    let computedSubtotal = 0;
    const normalizedItems = items.map(item => ({
      id: String(item.id || ''),
      variantId: item.variantId ? String(item.variantId) : null,
      specification: String(item.specification || ''),
      name: String(item.name || ''),
      quantity: Math.floor(Number(item.quantity)),
      unitPrice: Number(item.unitPrice)
    }));
    if (normalizedItems.some(i => !i.id || !Number.isInteger(i.quantity) || i.quantity < 1 || !Number.isFinite(i.unitPrice) || i.unitPrice <= 0)) {
      return send(res, 400, { error: 'One or more order items are invalid.' });
    }

    let affiliateUid = null;
    await db.runTransaction(async tx => {
      deductions.length = 0; stockUpdates.length = 0; computedSubtotal = 0; affiliateUid = null;
      const productRefs = [...new Map(normalizedItems.map(i => [i.id, db.collection('products').doc(i.id)])).values()];
      const productSnaps = await Promise.all(productRefs.map(ref => tx.get(ref)));
      const products = new Map(productSnaps.map(snap => [snap.id, snap]));
      const trackingSnap = await tx.get(trackingRef);
      let affiliateSnap = null;
      if (code) affiliateSnap = await tx.get(db.collection('affiliateCodes').doc(code));
      let couponSnap = null;
      if (couponCode) couponSnap = await tx.get(db.collection('coupons').doc(couponCode));

      if (trackingSnap.exists) throw Object.assign(new Error('This order reference has already been used. Please retry checkout.'), { status: 409 });
      for (const item of normalizedItems) {
        const snap = products.get(item.id);
        if (!snap || !snap.exists) throw Object.assign(new Error('A product in your cart is no longer available. Refresh the shop and try again.'), { status: 409 });
        const product = snap.data();
        const variant = item.variantId && Array.isArray(product.variants) ? product.variants.find(v => String(v.id) === item.variantId) : null;
        if (item.variantId && !variant) throw Object.assign(new Error('A selected product option is no longer available. Refresh your cart.'), { status: 409 });
        const regular = Number(variant?.base ?? product.base ?? 0);
        const sale = variant?.salePrice ?? product.salePrice;
        const actual = sale != null && Number(sale) > 0 && Number(sale) < regular ? Number(sale) : regular;
        if (Math.abs(actual - item.unitPrice) > 1) throw Object.assign(new Error('The price of ' + (product.name || item.name) + ' has changed. Refresh your cart before paying.'), { status: 409 });
        computedSubtotal += actual * item.quantity;
        if (product.stockQuantity !== undefined && product.stockQuantity !== null) {
          const available = Math.max(0, Math.floor(Number(product.stockQuantity) || 0));
          if (available < item.quantity) throw Object.assign(new Error((product.name || item.name) + ' has only ' + available + ' left in stock.'), { status: 409 });
          const existing = deductions.find(d => d.productId === item.id);
          if (existing) existing.quantity += item.quantity;
          else deductions.push({ productId: item.id, quantity: item.quantity });
        }
      }
      if (couponCode) {
        if (!couponSnap || !couponSnap.exists) throw Object.assign(new Error('The coupon code is no longer available.'), { status: 400 });
        const coupon = couponSnap.data();
        const expiry = coupon.expiresAt?.toDate ? coupon.expiresAt.toDate().getTime() : coupon.expiresAt ? new Date(coupon.expiresAt).getTime() : 0;
        if (coupon.active !== true || (expiry && expiry < Date.now()) || (Number(coupon.maxUses || 0) > 0 && Number(coupon.usedCount || 0) >= Number(coupon.maxUses)) || computedSubtotal < Number(coupon.minOrder || 0)) {
          throw Object.assign(new Error('The coupon is inactive, expired, below its minimum order, or has reached its usage limit.'), { status: 400 });
        }
        const value = Number(coupon.value || 0);
        const expectedDiscount = coupon.type === 'fixed' ? Math.min(computedSubtotal, Math.max(0, value)) : Math.min(computedSubtotal, Math.round(computedSubtotal * Math.max(0, Math.min(100, value)) / 100));
        if (Math.abs(expectedDiscount - Number(body.discount || 0)) > 1) throw Object.assign(new Error('The coupon discount changed. Apply the coupon again.'), { status: 409 });
      } else if (Number(body.discount || 0) > 0) {
        throw Object.assign(new Error('A discount was submitted without a valid coupon code.'), { status: 400 });
      }

      if (code) {
        if (!affiliateSnap || !affiliateSnap.exists || affiliateSnap.data().status !== 'active' || !affiliateSnap.data().uid || affiliateSnap.data().uid === user.uid) {
          throw Object.assign(new Error('The affiliate referral is invalid. Remove the referral and retry checkout.'), { status: 400 });
        }
        affiliateUid = affiliateSnap.data().uid;
      }

      await createCommission(tx, db, orderRef, order, FieldValue.serverTimestamp());

      for (const deduction of deductions) {
        const productRef = db.collection('products').doc(deduction.productId);
        const current = products.get(deduction.productId).data();
        const remaining = Math.max(0, Math.floor(Number(current.stockQuantity) || 0)) - deduction.quantity;
        tx.update(productRef, { stockQuantity: remaining, updatedAt: FieldValue.serverTimestamp() });
        stockUpdates.push({ id: deduction.productId, stockQuantity: remaining });
      }

      const discount = Math.max(0, Number(body.discount || 0));
      const fee = Math.max(0, Number(body.deliveryFee || 0));
      const total = computedSubtotal - discount + fee;
      if (Math.abs(total - Number(body.total || 0)) > 1) throw Object.assign(new Error('Your order total has changed. Refresh checkout and try again.'), { status: 409 });
      const order = {
        reference, uid: user.uid,
        klumpReference: String(body.klumpReference || ''),
        customerEmail: String(body.customerEmail || user.email || ''),
        customerName: String(body.customerName || ''),
        items: normalizedItems,
        itemsText: normalizedItems.map(i => i.name + (i.specification ? ' (' + i.specification + ')' : '') + ' × ' + i.quantity).join(', '),
        subtotal: computedSubtotal, discount, couponCode, couponDiscount: discount,
        deliveryFee: fee, total, method: String(body.method || 'transfer'),
        paymentProvider: String(body.paymentProvider || ''),
        paymentStatus: String(body.paymentStatus || 'Awaiting verification'),
        status: String(body.status || 'Awaiting payment verification'),
        fulfillment: String(body.fulfillment || 'Shop pickup'),
        delivery: body.delivery && typeof body.delivery === 'object' ? body.delivery : {},
        proofUrl: String(body.proofUrl || ''),
        affiliateCode: code || null, affiliateUid,
        stockDeductions: deductions, stockDeducted: deductions.length > 0,
        stockRestored: false,
        createdAt: FieldValue.serverTimestamp()
      };
      tx.create(orderRef, order);
      tx.create(trackingRef, {
        reference, orderId: orderRef.id,
        status: order.status, paymentStatus: order.paymentStatus,
        total, itemsText: order.itemsText, fulfillment: order.fulfillment,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      });
      if (couponCode) {
        const redemptionRef = db.collection('couponRedemptions').doc(reference);
        tx.create(redemptionRef, {
          orderReference: reference, couponCode, uid: user.uid,
          discount, createdAt: FieldValue.serverTimestamp()
        });
        tx.update(db.collection('coupons').doc(couponCode), {
          usedCount: Number(couponSnap.data().usedCount || 0) + 1,
          updatedAt: FieldValue.serverTimestamp()
        });
      }
    });

    return send(res, 201, { ok: true, id: orderRef.id, reference, stockUpdates });
  } catch (error) {
    console.error('Create order failed:', error);
    return send(res, error.status || 500, { error: error.message || 'Could not create the order.' });
  }
};
