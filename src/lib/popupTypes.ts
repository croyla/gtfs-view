export type DiffFilter = 'all' | 'added' | 'removed' | 'moved' | 'changed' | 'unchanged';

export type CardEntry =
  | { type: 'stop';  stopId: string }
  | { type: 'route'; routeId: string }
  | { type: 'trip';  tripId: string }
  | { type: 'diff-summary' }
  | { type: 'diff-stops';  filter: DiffFilter }
  | { type: 'diff-routes'; filter: DiffFilter }
  | { type: 'diff-trips';  filter: DiffFilter };