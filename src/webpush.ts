import webpush from 'web-push';

// ─── VAPID config ─────────────────────────────────────────────────────────────
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY ?? 'BMBrxfDnd2di28F9cOPoscqs73aN-kZ15tuW8zER2u2XFU5hkqon7OywvcOV6ma8P6c8KMo6C7z8Z3K7N1MH3Uo';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? 'GohJuVMJQIxIiwo0M9royRRL--q3bj6opdidygAkr_g';
const VAPID_MAILTO = process.env.VAPID_MAILTO ?? 'mailto:admin@fl-liga.app';

webpush.setVapidDetails(VAPID_MAILTO, VAPID_PUBLIC, VAPID_PRIVATE);

export const vapidPublicKey = VAPID_PUBLIC;

// ─── Subscription store ──────────────────────────────────────────────────────
// Key: matchId  Value: set of serialized PushSubscription objects
const subscriptionsByMatch = new Map<string, Set<string>>();

export interface StoredSubscription {
  matchId: string;
  subscription: webpush.PushSubscription;
}

export function addPushSubscription(matchId: string, subscription: webpush.PushSubscription): void {
  const key = JSON.stringify(subscription);
  if (!subscriptionsByMatch.has(matchId)) {
    subscriptionsByMatch.set(matchId, new Set());
  }
  subscriptionsByMatch.get(matchId)!.add(key);
}

export function removePushSubscription(matchId: string, subscription: webpush.PushSubscription): void {
  const key = JSON.stringify(subscription);
  subscriptionsByMatch.get(matchId)?.delete(key);
}

// ─── Send push to all subscribers of a match ─────────────────────────────────
export async function sendPushToMatch(matchId: string, title: string, body: string, tag: string): Promise<void> {
  const subs = subscriptionsByMatch.get(matchId);
  if (!subs || subs.size === 0) return;

  const payload = JSON.stringify({ title, body, tag });
  const dead: string[] = [];

  await Promise.allSettled(
    Array.from(subs).map(async (raw) => {
      try {
        const sub = JSON.parse(raw) as webpush.PushSubscription;
        await webpush.sendNotification(sub, payload);
      } catch (err: unknown) {
        // 404/410 = suscripción caducada, la eliminamos
        if (err && typeof err === 'object' && 'statusCode' in err) {
          const status = (err as { statusCode: number }).statusCode;
          if (status === 404 || status === 410) {
            dead.push(raw);
          }
        }
      }
    }),
  );

  for (const raw of dead) {
    subs.delete(raw);
  }
}
