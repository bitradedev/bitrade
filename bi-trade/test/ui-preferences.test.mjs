import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
const web=resolve(dirname(fileURLToPath(import.meta.url)),'../web');
function preferences(values={}){
 const readKeys=[],root={dataset:{}},context={window:{},localStorage:{getItem:key=>{readKeys.push(key);return values[key]??null;}},document:{documentElement:root,readyState:'loading',addEventListener(){}}};vm.createContext(context);
 for(const file of ['ui-catalog.js','ui-preferences.js'])vm.runInContext(readFileSync(resolve(web,file),'utf8'),context);
 return {ui:context.window.BiUI,root,readKeys,catalog:context.window.BI_UI_EN};
}
test('appearance preferences default to the approved light palette and accept only supported values',()=>{
 const first=preferences();assert.equal(first.root.dataset.theme,'light');assert.equal(first.root.lang,'zh-CN');assert.deepEqual(first.readKeys,['bi-ui-theme','bi-ui-language']);
 const chosen=preferences({'bi-ui-theme':'dark','bi-ui-language':'en'});assert.equal(chosen.root.dataset.theme,'dark');assert.equal(chosen.root.lang,'en');assert.equal(chosen.ui.locale,'en-US');
 const invalid=preferences({'bi-ui-theme':'injected-value','bi-ui-language':'<script>'});assert.equal(invalid.root.dataset.theme,'light');assert.equal(invalid.ui.language,'zh');
});
test('English UI translation preserves order actions, asset addresses, amounts, and HTML structure',()=>{
 const {ui}=preferences({'bi-ui-language':'en'}),address='0x1111111111111111111111111111111111111111';
 const html='<button data-action="demo-sell" data-id="agent-1" data-token="'+address+'" data-amount="123">模拟卖出</button>';
 assert.equal(ui.t(html),html.replace('模拟卖出','Paper sell'));
 assert.equal(ui.t('<select aria-label="交易类型"><option value="paper">模拟交易</option></select>'),'<select aria-label="Trade type"><option value="paper">Paper trades</option></select>');
 assert.equal(ui.t('钱包地址">⧉</button>'),' wallet address">⧉</button>');
 assert.equal(ui.t('已实现盈亏</span><b class="'),'Realized profit / loss</span><b class="');
});
test('user-authored names, strategies, and unrecognized decision summaries stay in their original language',()=>{
 const {ui}=preferences({'bi-ui-language':'en'}),user={source:'user',name:'BI 趋势猎手',strategy:{name:'趋势动量',description:'我的自定义策略，不要改写。'}};
 assert.equal(ui.agentName(user),user.name);assert.equal(ui.strategyName(user),user.strategy.name);assert.equal(ui.strategyDescription(user),user.strategy.description);
 const builtin={...user,source:'builtin'};assert.equal(ui.agentName(builtin),'BI Trend Hunter');assert.equal(ui.strategyName(builtin),'Trend momentum');
 assert.equal(ui.systemMessage('这是 Agent 原始决策：等待下一根 K 线。'),'这是 Agent 原始决策：等待下一根 K 线。');
 assert.equal(ui.systemMessage('等待站点管理员配置 OpenAI API 密钥；尚未启动 AI 决策。'),'Waiting for the administrator to configure the OpenAI API key. AI decisions have not started.');
});
