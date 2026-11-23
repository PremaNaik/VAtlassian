import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { Window } from 'happy-dom';
const window = new Window({ url: 'https://tenant.atlassian.net/jira/software/projects/A/boards/3/backlog' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const reactURL = new URL('../node_modules/react/index.js', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/bridge') return { url: 'sprint:bridge', shortCircuit: true };
    if (specifier.startsWith('@atlaskit/')) return { url: 'sprint:kit/' + specifier.split('/')[1], shortCircuit: true };
    if (specifier.startsWith('.')) { const url = new URL(specifier, context.parentURL); for (const ext of ['.ts', '.tsx']) if (fs.existsSync(fileURLToPath(url) + ext)) return { url: url.href + ext, shortCircuit: true }; }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'sprint:bridge') return { format: 'module', shortCircuit: true, source: `export const invoke=(...args)=>globalThis.transport(...args);export const events={emit:async()=>{}};export const router={open:async()=>{},navigate:async()=>{}};` };
    if (url.startsWith('sprint:kit/')) return { format: 'module', shortCircuit: true, source: `import React from '${reactURL}'; export default function Kit({children,onClick,isDisabled,disabled,href}){const kind='${url.split('/').at(-1)}';if(kind==='button')return React.createElement('button',{onClick,disabled:isDisabled||disabled},children);if(kind==='link')return React.createElement('a',{href},children);return React.createElement('span',{},children);}` };
    if (/\.tsx?$/.test(url)) return { format: 'module', shortCircuit: true, source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText };
    return next(url, context);
  }
});
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const SprintReadiness = (await import('../src/sprint/SprintReadiness.tsx')).default;
hooks.deregister();

let root, container;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
async function mount(reply) {
  const calls = [];
  globalThis.transport = (key, payload) => { calls.push({ key, payload }); return key === 'harness:logAction' ? Promise.resolve({ ok: true }) : Promise.resolve(reply(key, payload)); };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(() => root.render(React.createElement(SprintReadiness))); await flush();
  return calls;
}
afterEach(async () => { if (root) await act(() => root.unmount()); container?.remove(); root = null; });
const text = () => container.textContent;
const button = label => [...container.querySelectorAll('button')].find(b => b.textContent.includes(label));
async function type(input, value) {
  await act(() => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
}

const sprint = state => ({ id: '7', name: 'Sprint 7', state, goal: '', startDate: null, endDate: '2099-01-10T00:00:00Z' });
const item = (key, ready, reasons = []) => ({ issueId: key, issueKey: key, summary: `${key} summary`, treeSize: 2, ready, reasons });

test('a sprint that is not ready shows what holds each item and offers no signature', async () => {
  await mount(() => ({ success: true, sprint: sprint('future'), canSign: true, role: 'Sprint owner', meaning: 'I start it.',
    assessment: { ready: false, empty: false, readyCount: 1, total: 2, readinessHash: 'h',
      items: [item('A-1', true), item('B-1', false, [{ code: 'UNDECIDED_DRIFT', issueKey: 'B-2' }])] } }));
  assert.match(text(), /1 of 2 work items are ready/);
  assert.match(text(), /B-2 has changes since approval that are not decided/);
  assert.equal(Boolean(button('Sign and start sprint')), false);
});

test('a ready sprint is started with the affirmation, a code and the readiness hash it showed', async () => {
  const calls = await mount(key => key === 'sprint:start' ? { success: true, operationId: 'x', state: 'DONE' }
    : { success: true, sprint: sprint('future'), canSign: true, role: 'Sprint owner', meaning: 'I start it.',
      assessment: { ready: true, empty: false, readyCount: 1, total: 1, readinessHash: 'hash-1', items: [item('A-1', true)] } });
  assert.match(text(), /All 1 work items are ready/);
  assert.equal(button('Sign and start sprint').disabled, true);
  await act(() => container.querySelector('input[type=checkbox]').click());
  await type(container.querySelector('.va-code'), '123456');
  await act(() => button('Sign and start sprint').click()); await flush();
  const sent = calls.find(c => c.key === 'sprint:start');
  assert.equal(sent.payload.code, '123456');
  assert.equal(sent.payload.readinessHash, 'hash-1');
  assert.match(sent.payload.endDate, /^2099-01-1/);
});

test('without the sprint role the readiness is visible but nothing can be signed', async () => {
  await mount(() => ({ success: true, sprint: sprint('future'), canSign: false, role: 'Sprint owner', meaning: 'x',
    assessment: { ready: true, empty: false, readyCount: 1, total: 1, readinessHash: 'h', items: [item('A-1', true)] } }));
  assert.match(text(), /needs the "Sprint owner" role/);
  assert.equal(Boolean(button('Sign and start sprint')), false);
});

test('a running sprint is completed to the chosen destination and the screen follows the queued close', async () => {
  let polls = 0;
  const calls = await mount(key => {
    if (key === 'sprint:complete') return { success: true, operationId: 'op', state: 'QUEUED' };
    if (key === 'sprint:operation') { polls += 1; return { success: true, state: 'DONE' }; }
    return { success: true, sprint: sprint('active'), canSign: true, role: 'Sprint owner', meaning: 'I complete it.',
      openItems: [{ id: '1', key: 'A-1', summary: 's', status: 'In Progress' }], doneCount: 3, completionHash: 'c-1',
      futureSprints: [{ id: '8', name: 'Sprint 8' }] };
  });
  assert.match(text(), /3 done work items stay with this sprint/);
  await act(() => { const s = container.querySelector('select'); s.value = '8'; s.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await act(() => container.querySelector('input[type=checkbox]').click());
  await type(container.querySelector('.va-code'), '654321');
  await act(() => button('Sign and complete sprint').click()); await flush();
  const sent = calls.find(c => c.key === 'sprint:complete');
  assert.deepEqual(sent.payload.destination, { type: 'sprint', sprintId: '8' });
  assert.equal(sent.payload.completionHash, 'c-1');
  await act(async () => { await new Promise(r => setTimeout(r, 2100)); }); await flush();
  assert.equal(polls, 1);
  assert.match(text(), /Sprint completed/);
});
