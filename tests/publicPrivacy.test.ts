import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
// @ts-expect-error The dependency-free checker is also a standalone Node CLI.
import {inspectPublicFile,formatFindings,checkRepository} from '../scripts/check-public-privacy.mjs';

test('public checker accepts unconfigured source and exact synthetic fixtures',()=>{
 for(const [path,value] of [['.env.example','VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co\nVITE_NOTIFICATIONS_ENABLED=false'],['qa/browser.mjs','sb_publishable_'+'fixture_only'],['supabase/functions/dispatch-notifications/dispatch.test.ts','sb_secret_'+'synthetic_test_only'],['docs/example.md','person@example.test'],['src/GroupForms.tsx','name'+'@gmail.com']])assert.deepEqual(inspectPublicFile(path,Buffer.from(value)),[]);
});
test('public checker rejects sensitive literals without reproducing values in its diagnostics',()=>{
 const samples=[['sb_secret_', 'a'.repeat(32)],['eyJ'+ 'x'.repeat(15),'.'+'y'.repeat(18)+'.'+'z'.repeat(18)],['https://','a'.repeat(20)+'.supabase.co'],['https://','synthetic-deployment.pages.dev'],['person@','mail.example.edu'],['postgresql://','person:synthetic-password@database.test/db'],['-----BEGIN ','PRIVATE KEY-----']].map(parts=>parts.join(''));
 for(const value of samples){const issues=inspectPublicFile('src/accident.ts',Buffer.from('line one\n'+value));assert.ok(issues.length,value.slice(0,5));const output=formatFindings(issues);assert.ok(!output.includes(value));assert.match(output,/src\/accident\.ts:2/);}
 // An example credential string outside its single test fixture is not an exception.
 assert.ok(inspectPublicFile('src/config.ts',Buffer.from('sb_secret_'+'synthetic_test_only')).length);
});
test('force-added private artifacts and unreviewed or changed images fail the public check',()=>{
 for(const path of ['.env.local','exports/household.json','qa/artifacts/account.png','backup.dump','original.jpeg','supabase/.temp/project-ref'])assert.ok(inspectPublicFile(path,Buffer.from('sample')).length,path);
 const bytes=readFileSync(new URL('../public/icons/pact-192.png',import.meta.url)),path='docs/images/fixture.png';
 assert.ok(inspectPublicFile(path,bytes).length);
 const approved={[path]:createHash('sha256').update(bytes).digest('hex')};assert.deepEqual(inspectPublicFile(path,bytes,approved),[]);
 assert.ok(inspectPublicFile(path,Buffer.concat([bytes,Buffer.from([3])]),approved).length);
 const chunk=Buffer.concat([Buffer.from([0,0,0,3]),Buffer.from('tEXt'),Buffer.from('x=y'),Buffer.alloc(4)]),withMetadata=Buffer.concat([bytes.subarray(0,-12),chunk,bytes.subarray(-12)]);
 assert.ok(inspectPublicFile(path,withMetadata,{[path]:createHash('sha256').update(withMetadata).digest('hex')}).some((issue:{rule:string})=>issue.rule.includes('metadata')));
 const disguised='src/config.ts';assert.ok(inspectPublicFile(disguised,bytes,{[disguised]:createHash('sha256').update(bytes).digest('hex')}).length,'The review manifest cannot exempt source files from scanning');
});
test('repository check reads the staged version even after a sensitive working file is cleared',t=>{
 const root=mkdtempSync(join(tmpdir(),'pact-public-check-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
 git('init','--quiet');mkdirSync(join(root,'scripts'));writeFileSync(join(root,'scripts/reviewed-public-assets.json'),'{}\n');
 const value=['sb_secret_','z'.repeat(32)].join('');writeFileSync(join(root,'config.txt'),value);git('add','.');writeFileSync(join(root,'config.txt'),'unconfigured\n');
 const report=checkRepository(root);assert.ok(report.findings.some((finding:{path:string;snapshot:string})=>finding.path==='config.txt'&&finding.snapshot==='index'));assert.ok(!formatFindings(report.findings).includes(value));
});
