import type {Market,Chain} from '../shared/domain.js';
export function priceRefreshTargets(markets:Market[],chain:Chain,visible:string|undefined,recent:ReadonlyMap<string,number>,now:number):Market[]{
 const rows=markets.filter(m=>m.chain===chain&&m.decimals!==null&&(chain!=='robinhood'||!['pons','pons-v1'].includes(m.platform)||m.address===visible)),oldest=rows.slice().sort((a,b)=>a.block-b.block);
 const focus=rows.filter(m=>m.address===visible||now-(recent.get(m.id)??-Infinity)<15000).sort((a,b)=>Number(b.address===visible)-Number(a.address===visible)||(recent.get(b.id)??-Infinity)-(recent.get(a.id)??-Infinity))[0];
 // Real read timestamps retain ownership of price freshness.
 return [...(focus?[focus]:[]),...oldest.filter(m=>m!==focus)].slice(0,2);
}
