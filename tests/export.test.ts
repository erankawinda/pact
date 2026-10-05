import {test} from 'node:test';
import assert from 'node:assert/strict';
import {csvCell,ledgerCsv} from '../src/export.ts';
import type {Snapshot} from '../src/api.ts';
test('exports preserve CSV quotes and neutralise spreadsheet formulas; incomplete exports fail closed',()=>{
 assert.equal(csvCell('Milk, "large"'),'"Milk, ""large"""');
 for(const payload of ['=HYPERLINK("https://example.test")','+1+1','@SUM(1)','  =1+1','\tformula','-2'])assert.ok(csvCell(payload).startsWith('"\''));
 assert.equal(csvCell('Ordinary groceries'),'"Ordinary groceries"');
 assert.throws(()=>ledgerCsv({expenses:[],expense_count:1} as unknown as Snapshot),/incomplete file/);
});
