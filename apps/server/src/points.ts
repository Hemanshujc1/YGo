// PostGIS geography points, read and written as latitude and longitude.

/** SQL reading a geography `column` as `{ latitude, longitude }`, or null. */
export function pointJson(column: string): string {
  return `CASE WHEN ${column} IS NULL THEN NULL
    ELSE json_build_object('latitude', ST_Y(${column}::geometry), 'longitude', ST_X(${column}::geometry)) END`;
}

/** SQL making a geography point from two query parameters, or null when the latitude is null. */
export function pointFrom(latitude: string, longitude: string): string {
  return `CASE WHEN ${latitude}::float8 IS NULL THEN NULL
    ELSE ST_SetSRID(ST_MakePoint(${longitude}::float8, ${latitude}::float8), 4326)::geography END`;
}
