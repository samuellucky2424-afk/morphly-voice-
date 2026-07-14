import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { authenticate, requireAdmin, type AuthenticatedUser } from "./auth.js";
import { adminDb } from "./firebase-admin.js";
import {
  BillingConfigConflictError,
  BillingConfigValidationError,
  billingAmountFromMinor,
  collections,
  loadBillingConfig,
  saveBillingConfig,
  stableId,
  type BillingConfig,
  type BillingPlan,
} from "./data.js";
import {
  HttpError,
  headerValue,
  numericField,
  readBody,
  requestUrl,
  requireObject,
  stringField,
  type ApiRequest,
} from "./http.js";

type CheckoutMode = "hosted" | "inline";

type FulfillmentOptions = {
  expectedUid?: string;
  expectedEmail?: string | null;
};

function flutterwaveSecret(): string {
  const secret = process.env.FLUTTERWAVE_SECRET_KEY?.trim();
  if (!secret) throw new HttpError(503, "payments_unavailable", "Flutterwave payments are not configured.");
  return secret;
}

function flutterwavePublicKey(): string | null {
  return (
    process.env.FLUTTERWAVE_PUBLIC_KEY ||
    process.env.VITE_FLUTTERWAVE_PUBLIC_KEY ||
    ""
  ).trim() || null;
}

async function flutterwaveRequest(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`https://api.flutterwave.com/v3${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${flutterwaveSecret()}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      payload = { message: text };
    }
    if (!response.ok || payload.status === "error") {
      const message = String(payload.message || `Flutterwave request failed (${response.status}).`);
      throw new HttpError(502, "flutterwave_error", message);
    }
    return payload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new HttpError(504, "flutterwave_timeout", "Flutterwave did not respond in time.");
    }
    throw new HttpError(502, "flutterwave_unavailable", "Flutterwave is temporarily unavailable.");
  } finally {
    clearTimeout(timer);
  }
}

/** Route-ready authenticated handler for user-visible credit packages. */
export async function getBillingConfig(request: ApiRequest): Promise<Record<string, unknown>> {
  await authenticate(request);
  return billingConfigPayload(await safeBillingConfig(), false);
}

/** Route-ready administrator handler returning enabled and disabled packages. */
export async function getAdminBillingConfig(request: ApiRequest): Promise<Record<string, unknown>> {
  await requireAdmin(request);
  return billingConfigPayload(await safeBillingConfig(), true);
}

/** Route-ready administrator mutation for app_config/billing. */
export async function updateAdminBillingConfig(request: ApiRequest): Promise<Record<string, unknown>> {
  const admin = await requireAdmin(request);
  const body = requireObject((await readBody(request)).value);
  const requested = body.billingConfig || body.billing || body.config || body;
  try {
    const saved = await saveBillingConfig(requested, admin.uid);
    return billingConfigPayload(saved, true);
  } catch (error) {
    if (error instanceof BillingConfigConflictError) {
      throw new HttpError(409, "billing_config_conflict", error.message, { currentVersion: error.currentVersion });
    }
    if (error instanceof BillingConfigValidationError) {
      throw new HttpError(400, "invalid_billing_config", error.message);
    }
    throw error;
  }
}

export async function initializePayment(request: ApiRequest): Promise<Record<string, unknown>> {
  const user = await authenticate(request);
  if (!user.email) throw new HttpError(400, "email_required", "A verified account email is required for payment.");
  // Verification and fulfillment always require the server secret, including
  // Flutterwave Inline payments which use a public key in the browser.
  flutterwaveSecret();

  const body = requireObject((await readBody(request)).value);
  const planId =
    stringField(body, "planId", { max: 50 }) ||
    stringField(body, "packageId", { required: true, max: 50 });
  const checkoutModeText = stringField(body, "checkoutMode", { max: 20 }) || "hosted";
  if (checkoutModeText !== "hosted" && checkoutModeText !== "inline") {
    throw new HttpError(400, "invalid_checkout_mode", "checkoutMode must be hosted or inline.");
  }
  const checkoutMode = checkoutModeText as CheckoutMode;
  const config = await safeBillingConfig();
  const plan = config.plans.find((candidate) => candidate.id === planId && candidate.enabled);
  if (!plan) throw new HttpError(400, "invalid_plan", "The selected credit package does not exist or is disabled.");
  const expectedBillingVersion = numericField(body, "expectedBillingVersion", { required: true, min: 1, integer: true });
  const expectedAmountMinor = numericField(body, "expectedAmountMinor", { required: true, min: 1, integer: true });
  const expectedCurrency = stringField(body, "expectedCurrency", { required: true, max: 3 })?.toUpperCase();
  if (
    expectedBillingVersion !== config.version ||
    expectedAmountMinor !== plan.amountMinor ||
    expectedCurrency !== config.currency
  ) {
    throw new HttpError(409, "billing_config_changed", "Credit-package pricing changed. Refresh the packages and confirm the new amount.", {
      currentVersion: config.version,
    });
  }

  const publicKey = flutterwavePublicKey();
  if (checkoutMode === "inline" && !publicKey) {
    throw new HttpError(503, "payments_unavailable", "FLUTTERWAVE_PUBLIC_KEY is not configured for Inline checkout.");
  }
  const redirectUrl = checkoutMode === "hosted" ? validatedRedirectUrl() : null;
  const amount = billingAmountFromMinor(plan.amountMinor);
  const txRef = `morphly_${stableId(user.uid).slice(0, 20)}_${Date.now()}_${randomBytes(6).toString("hex")}`;
  const database = adminDb();
  const paymentReference = database.collection(collections.payments).doc(txRef);
  const planSnapshot = immutablePlanSnapshot(config, plan);
  await paymentReference.create({
    txRef,
    uid: user.uid,
    email: user.email,
    emailLower: user.email.toLowerCase(),
    displayName: user.displayName,
    planId: plan.id,
    planLabel: plan.label,
    planSnapshot,
    billingConfigVersion: config.version,
    credits: plan.credits,
    amount,
    amountMinor: plan.amountMinor,
    currency: config.currency,
    checkoutMode,
    status: "initializing",
    credited: false,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  try {
    let checkoutUrl: string | null = null;
    if (checkoutMode === "hosted") {
      const response = await flutterwaveRequest("/payments", {
        method: "POST",
        body: JSON.stringify({
          tx_ref: txRef,
          amount,
          currency: config.currency,
          redirect_url: redirectUrl,
          customer: { email: user.email, name: user.displayName },
          meta: {
            uid: user.uid,
            plan_id: plan.id,
            credits: plan.credits,
            billing_config_version: config.version,
          },
          customizations: {
            title: "Morphly Voice credits",
            description: `${plan.credits.toLocaleString("en-US")} Morphly credits`,
          },
        }),
      });
      const data = response.data as Record<string, unknown> | undefined;
      checkoutUrl = String(data?.link || "");
      if (!checkoutUrl) throw new HttpError(502, "flutterwave_error", "Flutterwave did not return a checkout link.");
    }

    await paymentReference.update({
      status: "pending",
      checkoutUrl,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return initializedPaymentPayload({
      txRef,
      checkoutMode,
      checkoutUrl,
      publicKey,
      amount,
      config,
      plan,
      user,
    });
  } catch (error) {
    await paymentReference.set(
      {
        status: "initialization_failed",
        failureCode: error instanceof HttpError ? error.code : "unknown",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    throw error;
  }
}

/**
 * Route-ready authenticated confirmation handler for Flutterwave Inline
 * callbacks and hosted-checkout return pages. It never trusts callback status.
 */
export async function verifyPaymentTransaction(request: ApiRequest): Promise<Record<string, unknown>> {
  const user = await authenticate(request);
  const body = requireObject((await readBody(request)).value);
  const txRef = validatedTxRef(
    stringField(body, "txRef", { max: 180 }) ||
    stringField(body, "reference", { required: true, max: 180 }),
  );
  const transactionId = positiveTransactionId(body.transactionId ?? body.id);
  const paymentSnapshot = await ownedPaymentSnapshot(txRef, user.uid);
  const payment = paymentSnapshot.data() || {};
  if (payment.credited === true && Number(payment.flutterwaveTransactionId) === transactionId) {
    return {
      credited: false,
      duplicate: true,
      txRef,
      newBalance: payment.balanceAfter ?? null,
      payment: paymentStatusPayload(paymentSnapshot.id, payment, true),
    };
  }

  const verification = await flutterwaveRequest(`/transactions/${transactionId}/verify`, { method: "GET" });
  const verified = verification.data as Record<string, unknown> | undefined;
  if (!verified) throw new HttpError(400, "verification_failed", "Flutterwave transaction verification returned no data.");
  if (Number(verified.id) !== transactionId) {
    throw new HttpError(409, "verification_mismatch", "Flutterwave returned a different transaction during verification.");
  }
  const verifiedTxRef = validatedTxRef(String(verified.tx_ref || ""));
  if (verifiedTxRef !== txRef) {
    throw new HttpError(409, "verification_mismatch", "Flutterwave returned a different transaction reference.");
  }
  const status = String(verified.status || "").toLowerCase();
  if (status !== "successful") {
    await markPaymentStatus(txRef, normalizedPaymentStatus(status));
    throw new HttpError(409, "payment_not_successful", "Flutterwave has not confirmed this payment as successful.");
  }

  const fulfillment = await creditVerifiedPayment(txRef, transactionId, verified, {
    expectedUid: user.uid,
    expectedEmail: user.email,
  });
  const updated = await adminDb().collection(collections.payments).doc(txRef).get();
  return {
    ...fulfillment,
    payment: paymentStatusPayload(updated.id, updated.data() || {}, true),
  };
}

/** Route-ready GET handler: /payments/status?txRef=... */
export async function paymentStatus(request: ApiRequest): Promise<Record<string, unknown>> {
  const user = await authenticate(request);
  const url = requestUrl(request);
  const txRef = validatedTxRef(url.searchParams.get("txRef") || url.searchParams.get("reference") || "");
  let snapshot = await ownedPaymentSnapshot(txRef, user.uid);
  const localPayment = snapshot.data() || {};
  if (localPayment.credited !== true && new Set(["initializing", "pending"]).has(String(localPayment.status || "pending"))) {
    try {
      // Recover a completed Inline payment even when both the browser callback
      // and first webhook response were lost.
      const verification = await flutterwaveRequest(
        `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`,
        { method: "GET" },
      );
      const verified = verification.data as Record<string, unknown> | undefined;
      if (verified && String(verified.tx_ref || "") === txRef) {
        const transactionId = positiveTransactionId(verified.id);
        const status = String(verified.status || "").toLowerCase();
        if (status === "successful") {
          await creditVerifiedPayment(txRef, transactionId, verified, {
            expectedUid: user.uid,
            expectedEmail: user.email,
          });
        } else if (status) {
          await markPaymentStatus(txRef, normalizedPaymentStatus(status));
        }
        snapshot = await ownedPaymentSnapshot(txRef, user.uid);
      }
    } catch (error) {
      // The transaction may not exist yet while the payment window is open.
      // Keep the local pending state so the client can retry and the signed
      // webhook remains authoritative.
      if (!(error instanceof HttpError) || !new Set([
        "flutterwave_error",
        "flutterwave_timeout",
        "flutterwave_unavailable",
      ]).has(error.code)) throw error;
    }
  }
  return paymentStatusPayload(snapshot.id, snapshot.data() || {}, true);
}

export async function flutterwaveWebhook(request: ApiRequest): Promise<Record<string, unknown>> {
  const parsedBody = await readBody(request);
  verifyWebhookSignature(request, parsedBody.raw);
  const body = requireObject(parsedBody.value);
  const webhookData = body.data;
  if (!webhookData || typeof webhookData !== "object" || Array.isArray(webhookData)) {
    return { received: true, ignored: true, reason: "missing_transaction_data" };
  }
  const data = webhookData as Record<string, unknown>;
  const eventType = String(body.event || body.type || "").trim().toLowerCase();
  if (eventType.startsWith("chargeback.") || eventType === "refund.completed") {
    return handlePaymentReversalEvent(eventType, data);
  }
  const transactionId = Number(data.id);
  if (!Number.isSafeInteger(transactionId) || transactionId <= 0) {
    return { received: true, ignored: true, reason: "missing_transaction_id" };
  }

  const verification = await flutterwaveRequest(`/transactions/${transactionId}/verify`, { method: "GET" });
  const verified = verification.data as Record<string, unknown> | undefined;
  if (!verified) throw new HttpError(400, "verification_failed", "Flutterwave transaction verification returned no data.");
  if (Number(verified.id) !== transactionId) {
    throw new HttpError(409, "verification_mismatch", "Flutterwave returned a different transaction during verification.");
  }
  const status = String(verified.status || "").toLowerCase();
  const txRefText = String(verified.tx_ref || "");
  if (status !== "successful") {
    if (/^[A-Za-z0-9_-]{1,180}$/.test(txRefText)) {
      await markPaymentStatus(txRefText, normalizedPaymentStatus(status));
    }
    return { received: true, ignored: true, reason: `transaction_${status || "not_successful"}` };
  }

  const txRef = validatedTxRef(txRefText);
  const result = await creditVerifiedPayment(txRef, transactionId, verified);
  return { received: true, ...result };
}

function verifyWebhookSignature(request: ApiRequest, raw: Buffer): void {
  const secretHash = process.env.FLUTTERWAVE_SECRET_HASH?.trim();
  if (!secretHash) throw new HttpError(503, "webhook_not_configured", "Flutterwave webhook verification is not configured.");
  const verificationHash = headerValue(request.headers["verif-hash"]);
  if (verificationHash && constantTimeEqual(verificationHash, secretHash)) return;

  const signature = headerValue(request.headers["flutterwave-signature"]);
  if (signature && raw.length) {
    const expected = createHmac("sha256", secretHash).update(raw).digest("base64");
    if (constantTimeEqual(signature, expected)) return;
  }
  throw new HttpError(401, "invalid_webhook_signature", "Flutterwave webhook signature is invalid.");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function creditVerifiedPayment(
  txRef: string,
  transactionId: number,
  verified: Record<string, unknown>,
  options: FulfillmentOptions = {},
): Promise<Record<string, unknown>> {
  const database = adminDb();
  const paymentReference = database.collection(collections.payments).doc(txRef);
  const ledgerReference = database.collection(collections.ledger).doc(stableId(`flutterwave:${txRef}`));
  const auditReference = database.collection(collections.audit).doc(stableId(`flutterwave:${txRef}`));

  return database.runTransaction(async (transaction) => {
    const paymentSnapshot = await transaction.get(paymentReference);
    if (!paymentSnapshot.exists) {
      throw new HttpError(404, "payment_not_found", "No Morphly purchase matches this transaction reference.");
    }
    const payment = paymentSnapshot.data() || {};
    const uid = String(payment.uid || "");
    if (options.expectedUid && uid !== options.expectedUid) {
      throw new HttpError(403, "payment_forbidden", "This payment belongs to another Morphly account.");
    }

    validateVerifiedPayment(payment, verified, txRef, transactionId, options.expectedEmail);
    if (payment.credited === true) {
      if (Number(payment.flutterwaveTransactionId) !== transactionId) {
        throw new HttpError(409, "payment_mismatch", "This purchase was fulfilled by a different Flutterwave transaction.");
      }
      return { credited: false, duplicate: true, txRef, newBalance: payment.balanceAfter ?? null };
    }

    const credits = Number(payment.credits);
    if (!uid || !Number.isSafeInteger(credits) || credits <= 0) {
      throw new HttpError(409, "invalid_payment_record", "The stored Morphly purchase is invalid.");
    }
    const userReference = database.collection(collections.users).doc(uid);
    const userSnapshot = await transaction.get(userReference);
    if (!userSnapshot.exists) throw new HttpError(404, "user_not_found", "The purchasing user no longer exists.");
    const user = userSnapshot.data() || {};
    const previousBalance = Number.isSafeInteger(user.credits) ? user.credits : 0;
    const newBalance = previousBalance + credits;
    if (!Number.isSafeInteger(newBalance)) {
      throw new HttpError(409, "credit_balance_overflow", "This purchase would exceed the supported credit balance.");
    }
    const timestamp = FieldValue.serverTimestamp();
    const verifiedAmountMinor = amountToMinor(verified.charged_amount ?? verified.amount);
    const verifiedCurrency = String(verified.currency || "").toUpperCase();

    transaction.update(userReference, { credits: newBalance, updatedAt: timestamp });
    transaction.update(paymentReference, {
      status: "successful",
      credited: true,
      flutterwaveTransactionId: transactionId,
      verifiedAmount: billingAmountFromMinor(verifiedAmountMinor),
      verifiedAmountMinor,
      verifiedCurrency,
      flutterwaveReference: String(verified.flw_ref || "") || null,
      previousBalance,
      balanceAfter: newBalance,
      paidAt: timestamp,
      updatedAt: timestamp,
    });
    transaction.create(ledgerReference, {
      uid,
      type: "flutterwave_purchase",
      amount: credits,
      previousBalance,
      newBalance,
      paymentId: txRef,
      flutterwaveTransactionId: transactionId,
      createdAt: timestamp,
    });
    transaction.create(auditReference, {
      actorUid: "flutterwave-webhook",
      actorEmail: null,
      action: "payment.credited",
      targetType: "payment",
      targetId: txRef,
      metadata: { uid, credits, previousBalance, newBalance, transactionId },
      createdAt: timestamp,
    });
    return { credited: true, duplicate: false, txRef, uid, credits, newBalance };
  });
}

async function handlePaymentReversalEvent(
  eventType: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const database = adminDb();
  const providerEventId = String(data.id || data.webhook_id || "unknown").slice(0, 180);
  const flutterwaveReference = String(data.flw_ref || data.FlwRef || "").trim();
  const txRefText = String(data.tx_ref || "").trim();
  const originalTransactionId = Number(
    data.TransactionId ?? data.transaction_id ?? data.charge_id ?? 0,
  );

  let paymentSnapshot;
  if (/^[A-Za-z0-9_-]{1,180}$/.test(txRefText)) {
    const direct = await database.collection(collections.payments).doc(txRefText).get();
    if (direct.exists) paymentSnapshot = direct;
  }
  if (!paymentSnapshot && Number.isSafeInteger(originalTransactionId) && originalTransactionId > 0) {
    const matches = await database.collection(collections.payments)
      .where("flutterwaveTransactionId", "==", originalTransactionId)
      .limit(2)
      .get();
    if (matches.size === 1) paymentSnapshot = matches.docs[0];
  }
  if (!paymentSnapshot && flutterwaveReference) {
    const matches = await database.collection(collections.payments)
      .where("flutterwaveReference", "==", flutterwaveReference)
      .limit(2)
      .get();
    if (matches.size === 1) paymentSnapshot = matches.docs[0];
  }
  if (!paymentSnapshot) {
    return { received: true, ignored: true, reason: "payment_not_matched", eventType };
  }

  const paymentRef = paymentSnapshot.ref;
  const uid = String(paymentSnapshot.data()?.uid || "");
  const auditRef = database.collection(collections.audit).doc(
    stableId(`flutterwave-event:${eventType}:${providerEventId}:${flutterwaveReference}:${paymentRef.id}`),
  );
  const disputeStatus = String(data.status || eventType.split(".").pop() || "review").toLowerCase();
  const requiresHold = eventType === "refund.completed"
    || new Set(["initiated", "pending", "accepted", "lost"]).has(disputeStatus);

  const result = await database.runTransaction(async (transaction) => {
    const [currentPayment, priorAudit] = await Promise.all([
      transaction.get(paymentRef),
      transaction.get(auditRef),
    ]);
    if (priorAudit.exists) return { duplicate: true };
    if (!currentPayment.exists || currentPayment.data()?.uid !== uid) {
      throw new HttpError(409, "payment_mismatch", "The disputed payment record changed during processing.");
    }
    const now = FieldValue.serverTimestamp();
    transaction.update(paymentRef, {
      status: eventType === "refund.completed" ? "refunded" : `chargeback_${disputeStatus}`,
      reviewRequired: requiresHold,
      providerEventId,
      disputeEvent: eventType,
      disputeStatus,
      disputeAmount: Number(data.AmountRefunded ?? data.amount ?? 0) || 0,
      disputeUpdatedAt: now,
      updatedAt: now,
    });
    if (requiresHold && uid) {
      transaction.set(database.collection(collections.users).doc(uid), {
        status: "suspended",
        suspendedAt: now,
        suspensionReason: `Automatic billing review: ${eventType}`,
        billingReviewPaymentId: paymentRef.id,
        updatedAt: now,
      }, { merge: true });
    }
    transaction.create(auditRef, {
      actorUid: "flutterwave-webhook",
      actorEmail: null,
      action: requiresHold ? "payment.dispute_hold" : "payment.dispute_updated",
      targetType: "payment",
      targetId: paymentRef.id,
      metadata: {
        uid,
        eventType,
        disputeStatus,
        providerEventId,
        flutterwaveReference,
      },
      createdAt: now,
    });
    return { duplicate: false };
  });
  return {
    received: true,
    eventType,
    paymentId: paymentRef.id,
    accountHeld: requiresHold,
    ...result,
  };
}

function validateVerifiedPayment(
  payment: Record<string, unknown>,
  verified: Record<string, unknown>,
  txRef: string,
  transactionId: number,
  expectedEmail?: string | null,
): void {
  if (String(verified.status || "").toLowerCase() !== "successful") {
    throw new HttpError(409, "payment_not_successful", "Flutterwave has not confirmed this payment as successful.");
  }
  if (Number(verified.id) !== transactionId || String(verified.tx_ref || "") !== txRef) {
    throw new HttpError(409, "verification_mismatch", "Flutterwave transaction identity does not match this purchase.");
  }
  const verifiedCurrency = String(verified.currency || "").toUpperCase();
  const expectedCurrency = String(payment.currency || "").toUpperCase();
  const verifiedAmountMinor = amountToMinor(verified.charged_amount ?? verified.amount);
  const expectedAmountMinor = Number.isSafeInteger(payment.amountMinor)
    ? Number(payment.amountMinor)
    : amountToMinor(payment.amount);
  if (verifiedCurrency !== expectedCurrency || verifiedAmountMinor < expectedAmountMinor) {
    throw new HttpError(409, "payment_mismatch", "Verified Flutterwave amount or currency does not match the purchase.");
  }

  const storedEmail = String(payment.email || "").trim().toLowerCase();
  const customer = verified.customer && typeof verified.customer === "object" && !Array.isArray(verified.customer)
    ? verified.customer as Record<string, unknown>
    : {};
  const verifiedEmail = String(customer.email || "").trim().toLowerCase();
  const authenticatedEmail = String(expectedEmail || "").trim().toLowerCase();
  if (!storedEmail || !verifiedEmail || storedEmail !== verifiedEmail) {
    throw new HttpError(409, "payment_customer_mismatch", "Verified Flutterwave customer does not match the purchase.");
  }
  if (authenticatedEmail && authenticatedEmail !== storedEmail) {
    throw new HttpError(403, "payment_forbidden", "This payment belongs to another Morphly account.");
  }
}

async function safeBillingConfig(): Promise<BillingConfig> {
  try {
    return await loadBillingConfig();
  } catch (error) {
    if (error instanceof BillingConfigValidationError) {
      throw new HttpError(503, "billing_config_invalid", error.message);
    }
    throw error;
  }
}

function billingConfigPayload(config: BillingConfig, includeDisabled: boolean): Record<string, unknown> {
  const plans = config.plans
    .filter((plan) => includeDisabled || plan.enabled)
    .map((plan) => ({
      ...plan,
      amount: billingAmountFromMinor(plan.amountMinor),
      currency: config.currency,
    }));
  return {
    billing: {
      version: config.version,
      currency: config.currency,
      periodSeconds: config.periodSeconds,
      creditsPerPeriod: config.creditsPerPeriod,
      plans,
      updatedAt: config.updatedAt,
      updatedBy: includeDisabled ? config.updatedBy : null,
    },
    version: config.version,
    currency: config.currency,
    periodSeconds: config.periodSeconds,
    creditsPerPeriod: config.creditsPerPeriod,
    plans,
  };
}

function immutablePlanSnapshot(config: BillingConfig, plan: BillingPlan): Record<string, unknown> {
  return {
    id: plan.id,
    label: plan.label,
    credits: plan.credits,
    amountMinor: plan.amountMinor,
    amount: billingAmountFromMinor(plan.amountMinor),
    currency: config.currency,
    billingConfigVersion: config.version,
  };
}

function initializedPaymentPayload(input: {
  txRef: string;
  checkoutMode: CheckoutMode;
  checkoutUrl: string | null;
  publicKey: string | null;
  amount: number;
  config: BillingConfig;
  plan: BillingPlan;
  user: AuthenticatedUser;
}): Record<string, unknown> {
  const inline = input.checkoutMode === "inline" ? {
    publicKey: input.publicKey,
    txRef: input.txRef,
    amount: input.amount,
    currency: input.config.currency,
    customer: { email: input.user.email, name: input.user.displayName },
    meta: {
      uid: input.user.uid,
      planId: input.plan.id,
      credits: input.plan.credits,
      billingConfigVersion: input.config.version,
    },
    customizations: {
      title: "Morphly Voice credits",
      description: `${input.plan.credits.toLocaleString("en-US")} Morphly credits`,
    },
  } : null;
  return {
    checkoutMode: input.checkoutMode,
    checkoutUrl: input.checkoutUrl,
    link: input.checkoutUrl,
    inline,
    reference: input.txRef,
    txRef: input.txRef,
    amount: input.amount,
    amountMinor: input.plan.amountMinor,
    currency: input.config.currency,
    credits: input.plan.credits,
    status: "pending",
    payment: {
      txRef: input.txRef,
      planId: input.plan.id,
      planLabel: input.plan.label,
      billingConfigVersion: input.config.version,
      credits: input.plan.credits,
      amount: input.amount,
      amountMinor: input.plan.amountMinor,
      currency: input.config.currency,
      checkoutMode: input.checkoutMode,
      status: "pending",
    },
  };
}

function paymentStatusPayload(id: string, payment: Record<string, unknown>, includeBalance: boolean): Record<string, unknown> {
  return {
    id,
    txRef: String(payment.txRef || id),
    reference: String(payment.txRef || id),
    planId: String(payment.planId || ""),
    planLabel: String(payment.planLabel || ""),
    credits: Number(payment.credits) || 0,
    amount: Number(payment.amount) || 0,
    amountMinor: Number(payment.amountMinor) || amountToMinor(payment.amount),
    currency: String(payment.currency || "USD"),
    checkoutMode: String(payment.checkoutMode || "hosted"),
    status: String(payment.status || "pending"),
    credited: payment.credited === true,
    ...(includeBalance && payment.balanceAfter !== undefined ? { newBalance: Number(payment.balanceAfter) } : {}),
  };
}

async function ownedPaymentSnapshot(txRef: string, uid: string) {
  const snapshot = await adminDb().collection(collections.payments).doc(txRef).get();
  if (!snapshot.exists) throw new HttpError(404, "payment_not_found", "No Morphly purchase matches this transaction reference.");
  if (String(snapshot.data()?.uid || "") !== uid) {
    throw new HttpError(403, "payment_forbidden", "This payment belongs to another Morphly account.");
  }
  return snapshot;
}

async function markPaymentStatus(txRef: string, status: string): Promise<void> {
  const reference = adminDb().collection(collections.payments).doc(txRef);
  await adminDb().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    // Never let a late failed/pending verification overwrite a concurrent
    // successful fulfillment.
    if (!snapshot.exists || snapshot.data()?.credited === true) return;
    transaction.set(reference, { status, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
}

function validatedRedirectUrl(): string {
  const redirectUrl = process.env.FLUTTERWAVE_REDIRECT_URL?.trim();
  if (!redirectUrl) {
    throw new HttpError(503, "payments_unavailable", "FLUTTERWAVE_REDIRECT_URL is not configured.");
  }
  try {
    const parsed = new URL(redirectUrl);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error("invalid protocol");
  } catch {
    throw new HttpError(503, "payments_unavailable", "FLUTTERWAVE_REDIRECT_URL is invalid.");
  }
  return redirectUrl;
}

function validatedTxRef(value: string | undefined): string {
  const txRef = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(txRef)) {
    throw new HttpError(400, "invalid_transaction_reference", "Flutterwave transaction reference is invalid.");
  }
  return txRef;
}

function positiveTransactionId(value: unknown): number {
  const transactionId = Number(value);
  if (!Number.isSafeInteger(transactionId) || transactionId <= 0) {
    throw new HttpError(400, "invalid_transaction_id", "A valid Flutterwave transaction ID is required.");
  }
  return transactionId;
}

function amountToMinor(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpError(409, "payment_mismatch", "Flutterwave returned an invalid payment amount.");
  }
  const minor = amount * 100;
  if (Math.abs(minor - Math.round(minor)) > 0.000_001 || !Number.isSafeInteger(Math.round(minor))) {
    throw new HttpError(409, "payment_mismatch", "Flutterwave returned an unsupported payment precision.");
  }
  return Math.round(minor);
}

function normalizedPaymentStatus(value: string): string {
  if (value === "cancelled" || value === "canceled") return "cancelled";
  if (value === "failed") return "failed";
  return value || "pending";
}
