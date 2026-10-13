import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import pg from 'pg';
import { secureDatabaseTransport } from '../../../frontend/lib/database-tls.js';

const remote = 'postgresql://fixture:synthetic@db.fixture.supabase.co/database';
test('pg cannot downgrade remote TLS using connection-string SSL options', () => {
  for (const query of ['sslmode=no-verify', 'ssl=false', 'sslmode=disable', 'sslmode=require&uselibpqcompat=true', 'sslrootcert=/missing&sslkey=/missing&sslcert=/missing']) {
    const transport = secureDatabaseTransport(remote + '?' + query + '&application_name=security-test', undefined, {});
    const client = new pg.Client(transport);
    assert.equal(client.connectionParameters.ssl.rejectUnauthorized, true);
    assert.match(client.connectionParameters.ssl.ca, /BEGIN CERTIFICATE/);
    assert.equal(client.connectionParameters.application_name, 'security-test');
  }
});
test('URL endpoint overrides cannot turn a loopback exception into a remote connection', () => {
  for (const query of ['host=evil.invalid', 'hostaddr=203.0.113.1', 'port=5439']) {
    assert.throws(() => secureDatabaseTransport('postgres://u:p@localhost/test?' + query, undefined, {}), /endpoint overrides/);
  }
});
test('remote insecure settings fail closed; local development remains supported', () => {
  for (const env of [{ DB_SSL: 'false' }, { DB_POSTGRESDB_SSL: ' false\n' }, { DB_SSL_REJECT_UNAUTHORIZED: 'false' }]) {
    assert.throws(() => secureDatabaseTransport(remote, undefined, env), /require TLS/);
  }
  for (const host of ['localhost', '127.0.0.1', '::1', '[::1]']) {
    assert.equal(secureDatabaseTransport(undefined, host, {}).ssl, false);
    assert.deepEqual(secureDatabaseTransport(undefined, host, { DB_SSL: 'true' }).ssl, { rejectUnauthorized: true });
  }
  assert.throws(() => secureDatabaseTransport('https://example.invalid/db', undefined, {}), /protocol/);
});
test('CA trust is scoped to Supabase hosts and allows an explicit private CA', () => {
  for (const host of ['db.fixture.supabase.co', 'aws-0-region.pooler.supabase.com']) {
    const { ssl } = secureDatabaseTransport(undefined, host, {});
    const root = new X509Certificate(ssl.ca);
    assert.equal(root.ca, true);
    assert.equal(root.fingerprint256.replaceAll(':','').toLowerCase(), '807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa');
  }
  assert.deepEqual(secureDatabaseTransport(undefined, 'database.example.invalid', {}).ssl, { rejectUnauthorized: true });
  assert.equal(secureDatabaseTransport(remote, undefined, { DB_SSL_CA: ' custom-ca ' }).ssl.ca, 'custom-ca');
});
