import {type TestContext} from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {createECDH,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

// Minimal managed-platform tables for testing the real application migrations.
// This models database policies only: it is not the Supabase Storage HTTP API.
export async function privacyFixture(t:TestContext){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create schema storage;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{"providers":["google"]}',banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
 create table storage.buckets(id text primary key,name text not null,public boolean default false,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,owner uuid,owner_id text,metadata jsonb default '{}',created_at timestamptz default now(),updated_at timestamptz default now(),unique(bucket_id,name));
 alter table storage.objects enable row level security;
 grant usage on schema storage to authenticated,service_role;
 grant select,insert,update,delete on storage.objects to authenticated,service_role;
 create function storage.foldername(name text) returns text[] language sql immutable as $$select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1]$$;`);
 for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile('supabase/migrations/'+file,'utf8'));
 const a=randomUUID(),b=randomUUID(),c=randomUUID(),d=randomUUID(),outsider=randomUUID(),unverified=randomUUID();
 const users=[a,b,c,d,outsider,unverified],sessions=new Map<string,string>();
 for(const [i,id] of users.entries()){
  const session=randomUUID();sessions.set(id,session);
  await db.query("insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,case when $3 then now() else null end,$4)",[id,`person${i}@example.test`,id!==unverified,JSON.stringify({full_name:['Alex','Blake','Casey','Devin','Outside','Unverified'][i]})]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[session,id]);
 }
 async function as(actor:string,session:string|null=sessions.get(actor)??null){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[actor,JSON.stringify({sub:actor,session_id:session,role:'authenticated'})]);await db.exec('set role authenticated');}
 async function admin(){await db.exec('reset role');}
 async function service(){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false),set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'service_role'})]);await db.exec('set role service_role');}
 async function rpc<T=any>(name:string,args:unknown[]=[]):Promise<T>{if(!/^[a-z_]+$/.test(name))throw new Error('Invalid fixture RPC name');return (await db.query<{value:T}>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) as value`,args)).rows[0].value;}
 async function call<T=any>(actor:string,name:string,args:unknown[]=[]):Promise<T>{await as(actor);return rpc<T>(name,args);}
 async function worker<T=any>(name:string,args:unknown[]=[]):Promise<T>{await service();return rpc<T>(name,args);}
 async function rows<T=any>(sql:string,args:unknown[]=[]):Promise<T[]>{await admin();return (await db.query<T>(sql,args)).rows;}
 const home=await call<string>(a,'create_space',['Home','household',null,[],randomUUID()]);
 for(const [i,id] of users.entries()){if(![b,c,d].includes(id))continue;const invite=await call(a,'create_invitation',[home,`person${i}@example.test`]);await call(id,'accept_invitation',[invite]);}
 const trip=await call<string>(a,'create_space',['Weekend','trip',home,[b],randomUUID()]);
 const publicKey=createECDH('prime256v1').generateKeys().toString('base64url'),auth=Buffer.alloc(16,7).toString('base64url');
 async function register(actor:string,device=randomUUID(),binding=randomUUID(),endpoint=`https://fcm.googleapis.com/fcm/send/${randomUUID()}`){await call(actor,'register_push_subscription',[device,endpoint,publicKey,auth,binding]);return {id:device,binding,endpoint,actor};}
 function expenseInput({payer=a,people=[a,b],amount=1000,group=home,request=randomUUID()}: {payer?:string;people?:string[];amount?:number;group?:string;request?:string}={}){return {p_group:group,p_request:request,p_description:'Private fixture purchase',p_amount:amount,p_payer:payer,p_people:people,p_mode:'equal',p_exact:null,p_date:'2026-10-11',p_category:'groceries',p_note:'Synthetic private note'};}
 const save=(actor:string,input:ReturnType<typeof expenseInput>,replaces:string|null=null,version:number|null=null)=>call<string>(actor,'save_expense',[JSON.stringify(input),replaces,version,replaces?'Correct fixture participants':'',null]);
 return {db,a,b,c,d,outsider,unverified,users,sessions,home,trip,as,admin,service,rpc,call,worker,rows,register,publicKey,auth,expenseInput,save};
}
export type PrivacyFixture=Awaited<ReturnType<typeof privacyFixture>>;
