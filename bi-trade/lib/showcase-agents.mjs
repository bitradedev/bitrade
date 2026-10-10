import {ShowcaseAgents as Core} from './showcase-agents-core.mjs';
import {TokenRiskGuard} from './token-risk.mjs';
export {SHOWCASE_PROFILES} from './showcase-agents-core.mjs';
export class ShowcaseAgents extends Core{constructor(options){super({...options,riskGuard:options.riskGuard??new TokenRiskGuard(options.store)});}}
