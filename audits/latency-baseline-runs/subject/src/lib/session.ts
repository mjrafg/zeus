/** Session handling for the sample app. */
export interface Session { id: string; issuedAt: number; ttlSeconds: number }

export function isExpired(s: Session, nowMs: number): boolean {
  return nowMs - s.issuedAt > s.ttlSeconds * 1000;
}

export function remainingSeconds(s: Session, nowMs: number): number {
  const left = s.ttlSeconds - (nowMs - s.issuedAt) / 1000;
  return left > 0 ? Math.floor(left) : 0;
}
