export interface PickerPage<T> {
  items: T[];
  hasMore: boolean;
  complete: boolean;
  scanLimitReached: boolean;
  nextCursor: string | null;
}
