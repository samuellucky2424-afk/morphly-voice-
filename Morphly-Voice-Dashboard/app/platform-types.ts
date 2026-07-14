export type PlatformRole = "user" | "admin";

export type AccountStatus = "active" | "suspended" | "pending" | "disabled";

export type PlatformSessionSource = "cloud";

export type VoiceEngineName = "rvc" | "beatrice";

export type NotificationKind = "info" | "success" | "warning" | "critical";

export type NotificationAudience = "all" | "users" | "admins" | "selected";

export type PurchaseStatus = "pending" | "successful" | "failed" | "cancelled" | "refunded";

export type LogLevel = "debug" | "info" | "warning" | "error" | "critical";

export interface PlatformSession {
  uid: string;
  email: string;
  displayName: string;
  photoUrl: string | null;
  role: PlatformRole;
  status: AccountStatus;
  credits: number;
  source: PlatformSessionSource;
  createdAt: string | null;
  lastSeenAt: string | null;
}

export interface PublicNotification {
  id: string;
  title: string;
  message: string;
  kind: NotificationKind;
  createdAt: string;
  startsAt: string | null;
  endsAt: string | null;
  actionLabel: string | null;
  actionUrl: string | null;
  isRead: boolean;
  readAt: string | null;
}

export type BillingCurrency = "USD" | "NGN";

export interface BillingPlan {
  id: string;
  label: string;
  credits: number;
  amountMinor: number;
  amount: number;
  currency: BillingCurrency;
  enabled: boolean;
  bestValue: boolean;
  sortOrder: number;
}

export interface BillingConfig {
  version: number;
  currency: BillingCurrency;
  periodSeconds: 10;
  creditsPerPeriod: 2;
  plans: BillingPlan[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface UserSessionRecord {
  id: string;
  clientSessionId: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  engineMode: VoiceEngineName;
  voiceName: string;
  modelName: string;
  sampleRate: number;
  chunkSize: number;
  latencyMs: number | null;
  status: string;
  creditsCharged: number;
}

export interface SupportConfig {
  email: string;
  phone: string;
  whatsapp: string;
  website: string;
  workingHours: string;
  helpCenterUrl: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface UserBootstrap {
  session: PlatformSession;
  notifications: PublicNotification[];
  support: SupportConfig;
  serverTime: string;
}

export interface UsageSessionInput {
  sessionId: string;
  engine: VoiceEngineName;
  voiceName: string;
  modelName: string;
  sampleRate: number;
  chunkSize: number;
  latencyMs?: number | null;
}

export interface UsageTickResult {
  sessionId: string;
  accepted: boolean;
  duplicate: boolean;
  allowed: boolean;
  status: string;
  creditsRemaining: number;
  chargedCredits: number;
  totalChargedCredits: number;
  billedPeriods: number;
  nextHeartbeatSeconds: number;
}

export interface AnalyticsPoint {
  label: string;
  value: number;
  secondaryValue?: number;
}

export interface AdminOverviewMetrics {
  totalUsers: number;
  activeUsers: number;
  liveUsers: number;
  suspendedUsers: number;
  totalCredits: number;
  totalRevenue: number;
  purchasesToday: number;
  sessionsToday: number;
  averageLatencyMs: number;
  errorRate: number;
}

export interface AdminOverview {
  metrics: AdminOverviewMetrics;
  userGrowth: AnalyticsPoint[];
  revenue: AnalyticsPoint[];
  sessions: AnalyticsPoint[];
  engineUsage: Record<VoiceEngineName, number>;
  reportingCurrency: BillingCurrency;
  generatedAt: string;
}

export interface AdminUser {
  uid: string;
  email: string;
  displayName: string;
  photoUrl: string | null;
  role: PlatformRole;
  status: AccountStatus;
  credits: number;
  createdAt: string;
  lastSeenAt: string | null;
  lastLoginAt: string | null;
  sessionCount: number;
  totalUsageSeconds: number;
  totalSpent: number;
  currency: string;
  country: string | null;
}

export interface AdminLiveSession {
  id: string;
  userId: string;
  userEmail: string;
  userName: string;
  engine: VoiceEngineName;
  voiceName: string;
  startedAt: string;
  lastHeartbeatAt: string;
  latencyMs: number | null;
  cpuPercent: number | null;
  memoryMb: number | null;
  appVersion: string | null;
  platform: string | null;
  status: "starting" | "live" | "idle" | "ended" | "error";
}

export interface AdminPurchase {
  id: string;
  userId: string;
  userEmail: string;
  amount: number;
  currency: string;
  credits: number;
  status: PurchaseStatus;
  provider: "flutterwave";
  providerReference: string;
  createdAt: string;
  paidAt: string | null;
}

export interface AdminLogEntry {
  id: string;
  level: LogLevel;
  category: string;
  event: string;
  message: string;
  userId: string | null;
  sessionId: string | null;
  engine: VoiceEngineName | null;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface AdminNotification extends PublicNotification {
  audience: NotificationAudience;
  selectedUserIds: string[];
  active: boolean;
  createdBy: string;
  deliveryCount: number;
  readCount: number;
}

export interface AdminListQuery {
  search?: string;
  status?: string;
  cursor?: string;
  limit?: number;
  from?: string;
  to?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
}

export interface CreditAdjustmentInput {
  amount: number;
  reason: string;
  reference?: string;
  idempotencyKey?: string;
}

export interface CreditAdjustmentResult {
  user: AdminUser;
  previousBalance: number;
  newBalance: number;
  auditLogId: string;
}

export interface SuspensionInput {
  suspended: boolean;
  reason: string;
}

export interface CreateNotificationInput {
  title: string;
  message: string;
  kind: NotificationKind;
  audience: NotificationAudience;
  selectedUserIds?: string[];
  startsAt?: string | null;
  endsAt?: string | null;
  actionLabel?: string | null;
  actionUrl?: string | null;
}

export type UpdateSupportConfigInput = Pick<
  SupportConfig,
  "email" | "phone" | "whatsapp" | "website" | "workingHours" | "helpCenterUrl"
>;

export interface ClientHeartbeatInput {
  sessionId: string;
  engine: VoiceEngineName;
  status: "starting" | "live" | "idle" | "ended" | "error";
  voiceName?: string;
  latencyMs?: number | null;
  cpuPercent?: number | null;
  memoryMb?: number | null;
  appVersion?: string;
  platform?: string;
  occurredAt?: string;
}

export interface ClientEventInput {
  event: string;
  category: string;
  level?: LogLevel;
  message?: string;
  sessionId?: string;
  engine?: VoiceEngineName;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
}

export interface PaymentInitializationInput {
  planId: string;
  expectedBillingVersion: number;
  expectedAmountMinor: number;
  expectedCurrency: BillingCurrency;
  returnUrl?: string;
  checkoutMode?: "hosted" | "inline";
}

export interface FlutterwaveInlineInitialization {
  publicKey: string;
  txRef: string;
  amount: number;
  currency: BillingCurrency;
  customer: { email: string; name: string };
  meta: Record<string, string | number>;
  customizations: { title: string; description: string };
}

export interface PaymentInitializationResult {
  checkoutUrl: string | null;
  checkoutMode: "hosted" | "inline";
  inline: FlutterwaveInlineInitialization | null;
  reference: string;
  amount: number;
  currency: BillingCurrency;
  credits: number;
  status: "pending";
}

export interface PaymentVerificationResult {
  credited: boolean;
  duplicate: boolean;
  txRef: string;
  newBalance: number | null;
}

export interface PaymentStatusResult {
  txRef: string;
  status: string;
  credited: boolean;
  newBalance: number | null;
}
