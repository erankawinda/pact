import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const manifestPath='scripts/reviewed-public-assets.json';
const email=/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const credential=/(?:sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}|GOCSPX-[A-Za-z0-9_-]{15,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----)/g;
const jwt=/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g;
const hostedProject=/\b(?:https?|wss):\/\/[a-z0-9]{20}\.supabase\.co\b/gi;
const configuredSite=/\bhttps?:\/\/(?!YOUR_PROJECT\.|example\.)[a-z0-9-]+\.pages\.dev\b/gi;
const privateConnection=/\bpostgres(?:ql)?:\/\/[^\s'"`]+:[^\s'"`]+@/gi;
const forbiddenPath=/(?:^|\/)(?:node_modules|dist|backups|exports|private|\.wrangler|\.aws)(?:\/|$)|^supabase\/\.temp\/|^(?:qa\/artifacts|test-results|playwright-report)\/|(?:^|\/)\.env(?:\.[^/]*)?$|\.(?:zip|csv|dump|backup|pem|key|p12|pfx|sqlite3?|db|heic|heif|jpe?g)$/i;

// These exact, already reviewed placeholders are not credentials or contacts.
// Never add a real value to an exception list to make this check pass.
function fixtureCredential(path,value){
 return value==='sb_publishable_'+'fixture_only'&&/^qa\/(?:browser|privacy-browser|notifications-browser)\.mjs$/.test(path)
  ||value==='sb_secret_'+'synthetic_test_only'&&path==='supabase/functions/dispatch-notifications/dispatch.test.ts';
}
function fixtureEmail(path,value){
 const domain=value.split('@')[1].toLowerCase();
 return /^(?:[^.]+\.)*example\.(?:com|net|org|test)$/.test(domain)||domain.endsWith('.test')||domain.endsWith('.invalid')
  ||path==='src/GroupForms.tsx'&&value==='name'+'@gmail.com'
  ||['tests/notifications.test.ts','supabase/functions/dispatch-notifications/dispatch.test.ts'].includes(path)&&value==='user'+'@fcm.googleapis.com';
}
export function inspectPublicFile(path,bytes,reviewedAssets={}){
 const issues=[];
 const issue=(rule,line)=>issues.push({path,rule,...(line?{line}:{} )});
 if(path!=='.env.example'&&forbiddenPath.test(path))issue('private artifact or local configuration');
 const approved=reviewedAssets[path];
 if(approved){
  if(!/^(?:docs\/images|public\/icons)\/[^/]+\.png$/.test(path))issue('review manifest permits only public PNG images');
  if(!/^[a-f0-9]{64}$/.test(approved)||createHash('sha256').update(bytes).digest('hex')!==approved)issue('public image changed; visual privacy review required');
  if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))issue('reviewed public image must be PNG');
  else{
   let at=8,ended=false;
   while(at+12<=bytes.length){
    const size=bytes.readUInt32BE(at),kind=bytes.toString('ascii',at+4,at+8);
    if(at+12+size>bytes.length)break;
    if(['eXIf','tEXt','iTXt','zTXt'].includes(kind))issue('public image contains embedded metadata');
    at+=size+12;if(kind==='IEND'){ended=true;break;}
   }
   if(!ended||at!==bytes.length)issue('public PNG has invalid or trailing data');
  }
  return issues;
 }
 let text;
 try{if(bytes.includes(0))throw new Error('binary');text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
 catch{issue('unreviewed binary asset');return issues;}
 function find(pattern,rule,allowed=()=>false){
  for(const match of text.matchAll(pattern))if(!allowed(match[0]))issue(rule,text.slice(0,match.index).split('\n').length);
 }
 find(credential,'credential or configured publishable key',value=>fixtureCredential(path,value));
 find(jwt,'literal JWT');
 find(email,'non-example email address',value=>fixtureEmail(path,value));
 find(hostedProject,'configured hosted project');
 find(configuredSite,'configured deployment URL');
 find(privateConnection,'database connection with credentials');
 return issues;
}
export function formatFindings(findings){
 // Values and source snippets are deliberately excluded from terminal/CI logs.
 return findings.map(({path,line,rule,snapshot})=>`${path.replace(email,'[email]').replace(credential,'[credential]')}${line?':'+line:''}${snapshot?' ['+snapshot+']':''}: ${rule}`).join('\n');
}
export function checkRepository(cwd=process.cwd()){
 const git=args=>execFileSync('git',args,{cwd,maxBuffer:16*1024*1024});
 const paths=[...new Set(git(['ls-files','--cached','--others','--exclude-standard','-z']).toString().split('\0').filter(Boolean))];
 const tracked=new Set(git(['ls-files','--cached','-z']).toString().split('\0').filter(Boolean));
 const assets=JSON.parse(readFileSync(resolve(cwd,manifestPath),'utf8'));
 const indexAssets=tracked.has(manifestPath)?JSON.parse(git(['show',':'+manifestPath]).toString()):assets;
 const findings=[];
 for(const path of paths){
  let bytes;
  try{
   const stat=lstatSync(resolve(cwd,path));
   if(stat.isSymbolicLink()){findings.push({path,rule:'symlink requires explicit public-file review'});continue;}
   if(stat.isFile()){bytes=readFileSync(resolve(cwd,path));findings.push(...inspectPublicFile(path,bytes,assets).map(issue=>({...issue,snapshot:'working tree'})));}
  }catch(error){if(error.code!=='ENOENT')throw error;}
  // A staged secret must not be hidden by subsequently clearing the working file.
  if(tracked.has(path)){
   const staged=git(['show',':'+path]);
   if(!bytes?.equals(staged)||assets[path]!==indexAssets[path])findings.push(...inspectPublicFile(path,staged,indexAssets).map(issue=>({...issue,snapshot:'index'})));
  }
 }
 for(const path of Object.keys(assets))if(!paths.includes(path))findings.push({path,rule:'reviewed image manifest points to a missing public file'});
 return {files:paths.length,findings};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const result=checkRepository();
  if(result.findings.length){console.error('Public privacy check failed. Remove private material; do not add it to an exception list.\n'+formatFindings(result.findings));process.exitCode=1;}
  else console.log(`Public privacy check passed for ${result.files} source/assets files and their staged versions. This does not replace visual review or history scanning.`);
 }catch{console.error('Public privacy check could not complete. Check Git and the reviewed public asset manifest. No file contents were logged.');process.exitCode=1;}
}
