/** Display-only formatting: IDs remain the action/routing keys. */
export function peerDisplayName(id: string, name?: string | null): string {
  const label = typeof name === 'string' ? name.trim() : '';
  return label && label !== id ? `${label}（${id}）` : id;
}
