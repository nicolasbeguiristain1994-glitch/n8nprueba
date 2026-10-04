import test from 'node:test';
import assert from 'node:assert/strict';
import { connection, compareTables } from '../database-backup.mjs';

test('restore refuses remote hosts and connection-string overrides', () => {
  for (const url of ['postgres://u:p@production.example/db','postgres://u:p@127.0.0.1/db?host=production.example','https://localhost/db']) {
    assert.throws(() => connection(url, true));
  }
  assert.equal(connection('postgres://u:p@127.0.0.1:55433/postgres', true).local, true);
});
test('restoration must match inventory, row counts AND contents', () => {
  const rows = [{schema:'public',name:'contacts',rows:'3',checksum:'12'}];
  compareTables(rows, structuredClone(rows));
  for (const actual of [[],[{...rows[0],rows:'2'}],[{...rows[0],checksum:'13'}],[{...rows[0],name:'different'}]]) {
    assert.throws(() => compareTables(rows, actual), /differ/);
  }
});
