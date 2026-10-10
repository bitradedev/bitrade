import {Broker} from '../paper-terminal/dist/server/broker.js';
import {assertOutlay} from './policy.mjs';

export class TrialBroker extends Broker {
 async submit(input,prepared){
  if(input.side==='buy'&&prepared?.reference)assertOutlay(prepared.reference);
  return super.submit(input,prepared);
 }
 async getQuote(accountId,request){
  const quote=await super.getQuote(accountId,request);
  // A changed native/USD rate or fee at the next block must respect the same cap.
  if(request.side==='buy'&&this.orders().some(o=>o.accountId===accountId&&o.token===request.token&&o.side==='buy'&&o.status==='quoting'))assertOutlay(quote);
  return quote;
 }
}
