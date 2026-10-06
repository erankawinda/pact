import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseMoney,splitEqual,exactShares,planCustomSplit} from '../src/money.ts';
test('money is parsed exactly, with bounded cents',()=>{
  assert.equal(parseMoney('0.29'),29); assert.equal(parseMoney('1000000.00'),100000000);
  for(const bad of ['-1','1.001','Infinity','1e3','','0','1000000.01']) assert.throws(()=>parseMoney(bad));
});
test('equal shares are deterministic and preserve the total for any subset',()=>{
  assert.deepEqual(splitEqual(10000,['c','a','b']),{a:3334,b:3333,c:3333});
  assert.deepEqual(splitEqual(1,['b','a']),{a:1,b:0});
  assert.deepEqual(splitEqual(2500,['someone-else']),{'someone-else':2500});
  assert.throws(()=>splitEqual(100,[])); assert.throws(()=>splitEqual(100,['a','a']));
  for(let amount=1;amount<1000;amount+=7) for(let count=1;count<=12;count++) {
    const parts=Object.values(splitEqual(amount,Array.from({length:count},(_,i)=>String(i))));
    assert.equal(parts.reduce((a,b)=>a+b,0),amount); assert.ok(Math.max(...parts)-Math.min(...parts)<=1);
  }
});
test('exact splits require every selected amount and exact total',()=>{
  assert.deepEqual(exactShares(9000,['a','b'],{a:'20',b:'70'}),{a:2000,b:7000});
  assert.throws(()=>exactShares(9000,['a','b'],{a:'20',b:'69'}));
  assert.throws(()=>exactShares(9000,['a','b'],{a:'90'}));
});

test('one unknown custom share gets the remainder without changing known values',()=>{
  const inputs={a:'20',b:'30',c:'',excluded:'999'};
  const split=planCustomSplit(10000,['a','b','c'],inputs);
  assert.equal(split.issue,null);
  assert.deepEqual(split.shares,{a:2000,b:3000,c:5000});
  assert.deepEqual(split.autoIds,['c']);
  assert.deepEqual(inputs,{a:'20',b:'30',c:'',excluded:'999'});
  assert.equal(planCustomSplit(12000,['a','b','c'],inputs).shares.c,7000);
  assert.equal(planCustomSplit(10000,['a','b','c'],{...inputs,a:'25'}).shares.c,4500);
  assert.equal(planCustomSplit(10000,['a','b','c'],{...inputs,b:'0'}).shares.b,0);
  assert.deepEqual(planCustomSplit(1,['a'],{}).shares,{a:1});
});

test('several unknown shares need consent, use deterministic cents and allow zero remainder',()=>{
  const pending=planCustomSplit(10001,['c','a','b'],{a:'20'});
  assert.ok(pending.issue);
  assert.equal(pending.canSplitRemaining,true);
  assert.deepEqual(pending.autoIds,[]);
  const split=planCustomSplit(10001,['c','a','b'],{a:'20'},true);
  assert.equal(split.issue,null);
  assert.deepEqual(split.shares,{a:2000,b:4001,c:4000});
  assert.deepEqual(planCustomSplit(10001,['a','b','c'],{a:'20'},true).shares,split.shares);
  assert.deepEqual(planCustomSplit(100,['a','b','c'],{a:'1'},true).shares,{a:100,b:0,c:0});
  assert.deepEqual(planCustomSplit(100,['a','b'],{a:'1'}).shares,{a:100,b:0});
  for(let total=1;total<300;total+=7)for(let count=2;count<=5;count++){
    const ids=Array.from({length:count},(_,i)=>String(i));
    const known=Math.floor(total/3);
    const result=planCustomSplit(total,ids,{'0':(known/100).toFixed(2)},true);
    assert.equal(result.issue,null);
    assert.equal(result.shares['0'],known);
    const values=Object.values(result.shares);
    assert.equal(values.reduce((a,b)=>a+b,0),total);
    assert.ok(values.every(n=>Number.isSafeInteger(n)&&n>=0));
    const automatic=result.autoIds.map(id=>result.shares[id]);
    assert.ok(Math.max(...automatic)-Math.min(...automatic)<=1);
  }
});

test('custom splits block invalid, excess and incomplete amounts without guessing',()=>{
  for(const bad of ['-1','1.001','1e3','foo','1000000.01']){
    const split=planCustomSplit(10000,['a','b'],{a:bad},true);
    assert.ok(split.issue);
    assert.deepEqual(split.invalidIds,['a']);
    assert.deepEqual(split.autoIds,[]);
  }
  const over=planCustomSplit(10000,['a','b','c'],{a:'80',b:'30'},true);
  assert.match(over.issue!,/\$10.00 over/);
  assert.equal(over.shares.c,undefined);
  assert.deepEqual(over.autoIds,[]);
  assert.match(planCustomSplit(10000,['a','b'],{a:'20',b:'30'}).issue!,/\$50.00 left/);
  assert.ok(planCustomSplit(10000,[],{}).issue);
  assert.ok(planCustomSplit(10000,['a','a'],{}).issue);
  for(const total of [null,0,-1,NaN,1.5,100000001])assert.ok(planCustomSplit(total,['a'],{}).issue);
  assert.deepEqual(planCustomSplit(10000,['a','b'],{a:'  '},true).shares,{a:5000,b:5000});
});

test('the total is suggested only from all selected valid explicit shares',()=>{
  const inputs={a:'20',b:'30',c:'58',d:'30',excluded:'500'};
  assert.equal(planCustomSplit(null,['a','b','c','d'],inputs).suggestedTotal,13800);
  assert.equal(planCustomSplit(null,['a','b','c','d'],{...inputs,c:''}).suggestedTotal,null);
  assert.equal(planCustomSplit(null,['a','b'],{a:'0',b:'0'}).suggestedTotal,null);
  assert.equal(planCustomSplit(null,['a','b'],{a:'1000000',b:'.01'}).suggestedTotal,null);
  assert.equal(planCustomSplit(null,['a','b'],{a:'1000000',b:'0'}).suggestedTotal,100000000);
});

test('repayment suggestions conserve every member balance, including large cent values',async()=>{
 const {settlementSuggestions}=await import('../src/money.ts');
 for(let i=1;i<150;i++){
  const values=[i*101,-i*73,i%7,-i*28-i%7];
  const balances=values.map((cents,n)=>({user_id:String(n),cents}));
  const suggestions=settlementSuggestions(balances);
  const after=Object.fromEntries(balances.map(b=>[b.user_id,b.cents]));
  for(const s of suggestions){assert.ok(Number.isInteger(s.cents)&&s.cents>0);assert.notEqual(s.from,s.to);after[s.from]+=s.cents;after[s.to]-=s.cents;}
  assert.deepEqual(Object.values(after),[0,0,0,0]);
 }
 assert.throws(()=>settlementSuggestions([{user_id:'a',cents:5}]),/do not add up/);
 assert.throws(()=>settlementSuggestions([{user_id:'a',cents:NaN}]),/do not add up/);
});
