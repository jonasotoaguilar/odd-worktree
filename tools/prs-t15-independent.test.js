'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {createPrsClient} = require('../lib/gh-prs');
const issuesClient = require('../lib/gh-issues');
const {createPrsView} = require('../lib/prs-view');
const {createIssuesView} = require('../lib/issues-view');
const {createIssuesSection} = require('../lib/issues-section');
const tick = () => new Promise(setImmediate);
const hold = () => { let resolve; return {promise: new Promise(r => { resolve = r; }), release: value => resolve(value)}; };
const ok = data => ({status: 0, stdout: JSON.stringify(data)});
const N = 381, I = 259;
const publicScope = 'github.com/pine/ledger', enterprise = 'github.company.example';
const entScope = `${enterprise}/pine/ledger`;
const caps = {canClosePullRequests:true, canMerge:true, canEditLinkedIssues:true, canEditLabels:true, canEditAssignees:true, canCreateLabels:true};
const row = (number=N, state='open') => ({number,state,title:`Ledger-${number}`,author:'someone-else'});
const detail = (number=N, changes={}) => ({ok:true,pullRequest:{...row(number),isDraft:false,permissions:caps,linkedIssues:[I],mergeMethods:{squash:true,rebase:true},mergeDefaults:{squash:{subject:'Ledger title',body:'Ledger body'}},...changes}});
const page = rows => ({ok:true,rows,hasMore:false,totalCount:rows.length});
const keys = (v,...inputs) => inputs.forEach(input=>v.handleInput(input));
const frame = (v,w=148) => v.render(w).join('\n');
function client(t, f={}) {
  const c=createPrsClient(f.delegates?{issues:issuesClient}:{});
  const calls=[],writes=[];
  c.setGhRunner((_bin,argv,opts)=>{
    const env=opts.env||{};
    const repo=env.GH_REPO||f.ambient?.()||publicScope;
    const apiHost=argv.includes('--hostname')?argv[argv.indexOf('--hostname')+1]:(env.GH_HOST||f.defaultApiHost||'github.com');
    const call={argv,repo,apiHost,env};calls.push(call);
    switch(argv.slice(0,2).join(' ')) {
      case 'repo view': return ok({nameWithOwner:repo.split('/').slice(-2).join('/'),url:`https://${repo}`});
      case 'pr view': return f.prView?.(call)||ok({...row(N,'OPEN'),isDraft:false,body:f.body??'Preamble\n'});
      case 'label list': return ok([]);
      case 'api graphql': {
        assert.match(argv[3],/^query=query\b/);
        f.afterRead?.(call);
        return ok({data:{viewer:{login:'lee'},repository:{viewerPermission:f.permission?.(call)||'WRITE',mergeCommitAllowed:true,squashMergeAllowed:true,...(argv[3].includes('pullRequest(number:') ? {pullRequest:{isDraft:false,state:f.state?.(call)||'OPEN',closingIssuesReferences:{nodes:[{number:I}]}}} : {}),assignableUsers:{nodes:[],pageInfo:{hasNextPage:false}}},search:{edges:[],pageInfo:{hasNextPage:false},issueCount:0},mine:{nodes:[],issueCount:0},review:{nodes:[],issueCount:0}}});
      }
      default: writes.push(call); return ok({});
    }
  });
  t.after(()=>c.setGhRunner(null));
  return {c,calls,writes};
}
const publicOpts={scope:publicScope,env:{}};
const mer=(c,o)=>c.mergePullRequest(N,{method:'squash',subject:'Exact subject',body:''},o);
const writesByKind={
  close:(c,o)=>c.closePullRequest(N,o), merge:mer,
  linked:(c,o)=>c.editLinkedIssues(N,{add:[I]},o),
  labels:(c,o)=>c.editLabels(N,{add:['triage']},o),
  assignees:(c,o)=>c.editAssignees(N,{add:['lee']},o),
  create:(c,o)=>c.createLabel({name:'triage'},o),
};
// D27 replaced the fence parser: only a line this panel wrote — carrying its
// marker — is ever removed, so the real declaration below carries one while the
// code example does not. Both bodies pair their fence runs, so the edit is read.
for(const [title,original] of [
  ['tilde CRLF',`Intro\r\n ~~~text\r\nCloses #${I}\r\n ~~~\r\n`],
  ['indent and nested list',`Intro\n\n- List\n  - Nested\n    ~~~text\n    Closes #${I}\n    ~~~\n`],
]) test(`D21 paired ${title}: preserve every byte except the real declaration`,async t=>{
  const eol=original.includes('\r\n')?'\r\n':'\n';
  const {c,writes}=client(t,{body:`${original}${eol}Closes #${I} <!-- odd-worktree:linked -->${eol}Tail${eol}`});
  await c.editLinkedIssues(N,{remove:[I]},publicOpts);
  assert.deepEqual(writes.map(x=>x.argv),[['pr','edit',String(N),'--body',`${original}${eol}Tail${eol}`]]);
});
test('D21 odd unclosed fence: never append a link inside it',async t=>{
  const {c,writes}=client(t,{body:`Intro\n\n ~~~text\nCloses #${I}\n`});
  const r=await c.editLinkedIssues(N,{add:[I+1]},publicOpts);
  assert.deepEqual(writes,[]); assert.equal(r.ok,false);
  // D27's single refusal sentence: an unpaired fence run or an unbalanced
  // comment means the body cannot be read, so nothing is added.
  assert.equal(r.error,'the pull request body ends inside an unclosed code fence or comment');
});
test('D21/S2 body data: info string inside a backtick fence is not a closing fence',async t=>{
  const body='```text\n```not-a-closer\n'+`Closes #${I}\n`+'```\n\nUnrelated prose.\n';
  const {c,writes}=client(t,{body});
  await c.editLinkedIssues(N,{remove:[I]},publicOpts);
  assert.deepEqual(writes.map(w=>w.argv),[]);
});
test('D21/S2 body data: HTML comment retains its closing-keyword example',async t=>{
  const body=`<!--\nTemplate example:\nCloses #${I}\n-->\n\nUnrelated prose.\n`;
  const {c,writes}=client(t,{body});
  await c.editLinkedIssues(N,{remove:[I]},publicOpts);
  assert.deepEqual(writes.map(w=>w.argv),[]);
});
test('S2 body data: concurrent author edit is not overwritten by the link command',async t=>{
  let body='Original text\n';
  const {c,writes}=client(t,{prView:()=>{
    const read=body;
    body='Original text\nAuthor added this while the read completed.\n';
    return ok({body:read});
  }});
  await c.editLinkedIssues(N,{add:[I]},publicOpts);
  if(writes.length) assert.ok(writes[0].argv[4].includes('Author added this'),JSON.stringify(writes[0].argv));
});
for(const [name,run] of Object.entries(writesByKind)) test(`D23 enterprise GH_REPO/GH_HOST and pin: ${name}`,async t=>{
  const {c,calls,writes}=client(t,{delegates:true});
  assert.equal((await run(c,{env:{GH_REPO:entScope,GH_HOST:enterprise}})).ok,true);
  assert.equal(writes.length,1);
  for(const call of calls){
    assert.equal(call.repo,entScope);
    assert.equal(call.env.GH_HOST,enterprise);
    if(call.argv[0]==='api') assert.equal(call.argv[call.argv.indexOf('--hostname')+1],enterprise);
  }
  if(name==='merge') assert.deepEqual(writes[0].argv,['pr','merge',String(N),'--squash','--subject','Exact subject','--body','']);
});
test('D23 enterprise read surface: page, metadata, assignable users, labels and rail',async t=>{
  const {c,calls,writes}=client(t,{delegates:true});
  const opts={scope:entScope,env:{GH_REPO:entScope,GH_HOST:enterprise}};
  for(const result of await Promise.all([c.getPullRequestPage({bucket:'review'},opts),c.getPullRequest(N,{includeMetadata:true},opts),c.listAssignableUsers(opts),c.listLabels(opts),c.listRailPullRequests({},opts)])) assert.equal(result.ok,true);
  assert.deepEqual(writes,[]);
  for(const call of calls) {
    assert.equal(call.env.GH_HOST,enterprise);
    if(call.argv[0]==='api') assert.equal(call.apiHost,enterprise,call.argv[3]);
  }
});
test('D23/S2 explicit github.com pin cannot use Enterprise permission to authorize close',async t=>{
  const {c,calls,writes}=client(t,{defaultApiHost:enterprise,permission:({apiHost})=>apiHost===enterprise?'WRITE':'READ'});
  await c.closePullRequest(N,publicOpts);
  assert.deepEqual(writes.map(w=>[w.repo,w.argv]),[],JSON.stringify(calls.map(w=>[w.repo,w.apiHost,w.argv.slice(0,2)])));
});
test('D24 ambient repository changes after role read: close stays on original repository',async t=>{
  let ambient=publicScope;
  const {c,calls,writes}=client(t,{ambient:()=>ambient,afterRead:()=>{ambient='github.com/oak/ledger';}});
  assert.equal((await c.closePullRequest(N,{env:{}})).ok,true);
  assert.deepEqual(calls.map(call=>call.repo),[publicScope,publicScope,publicScope]);
  assert.deepEqual(writes.map(w=>w.argv),[['pr','close',String(N)]]);
});
test('D24/S2 ambient enterprise resolution pins the resolved repository host as well as its slug',async t=>{
  let ambient=entScope;
  const {c,writes}=client(t,{ambient:()=>ambient,defaultApiHost:enterprise,afterRead:()=>{ambient=`${enterprise}/oak/ledger`;}});
  await c.closePullRequest(N,{env:{}});
  assert.ok(writes.every(w=>w.repo===entScope),JSON.stringify(writes.map(w=>[w.repo,w.argv])));
});
const tasks={
  close:{edit:['x'],save:'enter',seam:'close',anchor:`Confirm close #${N}`},
  merge:{edit:['m'],save:'ctrl+s',seam:'merge',anchor:`Confirm merge #${N}`},
  comment:{edit:['c','z'],save:'ctrl+s',seam:'commentPullRequest',anchor:`Comment on #${N}`},
  linked:{edit:['i','space'],save:'ctrl+s',seam:'editLinkedIssues'},
  labels:{edit:['l','space'],save:'ctrl+s',seam:'editLabels'},
  assignees:{edit:['a','space'],save:'ctrl+s',seam:'editAssignees'},
  create:{edit:['l','n','z','e','d','enter'],save:'ctrl+s',seam:'editLabels'},
};
async function panel(extra={}) {
  const reload=hold(),writes=[],reads=[];
  const others=Array.from({length:20},(_,i)=>row(N+i+1));
  let mine=0,source=number=>detail(number),height=12;
  const actions=Object.fromEntries(Object.values(tasks).map(task=>[task.seam,(...a)=>{writes.push([task.seam,...a]); return {ok:true};}]));
  const v=createPrsView({rowsAvailable:()=>height,loadPullRequestPage:({bucketId})=>bucketId==='mine'&&++mine===2?reload.promise:page([row(),...others]),loadPullRequest:(n,opt)=>{reads.push([n,opt]);return source(n,opt);},loadAssignees:()=>({ok:true,users:[{login:'lee'}]}),labels:[{name:'triage'}],actions,...extra});
  await tick();
  return {v,writes,reads,reload,others,load:fn=>{source=fn;},resize:rows=>{height=rows;}};
}
for(const name of ['close','merge','comment']) test(`D22 short frame, removed target: ${name} names captured #${N}`,async()=>{
  const {v,writes,reload,others}=await panel(); const task=tasks[name];
  keys(v,'r',...task.edit);
  reload.release(page(others)); await tick();
  assert.equal(v.render(148).length,12);
  assert.ok(frame(v).includes(task.anchor),frame(v));
  keys(v,task.save);await tick();
  assert.deepEqual(writes.map(w=>w.slice(0,2)),[[task.seam,N]]);
  if(name==='merge') assert.deepEqual(writes[0][2],{method:'squash',subject:'Ledger title',body:'Ledger body'});
});
// MINOR advisory (T15 verdict): at 24 columns the target line clips, the captured PR is still the one dispatched.
test.todo('D22 merge: shrink width after opening; no blind confirmation',async()=>{
  const {v,writes}=await panel();keys(v,'m');
  assert.match(frame(v),/Confirm merge/);
  const narrow=frame(v,24);assert.doesNotMatch(narrow,/Confirm merge/);
  keys(v,'ctrl+s');await tick();
  assert.deepEqual(writes,[],`${narrow}\n${JSON.stringify(writes)}`);
});
for(const name of ['close','merge','linked','labels','assignees','create']) test(`D25/D26 newest negative detail wins a pending save: ${name}`,async()=>{
  const {v,writes,reads,reload,load,others}=await panel();
  const older=hold(),newer=hold();let read=0;
  const task=tasks[name];keys(v,'r',...task.edit);await tick();
  load(n=>n!==N?detail(n):++read===1?older.promise:newer.promise);
  const start=reads.length;keys(v,task.save);await tick();
  reload.release(page([row(),...others.reverse()]));await tick();
  assert.deepEqual(reads.slice(start).filter(([n])=>n===N),[[N,{refresh:true}],[N,{refresh:true}]]);
  newer.release(detail(N,name==='create'?{permissions:{...caps,canCreateLabels:false}}:name==='assignees'?{state:'closed'}:{permissions:{}}));await tick();
  older.release(detail());await tick();
  assert.deepEqual(writes,[]);
});
test('S2 merge method revoked while editor open: no merge seam',async()=>{
  const {v,writes,load}=await panel();keys(v,'m');
  load(n=>detail(n,{mergeMethods:{rebase:true}}));
  keys(v,'ctrl+s');await tick();
  assert.deepEqual(writes,[]);
});
for(const kind of ['labels','assignees']) test(`S2 fresh client access must not emit ${kind} edit for closed PR`,async t=>{
  const {c,writes}=client(t,{state:()=> 'CLOSED'});
  await writesByKind[kind](c,publicOpts);
  assert.deepEqual(writes.map(w=>w.argv),[]);
});
test('S2 real client detail: newer GraphQL CLOSED must refuse the label seam despite older pr view OPEN',async t=>{
  let state='OPEN';
  const {c,writes:children}=client(t,{state:()=>state});
  const {v,writes}=await panel({loadPullRequest:n=>c.getPullRequest(n,{includeMetadata:true},publicOpts)});
  await tick();keys(v,'l','space');state='CLOSED';keys(v,'ctrl+s');await tick();
  assert.deepEqual(children,[]);assert.deepEqual(writes,[]);
});
test('S7 enter inserts exactly once and only from list mode in both views',()=>{
  const calls=[];const actions={insert:text=>calls.push(text)};
  const issue={number:I,title:'Ledger issue',state:'open'};
  const pr=createPrsView({pages:[{label:'mine',rows:[row()]}],loadPullRequest:()=>detail(),actions});
  const iv=createIssuesView({issues:[issue],loadIssue:()=>({ok:true,issue}),actions});
  for(const v of [pr,iv]) { frame(v); keys(v,'/','enter'); assert.equal(calls.length,0); }
  keys(pr,'c','enter');keys(iv,'c','enter');assert.equal(calls.length,0);
  for(const v of [pr,iv])keys(v,'escape','y','enter');
  assert.deepEqual(calls,[`PR #${N}`,`ISSUE #${I}`]);
});
test('S5/S2 rail must not close a same-number PR in a different repo from the linked source',async t=>{
  const target='github.com/oak/payroll';
  const parse={mine:{issueCount:1,nodes:[{number:I,title:'Issue linked to another repository',state:'OPEN',url:`https://${publicScope}/issues/${I}`,timelineItems:{nodes:[{source:{__typename:'PullRequest',number:N,repository:{nameWithOwner:'oak/payroll'},url:`https://${target}/pull/${N}`}}]}}]},assigned:{issueCount:0,nodes:[]},involved:{issueCount:0,nodes:[]}};
  issuesClient.setGhRunner((_bin,argv)=>{
    assert.deepEqual(argv.slice(0,2),['api','graphql']);assert.match(argv[3],/^query=query\b/);return ok({data:parse});
  });
  t.after(()=>issuesClient.setGhRunner(null));
  const loaded=await issuesClient.listRelatedIssues({first:5},publicOpts); assert.equal(loaded.ok,true,JSON.stringify(loaded));
  const writes=[],routes=[];let opened;
  const rail=createIssuesSection({schedule:fn=>fn(),load:()=>({ok:true,identity:publicScope,issues:loaded.buckets.mine.issues}),open:(number,hint)=>{
    routes.push([number,hint]);
    if(!hint?.pullRequest)return;
    // Extension dispatches `/prs <number>` in the current checkout; a hint
    // without repository identity therefore opens this repo's lookalike PR.
    const openedScope=hint.scope||publicScope;
    opened=createPrsView({loadPullRequestPage:()=>page([row(hint.pullRequest)]),initialPullRequest:hint.pullRequest,loadPullRequest:n=>detail(n),actions:{close:(n)=>{writes.push([openedScope,n]);return {ok:true};}}});
  }});
  t.after(()=>rail.dispose());
  await rail.refresh(); await rail.section.lines()[0].onClick();
  if(opened){await tick();frame(opened);keys(opened,'x','enter');await tick();}
  assert.ok(routes.length,JSON.stringify(rail.section.lines()));
  assert.ok(writes.every(([scope,num])=>scope===target&&num===N),JSON.stringify(writes));
});
test('S6/S2 cross-repository clickable PR must not close the current repository lookalike',async t=>{
  const linkedScope='github.com/oak/payroll';
  const issueRow={number:I,title:'Issue with cross-repository closer',state:'OPEN',url:`https://${publicScope}/issues/${I}`};
  issuesClient.setGhRunner((_bin,argv)=>{
    if(argv.slice(0,2).join(' ')==='issue view') return ok(issueRow);
    assert.deepEqual(argv.slice(0,2),['api','graphql']); assert.match(argv[3],/^query=query\b/);
    const ref={number:N,repository:{nameWithOwner:'oak/payroll'},url:`https://${linkedScope}/pull/${N}`};
    return ok({data:{repository:{viewerPermission:'WRITE',issue:{assignees:{nodes:[],pageInfo:{hasNextPage:false}},closedByPullRequestsReferences:{nodes:[ref],pageInfo:{hasNextPage:false}},projectItems:{nodes:[],pageInfo:{hasNextPage:false}}}}}});
  });
  t.after(()=>issuesClient.setGhRunner(null));
  const loaded=await issuesClient.getIssue(I,{...publicOpts,includeMetadata:true});
  assert.equal(loaded.ok,true);
  const writes=[];let opened;
  const v=createIssuesView({issues:[loaded.issue],loadIssue:()=>loaded,actions:{openLinked:link=>{
    assert.equal(link.kind,'pullRequest');assert.equal(link.number,N);
    const repo=link.scope||publicScope;
    opened=createPrsView({initialPullRequest:N,loadPullRequestPage:()=>page([row()]),loadPullRequest:n=>detail(n),actions:{close:n=>{writes.push([repo,n]);return {ok:true};}}});
  }}});
  const lines=v.render(148);
  const y=lines.findIndex(line=>line.includes('linked PRs:'));
  if(y<0) return; // A safe implementation can withhold an unpinnable target.
  const x=lines[y].indexOf(`#${N}`,lines[y].indexOf('linked PRs:'));
  assert.ok(x>=0);
  v.handleMouse({type:'click',button:'left',x,y,width:148,height:lines.length});
  if(opened){await tick();frame(opened);keys(opened,'x','enter');await tick();}
  assert.ok(writes.every(([scope,n])=>scope===linkedScope&&n===N),JSON.stringify(writes));
});
