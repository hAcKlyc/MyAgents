/**
 * Shared subscription types for frontend and backend
 */

export interface SubscriptionInfo {
  accountUuid?: string;
  email?: string;
  displayName?: string;
  organizationName?: string;
}

export interface SubscriptionStatus {
  available: boolean;
  path?: string;
  info?: SubscriptionInfo;
}

// Extended status for frontend with verification state
export interface SubscriptionStatusWithVerify extends SubscriptionStatus {
  verifyStatus?: 'idle' | 'loading' | 'valid' | 'invalid';
  verifyError?: string;
}
