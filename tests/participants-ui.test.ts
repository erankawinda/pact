import test from 'node:test';
import assert from 'node:assert/strict';
import {actorNames,hasUnjoinedBalance,isOrganiser,ownMembership,participantPhotoId} from '../src/participants.ts';
import type {Member,Snapshot} from '../src/api.ts';
const account='11111111-1111-4111-8111-111111111111';
const ledger='22222222-2222-4222-8222-222222222222';
const waiting='33333333-3333-4333-8333-333333333333';
const joined:Member={id:ledger,auth_user_id:account,name:'Alex',role:'organiser',status:'active',can_select:true,can_repay:true,require_payment_approval:false};
const invited:Member={id:waiting,auth_user_id:null,name:'Blake',role:'member',status:'invited',can_select:true,can_repay:false,require_payment_approval:false};
const snapshot=(members:Member[],balances:Snapshot['balances']=[])=>({members,balances} as Snapshot);

test('a claimed place keeps its ledger identity while account actions and photos use Auth identity',()=>{
 const state=snapshot([joined,invited]);
 assert.equal(ownMembership(state,account)?.id,ledger);
 assert.equal(isOrganiser(state,account),true);
 assert.deepEqual(actorNames(state),{[account]:'Alex'});
 assert.equal(participantPhotoId(joined),account);
 assert.equal(participantPhotoId(invited),undefined);
 assert.equal(participantPhotoId({...joined,status:'revoked'}),undefined);
});

test('a pending ledger ID cannot impersonate an authenticated member or organiser',()=>{
 const pending={...invited,id:account,role:'organiser' as const};
 const state=snapshot([pending]);
 assert.equal(ownMembership(state,account),undefined);
 assert.equal(isOrganiser(state,account),false);
 assert.deepEqual(actorNames(state),{});
});

test('any nonzero unjoined balance pauses settlement suggestions, including expired invitations',()=>{
 assert.equal(hasUnjoinedBalance(snapshot([joined,invited],[{user_id:ledger,cents:1250},{user_id:waiting,cents:-1250}])),true);
 assert.equal(hasUnjoinedBalance(snapshot([joined,{...invited,status:'expired',can_select:false}],[{user_id:ledger,cents:1250},{user_id:waiting,cents:-1250}])),true);
 assert.equal(hasUnjoinedBalance(snapshot([joined,invited],[{user_id:ledger,cents:0},{user_id:waiting,cents:0}])),false);
 assert.equal(hasUnjoinedBalance(snapshot([joined,{...invited,auth_user_id:waiting,status:'active',can_repay:true}],[{user_id:ledger,cents:1250},{user_id:waiting,cents:-1250}])),false);
});
