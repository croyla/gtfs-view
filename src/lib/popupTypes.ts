export type CardEntry =
  | { type: 'stop'; stopId: string }
  | { type: 'route'; routeId: string }
  | { type: 'trip'; tripId: string };