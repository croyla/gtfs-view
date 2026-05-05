import initSqlJs from 'sql.js';
import type { SqlJsStatic, SqlValue } from 'sql.js';
import type { LiveData, VehiclePosition } from './liveTypes';

let SQL: SqlJsStatic | null = null;

async function getSql(): Promise<SqlJsStatic> {
  if (!SQL) {
    SQL = await initSqlJs({ locateFile: () => '/sql-wasm.wasm' });
  }
  return SQL;
}

export async function loadLiveDataFromBlob(blob: Blob): Promise<LiveData> {
  const sql = await getSql();
  const buffer = await blob.arrayBuffer();
  const db = new sql.Database(new Uint8Array(buffer));

  try {
    const result = db.exec(
      `SELECT id, vehicle_id, trip_id, route_id, lat, lon, bearing, timestamp, speed, status
       FROM vehicle_positions
       WHERE trip_id IS NOT NULL AND trip_id != ''
       ORDER BY timestamp ASC`,
    );

    if (!result[0]) {
      return { vehiclePositions: [], minTimestamp: 0, maxTimestamp: 0, vehicleCount: 0, routeCount: 0 };
    }

    const { columns, values } = result[0];
    const idx: Record<string, number> = {};
    columns.forEach((c, i) => { idx[c] = i; });

    const col = (row: SqlValue[], name: string): SqlValue => row[idx[name]];

    const vehiclePositions: VehiclePosition[] = values.map(row => ({
      id:         col(row, 'id') as number,
      vehicle_id: (col(row, 'vehicle_id') as string | null) ?? '',
      trip_id:    (col(row, 'trip_id')    as string | null) || null,
      route_id:   (col(row, 'route_id')   as string | null) || null,
      lat:        col(row, 'lat')     as number,
      lon:        col(row, 'lon')     as number,
      bearing:    col(row, 'bearing') as number | null,
      timestamp:  col(row, 'timestamp') as number,
      speed:      col(row, 'speed')   as number | null,
      status:     (col(row, 'status') as string | null) ?? '',
    }));

    // Use DB aggregates to avoid JS spread-overflow on large sets
    const stats = db.exec(
      `SELECT MIN(timestamp), MAX(timestamp),
              COUNT(DISTINCT vehicle_id),
              COUNT(DISTINCT route_id)
       FROM vehicle_positions
       WHERE trip_id IS NOT NULL AND trip_id != ''`,
    );
    const row = stats[0]?.values[0] ?? [0, 0, 0, 0];

    return {
      vehiclePositions,
      minTimestamp: row[0] as number,
      maxTimestamp: row[1] as number,
      vehicleCount: row[2] as number,
      routeCount:   row[3] as number,
    };
  } finally {
    db.close();
  }
}
