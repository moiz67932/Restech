export type WebhookSecretStatus = 'pending' | 'active' | 'grace' | 'retired' | 'revoked';

export interface WebhookSecretVersion {
  version: number;
  status: WebhookSecretStatus;
  validFrom: Date;
  graceUntil?: Date;
  retiredAt?: Date;
  revokedAt?: Date;
}

export interface RotationPolicy {
  graceSeconds: number;
  now?: Date;
}

export function startWebhookRotation(
  versions: readonly WebhookSecretVersion[],
  policy: RotationPolicy,
): WebhookSecretVersion[] {
  if (
    !Number.isInteger(policy.graceSeconds) ||
    policy.graceSeconds < 0 ||
    policy.graceSeconds > 604800
  )
    throw new Error('Invalid webhook rotation grace period');
  const current = versions.find((version) => version.status === 'active');
  if (!current) throw new Error('An active webhook secret is required');
  const nextVersion = Math.max(...versions.map((version) => version.version), 0) + 1;
  const now = policy.now ?? new Date();
  const graceUntil = new Date(now.getTime() + policy.graceSeconds * 1000);
  return versions
    .map((version) =>
      version.version === current.version
        ? { ...version, status: 'grace' as const, graceUntil }
        : version,
    )
    .concat({ version: nextVersion, status: 'active', validFrom: now });
}

export function expireWebhookGrace(
  versions: readonly WebhookSecretVersion[],
  now = new Date(),
): WebhookSecretVersion[] {
  return versions.map((version) =>
    version.status === 'grace' && version.graceUntil && version.graceUntil <= now
      ? { ...version, status: 'retired' as const, retiredAt: now }
      : version,
  );
}

export function revokeWebhookVersion(
  versions: readonly WebhookSecretVersion[],
  versionToRevoke: number,
  now = new Date(),
): WebhookSecretVersion[] {
  let found = false;
  const next = versions.map((version) => {
    if (version.version !== versionToRevoke || version.status === 'revoked') return version;
    found = true;
    const { graceUntil, ...withoutGrace } = version;
    void graceUntil;
    return { ...withoutGrace, status: 'revoked' as const, revokedAt: now };
  });
  if (!found) throw new Error('Webhook secret version not found');
  return next;
}

/** Every retry of an event must use this captured version, even after rotation. */
export function bindEventToWebhookVersion(active: WebhookSecretVersion): number {
  if (active.status !== 'active') throw new Error('Only an active secret can bind new work');
  return active.version;
}

export function canDeliverWithVersion(
  version: WebhookSecretVersion | undefined,
  eventBound = true,
): boolean {
  if (!version || version.status === 'revoked') return false;
  return eventBound || version.status === 'active';
}
