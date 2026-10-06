import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

type ProfileRow = {id:string;display_name:string;created_at:Date};

test('display-name changes validate Unicode and are confined to the verified caller',async t=>{
  const db=new PGlite();
  t.after(()=>db.close());
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
      raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{"providers":["google"]}');
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
  const migrations=new URL('../supabase/migrations/',import.meta.url);
  for(const file of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort()){
    await db.exec(await readFile(new URL(file,migrations),'utf8'));
  }
  const a='00000000-0000-4000-8000-000000000001';
  const b='00000000-0000-4000-8000-000000000002';
  const unverified='00000000-0000-4000-8000-000000000003';
  const otherProvider='00000000-0000-4000-8000-000000000004';
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data,raw_app_meta_data)
    values ($1,'alex@example.test',now(),'{"full_name":"Alex"}','{"providers":["google"]}'),
      ($2,'blake@example.test',now(),'{"full_name":"Blake"}','{"providers":["google"]}'),
      ($3,'casey@example.test',null,'{"full_name":"Casey"}','{"providers":["google"]}'),
      ($4,'devin@example.test',now(),'{"full_name":"Devin","providers":["google"]}','{"providers":["email"]}')`,
    [a,b,unverified,otherProvider]);

  async function as(id:string){
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
    await db.exec('set role authenticated');
  }
  async function rename(value:string|null){
    return (await db.query<{name:string}>('select public.update_profile($1) as name',[value])).rows[0].name;
  }
  const before=(await db.query<ProfileRow>('select * from public.profiles order by id')).rows;
  const authBefore=(await db.query('select * from auth.users order by id')).rows;
  await as(a);
  assert.equal(await rename('  Alex Rivera  '),'Alex Rivera');
  assert.deepEqual((await db.query('select id,display_name from public.profiles')).rows,
    [{id:a,display_name:'Alex Rivera'}],'the caller can still read only permitted profiles');
  await assert.rejects(()=>db.query('update public.profiles set display_name=$1 where id=$2',['Other person',b]),
    /permission denied/,'the RPC does not enable direct table writes');
  await assert.rejects(()=>db.query('select public.update_profile($1,$2)',[b,'Other person']),
    /does not exist/,'there is no caller-supplied target-user parameter');

  const whitespace='\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  const unicodeName='Zoë දිනුක් 李 🪴';
  assert.equal(await rename(whitespace+unicodeName+whitespace),unicodeName);
  assert.equal(await rename('🪴'.repeat(80)),'🪴'.repeat(80),'80 Unicode characters fit even when encoded as surrogate pairs in JS');
  for(const invalid of [null,'',whitespace,'a'.repeat(81),'🪴'.repeat(81)]){
    await assert.rejects(()=>rename(invalid),/invalid_profile/);
  }
  assert.equal(await rename(unicodeName),unicodeName);
  assert.equal(await rename(unicodeName),unicodeName,'retrying a name replacement has no additional effect');

  await db.exec('reset role');
  const after=(await db.query<ProfileRow>('select * from public.profiles order by id')).rows;
  assert.deepEqual(after,before.map(p=>p.id===a?{...p,display_name:unicodeName}:p),
    'only the caller display name changes; IDs, creation dates and other users remain intact');
  assert.deepEqual((await db.query('select * from auth.users order by id')).rows,authBefore,
    'changing a Pact name does not modify Google identity, email or authentication metadata');

  for(const id of ['',unverified,otherProvider,'00000000-0000-4000-8000-000000000099']){
    await as(id);
    await assert.rejects(()=>rename('Not allowed'),/unauthenticated/);
  }
  await db.exec('reset role; set role anon');
  await assert.rejects(()=>rename('Anonymous'),/permission denied/);
  await db.exec('reset role');
  const grants=(await db.query<{schema:string;definer:boolean;config:string[];anon:boolean;authenticated:boolean}>(`
    select n.nspname as schema,p.prosecdef as definer,p.proconfig as config,
      has_function_privilege('anon',p.oid,'execute') as anon,
      has_function_privilege('authenticated',p.oid,'execute') as authenticated
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.proname='update_profile' order by n.nspname`)).rows;
  assert.deepEqual(grants,[
    {schema:'private',definer:true,config:['search_path=""'],anon:false,authenticated:true},
    {schema:'public',definer:false,config:['search_path=""'],anon:false,authenticated:true}
  ],'only the private implementation has elevated privileges, with a pinned search path and narrow grants');
});
