import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseMoney,splitEqual,exactShares} from '../src/money.ts';
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
