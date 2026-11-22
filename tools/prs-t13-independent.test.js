'use strict';
// T13 independent probes: public GH runner, pane keys and rail seams. No real writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPrsClient, setGhRunner } = require('../lib/gh-prs');
const { createPrsView } = require('../lib/prs-view');
const { createIssuesView } = require('../lib/issues-view');
const { createIssuesSection } = require('../lib/issues-section');
const { createPrsRailStore } = require('../lib/prs-rail-store');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const tick = () => new Promise(setImmediate);
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const ok = (doc) => ({ status: 0, stdout: JSON.stringify(doc) });
const prNum = 64;
const methods = { merge: true, rebase: true };
const allCaps = { canClosePullRequests: true, canMerge: true, canEditLabels: true, canCreateLabels: true, canEditAssignees: true, canEditLinkedIssues: true };
const writeCalls = [
  ['close', (c, o) => c.closePullRequest(prNum, o)],
  ['merge', (c, o) => c.mergePullRequest(prNum, { method: 'merge', subject: 'subject', body: '' }, o)],
  ['labels', (c, o) => c.editLabels(prNum, { add: ['support'] }, o)],
  ['assignees', (c, o) => c.editAssignees(prNum, { add: ['pat'] }, o)],
  ['linked', (c, o) => c.editLinkedIssues(prNum, { add: [915] }, o)],
  ['create label', (c, o) => c.createLabel({ name: 'support' }, o)],
];
function client(t, fixture = {}) {
  const calls = [], writes = [];
  const run = async (_bin, argv, opts) => {
    const env = opts.env || {};
    const target = env.GH_REPO || (fixture.defaultRepo && fixture.defaultRepo()) || 'github.com/amber/widget';
    const call = { argv, target, host: env.GH_HOST };
    calls.push(call);
    switch (argv.slice(0, 2).join(' ')) {
      case 'repo view': return ok({ nameWithOwner: target.split('/').slice(-2).join('/') });
      case 'api graphql': {
        assert.match(argv[3], /^query=query\b/, 'write GraphQL must never fall through as a read');
        const pullRequest = fixture.gone ? null : {
          ...(fixture.noDraft ? {} : { isDraft: false }),
          ...(fixture.noState ? {} : { state: fixture.state || 'OPEN' }),
          closingIssuesReferences: { nodes: [] },
        };
        fixture.onRole?.(call);
        return ok({ data: { repository: { viewerPermission: fixture.role || 'WRITE', mergeCommitAllowed: true, pullRequest }, viewer: { login: 'pat' } } });
      }
      case 'pr view': return ok({ body: fixture.body ?? 'Summary\n' });
      default: writes.push(call); return ok({});
    }
  };
  setGhRunner(run);
  t.after(() => setGhRunner(null));
  return { c: createPrsClient(fixture.options), run, writes, calls };
}
const opts = {scope:'github.com/amber/widget'};
// D27 replaced the Markdown reader: a line the panel wrote carries this marker
// and is the only line a removal may delete, so every removal fixture below
// names the panel's own declaration.
const MARK = '<!-- odd-worktree:linked -->';
const UNREADABLE = 'the pull request body ends inside an unclosed code fence or comment';
async function removeBody(t, prefix, eol = '\n', fixture = {}) {
  const expected = `${prefix}${eol}${eol}footer${eol}`;
  const body = `${prefix}${eol}${eol}Closes #915 ${MARK}${eol}footer${eol}`;
  const { c, writes } = client(t, { ...fixture, body });
  const result = await c.editLinkedIssues(prNum, { remove: [915] }, opts);
  assert.equal(result.ok, true);
  assert.deepEqual(writes.map(w => w.argv), [['pr', 'edit', '64', '--body', expected]]);
}

test('D4: fence character/length and unrelated bytes', t => removeBody(t, '````md\n```\n~~~\nCloses #915\n````'));
for (const [name, lines, eol] of [
  ['unordered', ['- item', '    ```txt', '    Closes #915', '    ```']],
  ['ordered', ['10. item', '    ~~~txt', '    Closes #915', '    ~~~']],
  ['deep mixed', ['- top', '  10. inner', '      - third', '        ```txt', '        Closes #915', '        ```']],
  ['tab-indented list continuation', ['- item', '\t```txt', '\tCloses #915', '\t```']],
  ['blockquote', ['> intro', '>', '> ```txt', '> Closes #915', '> ```']],
  ['CRLF list', ['10. item', '    ```txt', '    Closes #915', '    ```'], '\r\n'],
]) test(`D16: ${name}, remove the panel's own declaration only`, t => removeBody(t, lines.join(eol || '\n'), eol));
for (const remove of [[], [915]]) test(`D16: open to EOF, add + remove=${remove.length}`, async t => {
  const body = 'Closes #915\r\n\r\n````text\r\nCloses #915';
  const {c,writes} = client(t,{body});
  assert.deepEqual(await c.editLinkedIssues(prNum,{add:[916],remove},opts), {ok:false,error:UNREADABLE});
  assert.deepEqual(writes, []);
});
test('D16: open to EOF is refused, so a removal never edits half a body', async t => {
  // D27: the run total is odd, so the body cannot be read safely and NOTHING is
  // written — the previous rule removed the real line and left the fence open.
  const body = 'Closes #915\r\n\r\n````text\r\nCloses #915';
  const {c,writes} = client(t,{body});
  assert.deepEqual(await c.editLinkedIssues(prNum,{remove:[915]},opts),{ok:false,error:UNREADABLE});
  assert.deepEqual(writes, []);
});
test('D16: fence directly after a list marker', t => removeBody(t, '- ```text\n  Closes #915\n  ```'));
test('NEW: a fence structure with three runs is refused, never resumed', async t => {
  const {c,writes} = client(t,{body:`- item\n  \`\`\`txt\n      \`\`\`\n  Closes #915 ${MARK}\n  \`\`\`\n`});
  assert.deepEqual(await c.editLinkedIssues(prNum,{remove:[915]},opts),{ok:false,error:UNREADABLE});
  assert.deepEqual(writes, []);
});
test('NEW: an unclosed list fence is refused; the body is never half-read', async t => {
  const prefix = '10. item\n    ```txt\n    example\n';
  const {c,writes} = client(t,{body:`${prefix}\nCloses #915 ${MARK}\n`});
  assert.deepEqual(await c.editLinkedIssues(prNum,{remove:[915]},opts),{ok:false,error:UNREADABLE});
  assert.deepEqual(writes, []);
});

for (const [name, call] of writeCalls) test(`D19: ${name} uses enterprise GH_REPO for every child`, async t => {
  const host = 'github.company.example/amber/widget';
  const { c, calls, writes } = client(t);
  assert.equal((await call(c, {env: {GH_REPO:host}})).ok, true);
  assert.equal(writes.length, 1);
  assert.ok(calls.some(x => x.argv[1] === 'graphql'));
  assert.deepEqual([...new Set(calls.map(x => x.target))], [host]);
});
test('D13: checkout resolver runs once; every read/write uses the first pin', async t => {
  let resolutions = 0;
  const {c,writes,calls}=client(t,{options:{issues:{checkoutRepoScope:async () => ({ok:true,identity:++resolutions===1?'github.com/amber/widget':'github.com/copper/widget'})}}});
  assert.equal((await c.closePullRequest(prNum,{cwd:process.cwd()})).ok,true);
  assert.equal(resolutions,1);
  assert.equal(writes.length,1);
  assert.deepEqual([...new Set(calls.map(x=>x.target))],['github.com/amber/widget']);
});
test('NEW: ambient repository chosen by gh cannot change between authorization and close', async t => {
  let current = 'github.com/amber/widget';
  const {c,writes,calls}=client(t,{defaultRepo:()=>current,onRole:()=>{current='github.com/copper/widget';}});
  const result=await c.closePullRequest(prNum);
  assert.equal(calls.find(x=>x.argv[1]==='graphql').target,'github.com/amber/widget');
  if (result.ok) assert.equal(writes[0].target,'github.com/amber/widget');
  else assert.deepEqual(writes,[]);
});
test('D2 and D14: READ refuses all six gated writes, WRITE permits label creation', async t => {
  const fixture={role:'READ'};
  const {c,writes}=client(t,fixture);
  for (const [name,call] of writeCalls) assert.match((await call(c,opts)).error,/permission/i,name);
  assert.deepEqual(writes,[]);
  fixture.role='WRITE';
  assert.equal((await c.createLabel({name:'support'},opts)).ok,true);
  assert.deepEqual(writes.map(x=>x.argv),[['label','create','support']]);
});
test('D5: missing draft, blank subject and explicitly blank body', async t => {
  const f={noDraft:true}; const {c,writes}=client(t,f);
  assert.deepEqual(await c.mergePullRequest(prNum,{method:'merge'},opts),{ok:false,error:'pull request metadata is unavailable: the draft state is missing'});
  f.noDraft=false;
  assert.deepEqual(await c.mergePullRequest(prNum,{method:'merge',subject:''},opts),{ok:false,error:'the merge commit message must not be empty'});
  assert.deepEqual(writes,[]);
  assert.equal((await writeCalls[1][1](c,opts)).ok,true);
  assert.deepEqual(writes[0].argv,['pr','merge','64','--merge','--subject','subject','--body','']);
});
const unavailable = {close:'closed',merge:'merged',linked:'its linked issues cannot be edited'};
const notOpen = name => `pull request #64 is not open; ${name==='linked'?unavailable.linked:`it cannot be ${unavailable[name]}`}`;
for (const state of ['MERGED','CLOSED','gone','missing state']) test(`D20 client: ${state} cannot close, merge or edit links`, async t => {
  const {c,writes}=client(t,{state,gone:state==='gone',noState:state==='missing state'});
  for (const [name,call] of writeCalls.filter(([n])=>n in unavailable)) {
    const error=state==='gone'&&name==='merge'?'pull request metadata is unavailable':notOpen(name);
    assert.deepEqual(await call(c,opts),{ok:false,error},name);
  }
  assert.deepEqual(writes,[]);
});

const row = (number, state='open') => ({number,title:`Ticket-${number}`,author:'someone-else',state});
const detail = (number, props = {}) => ({ok:true,pullRequest:{...row(number),body:'Summary',isDraft:false,mergeMethods:methods,mergeDefaults:{merge:{subject:'Subject',body:'Details'}},linkedIssues:[915],...props},permissions:props.permissions||allCaps});
const page = rows => ({ok:true,rows,hasMore:false,totalCount:rows.length});
const keys = (v,...inputs)=>inputs.forEach(x=>v.handleInput(x));
const display = (v,width=130)=>v.render(width).join('\n');
async function panel(extra={}) {
  const hold=deferred(), writes=[], reads=[], others=Array.from({length:30},(_,i)=>row(100+i));
  let mine=0;
  let read=(n)=>detail(n);
  const actions=Object.fromEntries(['close','merge','commentPullRequest','editLinkedIssues','editLabels','editAssignees'].map(name=>[name,(...args)=>{writes.push([name,...args]);return {ok:true};}]));
  const v=createPrsView({rowsAvailable:()=>19,
    loadPullRequestPage:({bucketId})=>bucketId==='mine'&&++mine===2?hold.promise:page([row(prNum),...others]),
    loadPullRequest:(n,opt)=>{reads.push([n,opt]);return read(n,opt);},
    labels:[{name:'support'}], loadAssignees:()=>({ok:true,users:[{login:'pat'}]}),actions,...extra});
  await tick();
  return {v,hold,writes,reads,others,changeRead:fn=>{read=fn;}};
}
const workflow = {
  close:{enter:['x'],save:['enter'],title:'Confirm close #64',seam:'close',fail:/pull requests cannot be closed: this repository permission is missing/},
  merge:{enter:['m'],save:['ctrl+s'],title:'Confirm merge #64',seam:'merge',fail:/pull requests cannot be merged: this repository permission is missing/},
  comment:{enter:['c','h','i'],save:['ctrl+s'],title:'Comment on #64',seam:'commentPullRequest'},
  linked:{enter:['i','space'],save:['ctrl+s'],title:'Linked issues',seam:'editLinkedIssues',fail:/linked issues cannot be edited: this repository permission is missing/},
};
for (const [name,w] of Object.entries(workflow)) for (const present of [true,false]) test(`D${name==='comment'?18:name==='linked'?20:17}: ${name}, held reload ${present?'moves':'removes'} target`,async()=>{
  const {v,hold,writes,others}=await panel();
  keys(v,'r',...w.enter);
  hold.resolve(page(present?[...others,row(prNum)]:others)); await tick();
  const frame=display(v);
  assert.ok(frame.includes(w.title),frame);
  if(name!=='linked') assert.equal(frame.includes('▸ Ticket-64'),present,frame);
  keys(v,...w.save);await tick();
  assert.deepEqual(writes.map(x=>x.slice(0,2)),[[w.seam,64]]);
  if(name==='linked') assert.deepEqual(writes[0][2],{add:[],remove:[915]});
});
for(const name of ['close','merge','linked']) for(const which of ['permission removed','merged','gone']) test(`D20 view: ${name}, ${which} while step is open`,async()=>{
  const w=workflow[name];const {v,hold,writes,reads,others,changeRead}=await panel();
  keys(v,'r',...w.enter);
  changeRead(n=>n!==64?detail(n):which==='gone'?{ok:false,error:'gone'}:detail(n,which==='merged'?{state:'merged'}:{permissions:{}}));
  hold.resolve(page(which==='permission removed'?[...others,row(64)]:others));await tick();
  const start=reads.length;
  keys(v,...w.save);await tick();
  assert.deepEqual(writes,[]);
  assert.ok(reads.slice(start).some(([n,o])=>n===64&&o?.refresh));
  assert.match(display(v),which==='permission removed'?w.fail:new RegExp(notOpen(name)));
});
for(const name of ['close','merge','linked']) test(`NEW: ${name} must not use superseded positive detail after newer reload revokes it`,async()=>{
  const w=workflow[name];const {v,hold,writes,others,changeRead}=await panel();
  const first=deferred(),newer=deferred();let read=0;
  keys(v,'r',...w.enter);
  changeRead((n)=>n!==64?detail(n):++read===1?first.promise:newer.promise);
  keys(v,...w.save);
  hold.resolve(page([row(64),...others]));await tick();
  newer.resolve(detail(64,{permissions:{}}));await tick();
  first.resolve(detail(64));await tick();
  assert.deepEqual(writes,[]);
  assert.match(display(v),w.fail);
});
for(const [key,seam] of [['l','editLabels'],['a','editAssignees']]) for(const reordered of [false,true]) test(`D3: ${seam} permission revocation during ${reordered?'reordering':'same-row'} reload`,async()=>{
  const {v,hold,writes,others,changeRead}=await panel();keys(v,'r',key); await tick(); keys(v,'space');
  changeRead(n=>detail(n,n===64?{permissions:{}}:{}));
  hold.resolve(page(reordered?[...others,row(64)]:[row(64),...others]));await tick();
  keys(v,'ctrl+s');await tick();
  assert.deepEqual(writes,[]);
});
test('D6 and D12: j/k edit merge text; rebase hides text fields and sends no text',async()=>{
  const {v,writes}=await panel();keys(v,'m','tab','j','k','tab','j','k','ctrl+s');await tick();
  assert.deepEqual(writes,[['merge',64,{method:'merge',subject:'Subjectjk',body:'Detailsjk'}]]);
  const view=(await panel());keys(view.v,'m','right');
  assert.match(display(view.v),/Confirm merge #64/);assert.doesNotMatch(display(view.v),/Commit message:|Description:/);
  keys(view.v,'ctrl+s');await tick();assert.deepEqual(view.writes,[['merge',64,{method:'rebase'}]]);
});
test('D7: numbered open outside every bucket stays on a merged PR and allows comments only',async()=>{
  const reads=[],writes=[];
  const v=createPrsView({initialPullRequest:713,loadPullRequestPage:()=>page([row(72)]),loadPullRequest:n=>{reads.push(n);return detail(n,n===713?{state:'merged'}:{});},actions:{commentPullRequest:(...a)=>{writes.push(a);return {ok:true};},close:()=>assert.fail('unexpected write')}});
  await tick();assert.ok(reads.includes(713));assert.match(display(v),/#713 Ticket-713/);
  keys(v,'x');assert.equal(v.state.mode,'list');keys(v,'c','z','ctrl+s');await tick();assert.deepEqual(writes,[[713,'z']]);
});

// `gh 2.104.0 api graphql` uses the selected API hostname (GH_HOST or
// --hostname), NOT the host part of GH_REPO, unlike `gh pr view 64 --json body`.
for (const [name, call] of writeCalls) test(`D19: ${name} GraphQL read selects the enterprise API host`, async t => {
  const host = 'github.company.example';
  const {c,calls} = client(t);
  const result = await call(c,{env:{GH_REPO:`${host}/amber/widget`}});
  assert.equal(result.ok,true);
  const lookup = calls.find(x => x.argv[1]==='graphql');
  const i = lookup.argv.indexOf('--hostname');
  const selectedByArg = lookup.argv.find(x=>x.startsWith('--hostname='))?.split('=')[1];
  assert.equal((i<0?selectedByArg:lookup.argv[i+1]) || lookup.host || 'github.com',host);
});

test('S1: review, involved and all return to the previous scoped bucket', async()=>{
  const seen=[];
  const v=createPrsView({loadPullRequestPage: ({bucketId})=>{seen.push(bucketId);return page([row(64)]);}});
  await tick();
  for(const label of ['My Pull Request','Needs My Review','Involved']) assert.match(display(v),new RegExp(label));
  keys(v,'tab');await tick();keys(v,'tab');await tick();keys(v,'g');await tick();
  assert.match(display(v),/▸ All \(1\)/);keys(v,'g');await tick();
  assert.match(display(v),/▸ Involved/);assert.deepEqual(seen,['mine','review','involved','all']);
});
test('S3: summary, local search/scroll and web opener',()=>{
  const opened=[];
  const pr={...detail(64).pullRequest,labels:[{name:'support'}],assignees:['pat'],reviewers:[{login:'kai',state:'APPROVED'}],createdAt:'2025-01-01',updatedAt:'2025-01-02',changedFiles:3,additions:20,deletions:9,commits:2,checks:{state:'FAILURE',total:3,passed:2,failed:1,pending:0,failing:['lint']}};
  const v=createPrsView({rowsAvailable:()=>24,pages:[{label:'My Pull Request',rows:[pr,row(65)]}],loadPullRequest:n=>n===64?{ok:true,pullRequest:pr}:detail(n),actions:{openBrowser:(n)=>opened.push(n)}});
  const frame=display(v);
  for(const pattern of [/someone-else/,/kai/,/#915/,/created.*updated/,/support/,/3 files changed.*\+20.*-9/,/2 commits/,/3 checks/,/lint/]) assert.match(frame,pattern);
  keys(v,'o','/','6','5','enter','pagedown','o');
  assert.deepEqual(opened,[64,65]);assert.match(display(v),/Ticket-65/);
});

test('S4/S5, D8/D9/D15: independent store reload, repaint notifications, exact count and review click',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'t13-rail-'));
  const identity='github.com/amber/widget';const mine=Array.from({length:50},(_,i)=>({number:i+101,linkedIssues:[]}));
  const review=[mine[0]];
  assert.equal(await createPrsRailStore({dir}).save(identity,{mine,review,counts:{mine:52,review:1},syncedAt:11}),true);
  const freshStore=createPrsRailStore({dir});
  const live=deferred(), hydration=deferred(), queued=[], frames=[], clicks=[];let loading=0;
  const rail=createIssuesSection({now:()=>11,schedule:fn=>queued.push(fn),onRefreshed:()=>frames.push(rail.section.meta()),
    load:()=>({ok:true,identity,issues:[{number:70,title:'linked issue',pullRequestNumber:101},{number:71,title:'unlinked issue'}]}),
    loadPullRequests:()=>{loading++;return live.promise;},hydratePullRequests:()=>hydration.promise, open:(...a)=>clicks.push(a)});
  assert.equal(rail.section.rowLabel,'github');assert.equal(rail.section.placement,'end');
  await rail.refresh();assert.equal(rail.section.meta(),'2 issues');assert.equal(loading,0);
  const read=queued.shift()();assert.equal(loading,1);
  hydration.resolve(await freshStore.load(identity));await tick();
  assert.equal(rail.section.meta(),'2 issues · 52 pr');assert.equal(frames.at(-1),'2 issues · 52 pr');
  const clicked=rail.section.lines()[0].onClick();while(queued.length) queued.shift()();await clicked;
  assert.deepEqual(clicks,[[70,{pullRequest:101,pullRequestBucket:'review'}]]);
  live.resolve({ok:true,mine,review,counts:{mine:54,review:1}});await read;
  assert.equal(rail.section.meta(),'2 issues · 54 pr');assert.deepEqual(frames,['2 issues','2 issues · 52 pr','2 issues · 54 pr']);
  rail.dispose();
});

function clickNumber(v, frame, title, needle, width=130) {
  const y=frame.findIndex(s=>s.includes(title));assert.ok(y>=0,frame.join('\n'));
  const x=frame[y].indexOf(needle,frame[y].indexOf(title));assert.ok(x>=0,frame[y]);
  assert.equal(v.handleMouse({type:'click',button:'left',x,y,width,height:frame.length})?.handled,true,frame[y]);
}
test('S6/S7: independent hit ranges and Enter on both panels',()=>{
  const calls=[];const actions={openLinked:arg=>calls.push(arg),insert:text=>calls.push(text)};
  const v=createPrsView({pages:[{label:'Mine',rows:[row(64)]}],loadPullRequest:()=>detail(64,{linkedIssues:[915,916]}),actions,done:()=>calls.push('closed PR')});
  const issue={number:71,title:'Other issue',state:'open',linkedPullRequests:[91,92]};
  const w=createIssuesView({issues:[issue],loadIssue:()=>({ok:true,issue}),actions,done:()=>calls.push('closed ISSUE')});
  const p=v.render(130);clickNumber(v,p,'linked issues:','#915');clickNumber(v,p,'linked issues:','#916');keys(v,'enter');
  const q=w.render(130);clickNumber(w,q,'linked PRs:','#91');clickNumber(w,q,'linked PRs:','#92');keys(w,'enter');
  assert.deepEqual(calls,[{kind:'issue',number:915},{kind:'issue',number:916},'PR #64','closed PR',{kind:'pullRequest',number:91},{kind:'pullRequest',number:92},'ISSUE #71','closed ISSUE']);
});

test('D10/S5: registered /prs refuses moved repo; session_start does not await its held gh gate',async t=>{
  const {LIB_DIR,stubbedSource,defaultBridge,BRIDGE_SLOT,withGhPath}=require('./fixtures/load-extension');
  const {pathToFileURL}=require('node:url');
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'t13-ext-'));
  const file=path.join(tmp,'ext.mjs');await fs.writeFile(file,stubbedSource());
  const original={lib:process.env.GENTLE_WORKTREE_LIB_DIR,repo:process.env.GH_REPO,bridge:globalThis[BRIDGE_SLOT]};
  t.after(()=>{for(const [key, value] of [['GENTLE_WORKTREE_LIB_DIR',original.lib],['GH_REPO',original.repo]]){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  } if(original.bridge===undefined)delete globalThis[BRIDGE_SLOT];else globalThis[BRIDGE_SLOT]=original.bridge;});
  process.env.GENTLE_WORKTREE_LIB_DIR=LIB_DIR;
  process.env.GH_REPO='github.com/amber/widget';globalThis[BRIDGE_SLOT]=defaultBridge().api;
  const commands=new Map(), hooks=[], writes=[];
  const mod=await withGhPath('present',async()=>{
    const api=await import(pathToFileURL(file).href);
    api.default({registerCommand:(n,s)=>commands.set(n,s),registerTool:()=>{},on:(n,h)=>hooks.push([n,h])});return api;
  });
  const issues=mod.libModule('gh-issues.js');const git=mod.libModule('worktree-git.js');
  const restore={repoIdentity:git.repoIdentityAsync,status:issues.cachedGhStatus,runner:issues.runGh};
  t.after(()=>{git.repoIdentityAsync=restore.repoIdentity;issues.cachedGhStatus=restore.status;issues.runGh=restore.runner;});
  git.repoIdentityAsync=async()=>({root:tmp});
  const gate=deferred();let gateReads=0;
  issues.cachedGhStatus=()=>{gateReads++;return gate.promise;};
  issues.runGh=async (argv)=>{
    switch(argv.slice(0,2).join(' ')) {
      case 'api graphql': {
        if (argv[3].includes('search(')) return ok({data:{search:{edges:[{cursor:'edge-64',node:row(64,'OPEN')}],pageInfo:{hasNextPage:false},issueCount:1}}});
        return ok({data:{repository:{viewerPermission:'WRITE',pullRequest:{state:'OPEN',isDraft:false}}}});
      }
      case 'pr view': return ok({...row(64,'OPEN'),isDraft:false});
      default: writes.push(argv);return ok({});
    }
  };
  mod.setIssuesTuiLoader(async()=>({}));let pane;
  const ctx={cwd:tmp,ui:{notify:(text)=>assert.fail(text),custom:(factory)=>{pane=factory({terminal:{rows:24}},null,null,()=>{});}}};
  // The session hook must finish with its gate held. This does not wait for it.
  const startup=hooks.filter(([n])=>n==='session_start').map(([,fn])=>fn({},ctx));
  let settled=false;Promise.all(startup).then(()=>{settled=true;});await tick();
  assert.ok(settled);assert.equal(gateReads,1);gate.resolve({ok:true});await tick();
  await commands.get('prs').handler('',ctx);await tick();assert.ok(pane);
  process.env.GH_REPO='github.com/copper/widget';
  keys(pane,'x','enter');await tick();
  assert.match(display(pane,180),/the checkout's repository changed since this pull request list loaded \(now github\.com\/copper\/widget instead of github\.com\/amber\/widget\); reopen \/prs/);
  assert.deepEqual(writes,[]);
});

test('D14: downgrade create-only permission during a same-row reload refuses a new-label save', async()=>{
  const {v,hold,writes,others,changeRead}=await panel();
  keys(v,'r','l','n','N','e','w','enter');
  changeRead(n=>detail(n,{permissions:{...allCaps,canCreateLabels:false}}));
  hold.resolve(page([row(64),...others]));await tick();
  keys(v,'ctrl+s');await tick();
  assert.deepEqual(writes,[]);
  assert.match(display(v),/new labels cannot be created: this repository permission is missing/);
});

test('D17: merge must still visibly name the captured number when the row disappears in a short frame',async()=>{
  const {v,hold,writes,others}=await panel({rowsAvailable:()=>12});
  keys(v,'r','m');hold.resolve(page(others));await tick();
  const rendered=display(v);keys(v,'ctrl+s');await tick();
  assert.deepEqual(writes.map(x=>x.slice(0,2)),[['merge',64]]);
  assert.match(rendered,/Confirm merge #64/);
});
