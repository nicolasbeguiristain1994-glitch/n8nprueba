export function secureDatabaseTransport(connectionString?: string, host?: string, env?: Record<string, string | undefined>): {
  connectionString?: string
  ssl: false | { rejectUnauthorized: true; ca?: string }
}
