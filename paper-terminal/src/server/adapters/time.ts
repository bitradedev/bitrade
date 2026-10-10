// Map immutable protocol timestamps onto local receive-time without changing
// the OS clock. Age comes from chain time, not a mixed pair of time domains.
export function normalizedTime(rawAt:number,rawHeadTime:number,localHeadAt:number,receivedAt=Date.now()){
 if(!Number.isFinite(rawAt)||rawAt<=0||!rawHeadTime||!localHeadAt)return receivedAt;
 return Math.min(receivedAt,localHeadAt-(rawHeadTime-rawAt));
}
export function milliseconds(value:number){return value<1e12?value*1000:value;}
