// Providers that core reads time and identity from, so the same inputs give the same records.

export interface Clock {
  now(): Date;
}

export interface IdSource {
  /** A new unique ID starting with `<prefix>_`, for example `snap_…`. */
  next(prefix: string): string;
}
