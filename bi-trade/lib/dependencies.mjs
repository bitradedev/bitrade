import {createRequire} from 'node:module';
const require=createRequire(new URL('../../paper-terminal/package.json',import.meta.url));
export const viem=require('viem');
export const accounts=require('viem/accounts');
export const chains=require('viem/chains');
