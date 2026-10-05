import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('PostgreSQL migration, ledger transactions and group isolation',async t=>{
  const db=new PGlite();
  t.after(()=>db.close());
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{"providers":["google"]}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
  const migrationDir=new URL('../supabase/migrations/',import.meta.url);
  for(const file of (await readdir(migrationDir)).filter(f=>f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file,migrationDir),'utf8'));
  }
  const a='00000000-0000-0000-0000-000000000001', b='00000000-0000-0000-0000-000000000002', c='00000000-0000-0000-0000-000000000003';
  await db.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'a@example.com',now()),($2,'b@example.com',now()),($3,'c@example.com',now())`,[a,b,c]);
  async function as(id:string){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');}
  async function scalar(sql:string,params:unknown[]=[]){const r=await db.query<Record<string,unknown>>(sql,params);return Object.values(r.rows[0])[0] as string;}
  const queryExpense=`select public.create_expense($1,$2,$3,$4,$5,$6::uuid[],$7,$8::jsonb,'2026-10-04','groceries','')`;
  await as(a);
  const house=await scalar("select public.create_group('Our place')");
  const token=await scalar('select public.create_invitation($1,$2)',[house,'b@example.com']);
  await as(c);
  await assert.rejects(()=>db.query('select public.accept_invitation($1)',[token]),/invalid_invitation/);
  assert.equal((await db.query('select * from public.groups')).rows.length,0);
  await assert.rejects(()=>db.query('select public.get_group_snapshot($1)',[house]),/forbidden/);
  await as(b);assert.equal(await scalar('select public.accept_invitation($1)',[token]),house);
  assert.equal(await scalar('select public.accept_invitation($1)',[token]),house);
  await assert.rejects(()=>db.query('select public.create_invitation($1,$2)',[house,'c@example.com']),/forbidden/);
  await as(a);
  const request='10000000-0000-0000-0000-000000000001';
  const args=[house,request,'Groceries',10001,a,[b,a],'equal',null];
  const expense=await scalar(queryExpense,args);
  assert.equal(await scalar(queryExpense,args),expense,'retry must return original expense');
  await assert.rejects(()=>db.query(queryExpense,[...args.slice(0,2),'Different',...args.slice(3)]),/idempotency_conflict/);
  const shares=await db.query<{user_id:string;share_cents:number}>('select user_id,share_cents from public.expense_shares where expense_id=$1 order by user_id',[expense]);
  assert.deepEqual(shares.rows.map(s=>Number(s.share_cents)),[5001,5000]);
  let counter=2;
  const req=()=>`10000000-0000-0000-0000-${String(counter++).padStart(12,'0')}`;
  await assert.rejects(()=>db.query(queryExpense,[house,req(),'Empty',100,a,[],'equal',null]),/invalid_split/);
  await assert.rejects(()=>db.query(queryExpense,[house,req(),'Bad exact',100,a,[a,b],'exact',JSON.stringify({[a]:40,[b]:59})]),/invalid_split/);
  await assert.rejects(()=>db.query(queryExpense,[house,req(),'Cross group',100,a,[c],'equal',null]),/invalid_split/);
  await assert.rejects(()=>db.query(queryExpense,[house,req(),'Invalid payer',100,c,[b],'equal',null]),/invalid_payer/);
  await assert.rejects(()=>db.query(queryExpense,[house,req(),'Duplicate',100,a,[a,a],'equal',null]),/invalid_split/);
  assert.equal((await db.query('select * from public.expenses')).rows.length,1,'failed transactions roll back');
  await scalar(queryExpense,[house,req(),'Entirely for B',2500,a,[b],'equal',null]);
  const snapshot=JSON.parse(JSON.stringify(await scalar('select public.get_group_snapshot($1)',[house]))) as unknown as {balances:{user_id:string;cents:number}[];expenses:unknown[]};
  assert.equal(snapshot.expenses.length,2);
  assert.deepEqual(snapshot.balances.map(v=>Number(v.cents)).sort((x,y)=>x-y),[-7500,7500]);
  const trip=await scalar("select public.create_group('Weekend','trip',$1)",[house]);
  await scalar(queryExpense,[trip,req(),'Solo trip cost',9000,a,[a],'equal',null]);
  await as(b);
  assert.equal((await db.query('select * from public.groups')).rows.length,1,'household membership does not grant trip access');
  await assert.rejects(()=>db.query('select public.get_group_snapshot($1)',[trip]),/forbidden/);
  await assert.rejects(()=>db.query("insert into public.expenses(group_id,description,amount_cents,cash_actor_id,split_mode,category,occurred_on,created_by) values($1,'Bypass',100,$2,'equal','other',current_date,$2)",[house,b]),/permission denied/);
  await assert.rejects(()=>db.query('update public.expense_shares set share_cents=0'),/permission denied/);
  await assert.rejects(()=>db.query('select * from public.invitations'),/permission denied/);
  await as(a);
  const tripToken=await scalar('select public.create_invitation($1,$2)',[trip,'b@example.com']);
  await as(b);await scalar('select public.accept_invitation($1)',[tripToken]);
  assert.equal((await db.query('select * from public.groups')).rows.length,2);
  // Simulate an administrator revoking access; finance history must not change.
  await db.exec('reset role');await db.query("update public.group_members set status='revoked' where group_id=$1 and user_id=$2",[house,b]);
  await as(b);await assert.rejects(()=>db.query('select public.get_group_snapshot($1)',[house]),/forbidden/);
  await as(a);const history=await db.query('select * from public.expense_shares where user_id=$1',[b]);assert.equal(history.rows.length,2);
  await db.exec('reset role; set role anon');
  await assert.rejects(()=>db.query('select public.get_group_snapshot($1)',[house]),/permission denied/);
  await db.exec('reset role');
  await assert.rejects(()=>db.query("insert into public.expenses(group_id,description,amount_cents,cash_actor_id,split_mode,category,occurred_on,created_by) values($1,'No shares',100,$2,'equal','other',current_date,$2)",[house,a]),/invalid_split/);
});
