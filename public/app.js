const STORAGE_KEY = 'context-ide-workspace-v1';
const colors = ['#8b7cff', '#62d6a5', '#f0a65a', '#e47da8', '#65a9ef'];
const defaults = {
  universalContext: 'Project: Context IDE\nGoal: Build focused, high-quality work across agents.\nConvention: Record durable decisions here so agent switches do not lose them.',
  agents: [
    { id:'builder', name:'Builder', model:'gpt-5-mini', instructions:'Act as a senior software engineer. Turn ideas into concrete, tested implementations.' },
    { id:'architect', name:'Architect', model:'gpt-5-mini', instructions:'Design systems, expose tradeoffs, and keep the whole architecture coherent.' },
    { id:'researcher', name:'Researcher', model:'gpt-5-mini', instructions:'Investigate carefully, distinguish facts from inference, and summarize evidence.' }
  ],
  activeTabId:'welcome',
  tabs:[{ id:'welcome', title:'Build the context layer', agentId:'architect', attachedIds:[], messages:[{ role:'assistant', agentId:'architect', content:'This task has its own conversation, but I can also read the universal context and any tabs attached to it. What should we design first?' }] }]
};

let state = load();
let savingTimer;
const $ = s => document.querySelector(s);

function load() { try { return { ...structuredClone(defaults), ...JSON.parse(localStorage.getItem(STORAGE_KEY)) }; } catch { return structuredClone(defaults); } }
function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); $('#save-state').textContent='Saved locally'; }
function scheduleSave() { $('#save-state').textContent='Saving…'; clearTimeout(savingTimer); savingTimer=setTimeout(save,250); }
function id(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`; }
function activeTab() { return state.tabs.find(t => t.id === state.activeTabId) || state.tabs[0]; }
function agent(agentId=activeTab().agentId) { return state.agents.find(a => a.id===agentId) || state.agents[0]; }
function esc(s='') { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

function render() {
  const tab=activeTab(); if (!tab) return;
  $('#tabs').innerHTML=state.tabs.map(t=>`<button class="tab ${t.id===tab.id?'active':''}" data-tab="${t.id}"><span class="tab-title">${esc(t.title)}</span>${state.tabs.length>1?`<span class="close" data-close-tab="${t.id}">×</span>`:''}</button>`).join('');
  $('#agent-list').innerHTML=state.agents.map((a,i)=>`<button class="agent ${a.id===tab.agentId?'active':''}" data-agent="${a.id}"><span class="avatar" style="color:${colors[i%colors.length]}">${esc(a.name[0])}</span><span class="agent-copy"><span class="agent-name">${esc(a.name)}</span><span class="agent-model">${esc(a.model)}</span></span></button>`).join('');
  $('#universal-context').value=state.universalContext;
  $('#context-count').textContent=`${state.universalContext.length} chars`;
  $('#task-title').value=tab.title;
  $('#active-agent-label').textContent=agent().name;
  $('#message-count').textContent=`${tab.messages.length} message${tab.messages.length===1?'':'s'}`;
  $('#attachments').innerHTML=(tab.attachedIds||[]).map(x=>state.tabs.find(t=>t.id===x)).filter(Boolean).map(t=>`<button class="attachment" data-remove-attachment="${t.id}">↗ ${esc(t.title)} ×</button>`).join('');
  $('#messages').innerHTML=tab.messages.length ? tab.messages.map(messageHtml).join('') : `<div class="empty"><div><strong>Fresh task, full context.</strong>Choose an agent and start working.</div></div>`;
  $('#graph').innerHTML=`<div class="node">◉ Universal context</div><div class="node-link"></div><div class="node active">▣ ${esc(tab.title)}</div>`+(tab.attachedIds||[]).map(x=>state.tabs.find(t=>t.id===x)).filter(Boolean).map(t=>`<div class="node-link"></div><div class="node">↗ ${esc(t.title)}</div>`).join('');
  $('#context-preview').textContent=contextPreview(tab);
  requestAnimationFrame(()=>{ const m=$('#messages'); m.scrollTop=m.scrollHeight; });
}

function messageHtml(m) {
  if (m.role==='user') return `<div class="message user"><div class="bubble"><div class="body">${esc(m.content)}</div></div></div>`;
  const a=agent(m.agentId); const i=state.agents.indexOf(a);
  return `<div class="message ${m.error?'error':''}"><span class="avatar" style="color:${colors[i%colors.length]}">${esc(a.name[0])}</span><div><div class="who">${esc(a.name)}</div><div class="body">${esc(m.content)}</div></div></div>`;
}

function attachedContext(tab) {
  return (tab.attachedIds||[]).map(tid=>state.tabs.find(t=>t.id===tid)).filter(Boolean).map(t=>`TASK: ${t.title}\n${t.messages.slice(-8).map(m=>`${m.role.toUpperCase()}: ${m.content}`).join('\n')}`).join('\n\n---\n\n');
}
function contextPreview(tab) { return `${state.universalContext || '(No universal context)'}${tab.attachedIds?.length?'\n\nATTACHED TABS\n'+attachedContext(tab):''}`; }

function newTab() { const t={ id:id('task'), title:'Untitled task', agentId:activeTab()?.agentId||state.agents[0].id, attachedIds:[], messages:[] }; state.tabs.push(t); state.activeTabId=t.id; save(); render(); $('#task-title').select(); }
function closeTab(tid) { if(state.tabs.length===1)return; const idx=state.tabs.findIndex(t=>t.id===tid); state.tabs.splice(idx,1); state.tabs.forEach(t=>t.attachedIds=(t.attachedIds||[]).filter(x=>x!==tid)); if(state.activeTabId===tid) state.activeTabId=state.tabs[Math.max(0,idx-1)].id; save(); render(); }

async function sendMessage(event) {
  event.preventDefault(); const input=$('#prompt'); const content=input.value.trim(); if(!content)return;
  const tab=activeTab(), activeAgent=agent(); tab.messages.push({role:'user',content}); input.value=''; tab.messages.push({role:'assistant',agentId:activeAgent.id,content:'Thinking…',pending:true}); save(); render();
  const pending=tab.messages[tab.messages.length-1];
  try {
    const response=await fetch('/api/respond',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agent:activeAgent,context:state.universalContext,attachedContext:attachedContext(tab),messages:tab.messages.filter(m=>!m.pending)})});
    const data=await response.json(); if(!response.ok)throw new Error(data.error||'Request failed'); pending.content=data.text||'(No response)';
  } catch(error) { pending.content=`Could not run the agent: ${error.message}`; pending.error=true; }
  delete pending.pending; save(); render();
}

$('#new-tab').onclick=newTab;
$('#tabs').onclick=e=>{ const close=e.target.closest('[data-close-tab]'); if(close){e.stopPropagation();return closeTab(close.dataset.closeTab);} const t=e.target.closest('[data-tab]'); if(t){state.activeTabId=t.dataset.tab;save();render();} };
$('#agent-list').onclick=e=>{const a=e.target.closest('[data-agent]');if(a){activeTab().agentId=a.dataset.agent;save();render();}};
$('#universal-context').oninput=e=>{state.universalContext=e.target.value;$('#context-count').textContent=`${e.target.value.length} chars`;scheduleSave();$('#context-preview').textContent=contextPreview(activeTab());};
$('#task-title').oninput=e=>{activeTab().title=e.target.value||'Untitled task';scheduleSave();};
$('#task-title').onchange=render;
$('#composer').onsubmit=sendMessage;
$('#prompt').onkeydown=e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey))sendMessage(e);};
$('#clear-button').onclick=()=>{if(confirm('Clear this task conversation?')){activeTab().messages=[];save();render();}};
$('#attachments').onclick=e=>{const b=e.target.closest('[data-remove-attachment]');if(b){activeTab().attachedIds=activeTab().attachedIds.filter(x=>x!==b.dataset.removeAttachment);save();render();}};
$('#attach-button').onclick=()=>{const tab=activeTab();$('#attach-options').innerHTML=state.tabs.filter(t=>t.id!==tab.id).map(t=>`<label class="attach-option"><input type="checkbox" data-attach="${t.id}" ${(tab.attachedIds||[]).includes(t.id)?'checked':''}/><span>${esc(t.title)}</span></label>`).join('')||'<p>Create another tab first.</p>';$('#attach-dialog').showModal();};
$('#attach-options').onchange=e=>{if(!e.target.matches('[data-attach]'))return;const ids=new Set(activeTab().attachedIds||[]);e.target.checked?ids.add(e.target.dataset.attach):ids.delete(e.target.dataset.attach);activeTab().attachedIds=[...ids];save();render();};
$('#new-agent').onclick=()=>$('#agent-dialog').showModal();
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$('#agent-dialog').close());
$('#agent-form').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);const a={id:id('agent'),name:f.get('name').trim(),model:f.get('model').trim(),instructions:f.get('instructions').trim()};state.agents.push(a);activeTab().agentId=a.id;save();$('#agent-dialog').close();e.target.reset();e.target.elements.model.value='gpt-5-mini';render();};
render();
