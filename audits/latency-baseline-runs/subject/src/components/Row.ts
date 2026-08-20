/** Presentation helpers for a ledger row. */
export function rowClass(cents: number): string {
  return cents < 0 ? 'ledger-row ledger-row--negative' : 'ledger-row';
}
