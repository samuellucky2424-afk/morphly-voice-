import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { authenticate } from "./auth";
import { adminDb } from "./firebase-admin";
import { collections, stableId } from "./data";
import {
  HttpError,
  headerValue,
  readBody,
  requireObject,
  stringField,
  type ApiRequest,
} from "./http";

type CreditPlan = {
  id: string;
  credits: number;
  amount: number;
  currency: string;
  label: string;
};

const DEFAULT_PLANS: CreditPlan[] = [
  { id: "starter", credits: 1000, amount: 10, currency: "USD", label: "Starter credits" },
  { id: "creator", credits: 2500, amount: 22, currency: "USD", label: "Creator credits" },
  { id: "studio", credits: 6000, amount: 48, currency: "USD", label: "Studio credits" },
];

function plans(): CreditPlan[] {
  const raw = process.env.MORPHLY_CREDIT_PLANS_JSON;
  if (!raw) return DEFAULT_PLANS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("MORPHLY_CREDIT_PLANS_JSON must contain valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("MORPHLY_CREDIT_PLANS_JSON must be an array.");
  return parsed.map((candidate) => {
    if (!candidate || typeof candidate !== "object") throw new Error("Each credit plan must be an object.");
    const plan = candidate as Record<string, unknown>;
    const normalized: CreditPlan = {
      id: String(plan.id || "").trim(),
      label: String(plan.label || plan.id || "").trim(),
      credits: Number(plan.credits),
      amount: Number(plan.amount),
      currency: String(plan.currency || "USD").trim().toUpperCase(),
    };
    if (
      !/^[a-z0-9_-]{1,50}$/i.test(normalized.id) ||
      !Number.isSafeInteger(normalized.credits) || normalized.credits <= 0 ||
      !Number.isFinite(normalized.amount) || normalized.amount <= 0 ||
      !/^[A-Z]{3}$/.test(normalized.currency)
    ) {
      throw new Error(`Invalid Morphly credit plan: ${normalized.id || "unnamed"}.`);
    }
    return normalized;
  });
}

function flutterwaveSecret(): string {
  const secret = process.env.FLUTTERWAVE_SECRET_KEY?.trim();
  if (!secret) throw new HttpError(503, "payments_unavailable", "Flutterwave payments are not configured.");
  return secret;
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

export async function initializePayment(request: ApiRequest): Promise<Record<string, unknown>> {
  const user = await authenticate(request);
  if (!user.email) throw new HttpError(400, "email_required", "A verified account email is required for payment.");
  const body = requireObject((await readBody(request)).value);
  const planId =
    stringField(body, "planId", { max: 50 }) ||
    stringField(body, "packageId", { required: true, max: 50 });
  const plan = plans().find((candidate) => candidate.id === planId);
  if (!plan) throw new HttpError(400, "invalid_plan", "The selected credit package does not exist.");

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

  const txRef = `morphly_${stableId(user.uid).slice(0, 20)}_${Date.now()}_${randomBytes(6).toString("hex")}`;
  const database = adminDb();
  const paymentReference = database.collection(collections.payments).doc(txRef);
  await paymentReference.create({
    txRef,
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    planId: plan.id,
    credits: plan.credits,
    amount: plan.amount,
    currency: plan.currency,
    status: "initializing",
    credited: false,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  try {
    const response = await flutterwaveRequest("/payments", {
      method: "POST",
      body: JSON.stringify({
        tx_ref: txRef,
        amount: plan.amount,
        currency: plan.currency,
        redirect_url: redirectUrl,
        customer: { email: user.email, name: user.displayName },
        meta: { uid: user.uid, plan_id: plan.id, credits: plan.credits },
        customizations: {
          title: "Morphly Voice credits",
          description: `${plan.credits.toLocaleString("en-US")} Morphly credits`,
        },
      }),
    });
    const data = response.data as Record<string, unknown> | undefined;
    const checkoutUrl = String(data?.link || "");
    if (!checkoutUrl) throw new HttpError(502, "flutterwave_error", "Flutterwave did not return a checkout link.");
    await paymentReference.update({
      status: "pending",
      checkoutUrl,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      checkoutUrl,
      link: checkoutUrl,
      reference: txRef,
      amount: plan.amount,
      currency: plan.currency,
      credits: plan.credits,
      status: "pending",
      payment: {
        txRef,
        planId: plan.id,
        credits: plan.credits,
        amount: plan.amount,
        currency: plan.currency,
        status: "pending",
      },
    };
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

export async function flutterwaveWebhook(request: ApiRequest): Promise<Record<string, unknown>> {
  const parsedBody = await readBody(request);
  verifyWebhookSignature(request, parsedBody.raw);
  const body = requireObject(parsedBody.value);
  const webhookData = body.data;
  if (!webhookData || typeof webhookData !== "object" || Array.isArray(webhookData)) {
    return { received: true, ignored: true, reason: "missing_transaction_data" };
  }
  const data = webhookData as Record<string, unknown>;
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
  if (status !== "successful") {
    return { received: true, ignored: true, reason: `transaction_${status || "not_successful"}` };
  }

  const txRef = String(verified.tx_ref || "");
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(txRef)) {
    throw new HttpError(400, "invalid_transaction_reference", "Flutterwave transaction reference is invalid.");
  }
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
    if (payment.credited === true) {
      return { credited: false, duplicate: true, txRef, newBalance: payment.balanceAfter ?? null };
    }

    const verifiedCurrency = String(verified.currency || "").toUpperCase();
    const verifiedAmount = Number(verified.charged_amount ?? verified.amount);
    const expectedCurrency = String(payment.currency || "").toUpperCase();
    const expectedAmount = Number(payment.amount);
    if (
      verifiedCurrency !== expectedCurrency ||
      !Number.isFinite(verifiedAmount) ||
      !Number.isFinite(expectedAmount) ||
      verifiedAmount < expectedAmount
    ) {
      throw new HttpError(409, "payment_mismatch", "Verified Flutterwave amount or currency does not match the purchase.");
    }

    const uid = String(payment.uid || "");
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

    transaction.update(userReference, { credits: newBalance, updatedAt: timestamp });
    transaction.update(paymentReference, {
      status: "successful",
      credited: true,
      flutterwaveTransactionId: transactionId,
      verifiedAmount,
      verifiedCurrency,
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
