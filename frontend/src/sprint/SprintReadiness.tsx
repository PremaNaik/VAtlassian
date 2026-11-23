import { useCallback, useEffect, useRef, useState } from 'react';
import Button from '@atlaskit/button';
import { invoke } from '../lib/bridge';
import { Affirmation, Badge, Card, CodeInput, EmptyState, Facts, Field, IssueLink, Loading, Page, Select, Table } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import { errorMessage } from '../lib/result';

/**
 * The "Start Sprint" sprint action (va-sprint-readiness).
 *
 * A future sprint: "Check readiness" lists every item and what holds it, and
 * "Sign and start sprint" is offered only when every tree is ready.
 * A running sprint: "Sign and complete sprint" moves the open items to a
 * future sprint or the backlog, then closes it. The server re-checks
 * everything (src/lib/sprintStart.js); this screen only decides what to show.
 */

const REASON_TEXT: Record<string, string> = {
  NOT_BASELINED: 'has no active baseline',
  UNDECIDED_DRIFT: 'has changes since approval that are not decided',
  REVIEW_IN_PROGRESS: 'has a decision or restore in progress',
  REVIEW_ERROR: 'has a review that needs attention',
  TREE_INCOMPLETE: 'has more descendants than can be checked'
};

type Reason = { code: string; issueKey: string };
type Item = { issueId: string; issueKey: string; summary: string; treeSize: number; ready: boolean; reasons: Reason[] };
type Sprint = { id: string; name: string; state: string; goal: string; startDate: string | null; endDate: string | null };
type OpenItem = { id: string; key: string; summary: string; status: string };
type Readiness = {
  success: boolean; error?: string; reason?: string;
  sprint?: Sprint; canSign?: boolean; role?: string; meaning?: string;
  assessment?: { ready: boolean; empty: boolean; readyCount: number; total: number; items: Item[]; readinessHash: string };
  openItems?: OpenItem[]; doneCount?: number; completionHash?: string; futureSprints?: Array<{ id: string; name: string }>;
};
type Reply = { success: boolean; error?: string; reason?: string; operationId?: string; state?: string };

const CODE_LENGTH = 6;
const POLL_MS = 2000;

function defaultEnd(sprint: Sprint | undefined): string {
  const parsed = sprint?.endDate ? Date.parse(sprint.endDate) : NaN;
  const end = Number.isFinite(parsed) && parsed > Date.now() ? new Date(parsed) : new Date(Date.now() + 14 * 86400000);
  return end.toISOString().slice(0, 10);
}

export default function SprintReadiness() {
  const [data, setData] = useState<Readiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [code, setCode] = useState('');
  const [affirmed, setAffirmed] = useState(false);
  const [endDate, setEndDate] = useState('');
  const [destination, setDestination] = useState('');
  const [operation, setOperation] = useState<{ id: string; state: string } | null>(null);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const seq = ++sequence.current;
    setLoading(true); setError('');
    try {
      const reply = await invoke<Readiness>('sprint:getReadiness');
      if (seq !== sequence.current) return;
      setData(reply);
      if (!reply.success) setError(reply.error ?? 'Readiness could not be checked.');
      else { setEndDate(defaultEnd(reply.sprint)); setCode(''); setAffirmed(false); }
    } catch (e) { if (seq === sequence.current) setError(errorMessage(e)); }
    finally { if (seq === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => { void load(); return () => { ++sequence.current; }; }, [load]);

  useEffect(() => {
    if (!operation || ['DONE', 'FAILED'].includes(operation.state)) return;
    const timer = setTimeout(async () => {
      try {
        const reply = await invoke<Reply & { error?: string | null }>('sprint:operation', { operationId: operation.id });
        if (!reply.success) { setError(reply.error ?? 'Progress could not be read.'); return; }
        setOperation({ id: operation.id, state: reply.state ?? 'QUEUED' });
        if (reply.state === 'DONE') { setMessage('Sprint completed. The open work items were moved and the sprint is closed.'); }
        if (reply.state === 'FAILED') setError(reply.error ?? 'The completion did not finish. Nothing more will happen; check the sprint and sign again.');
      } catch (e) { setError(errorMessage(e)); }
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [operation]);

  async function start() {
    if (!data?.assessment || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const reply = await invoke<Reply>('sprint:start', { code, readinessHash: data.assessment.readinessHash,
        endDate: new Date(`${endDate}T23:59:00`).toISOString() });
      if (!reply.success) { setError(reply.error ?? 'The sprint was not started.'); setCode(''); if (reply.reason === 'CONTENT_CHANGED' || reply.reason === 'NOT_READY') await load(); return; }
      setMessage('Signed. The sprint has started.');
      await load();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  async function complete() {
    if (!data?.completionHash || busy || !destination) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const target = destination === 'backlog' ? { type: 'backlog' } : { type: 'sprint', sprintId: destination };
      const reply = await invoke<Reply>('sprint:complete', { code, destination: target, completionHash: data.completionHash });
      if (!reply.success) { setError(reply.error ?? 'The sprint was not completed.'); setCode(''); if (reply.reason === 'CONTENT_CHANGED') await load(); return; }
      setMessage('Signed. Moving the open work items and closing the sprint…');
      setOperation({ id: reply.operationId ?? '', state: reply.state ?? 'QUEUED' });
      setCode('');
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  if (loading && !data) return <Loading label="Checking this sprint…" />;
  const sprint = data?.sprint;
  const header = (
    <Facts items={[
      { label: 'Sprint', value: sprint?.name ?? 'Unknown sprint' },
      { label: 'State', value: <Badge tone={sprint?.state === 'active' ? 'brand' : 'neutral'}>{sprint?.state === 'active' ? 'Running' : sprint?.state === 'future' ? 'Not started' : sprint?.state ?? 'Unknown'}</Badge> },
      ...(sprint?.goal ? [{ label: 'Goal', value: sprint.goal }] : [])
    ]} />
  );
  const roleNote = data?.success && !data.canSign
    ? <Notice>You can see readiness, but signing needs the "{data.role}" role for this project. A VAtlassian administrator grants it under Approver roles, for all work item types.</Notice>
    : null;
  const signBox = (label: string, onSign: () => void, extraReady: boolean) => (
    <Card title="Sign">
      <div className="va-stack">
        <Affirmation checked={affirmed} onChange={setAffirmed} disabled={busy}>{data?.meaning}</Affirmation>
        <Field label="Authenticator code" hint="The six-digit code from your authenticator app.">
          <CodeInput value={code} onChange={setCode} onSubmit={onSign} disabled={busy || !affirmed} />
        </Field>
        <div><Button appearance="primary" isDisabled={busy || !affirmed || code.length !== CODE_LENGTH || !extraReady} onClick={onSign}>{busy ? 'Signing…' : label}</Button></div>
      </div>
    </Card>
  );

  return (
    <Page title="Start Sprint" lead="Sprints start and complete only under signature, and start only when every work item's tree is baselined with no undecided changes."
      actions={<Button isDisabled={busy || loading} onClick={() => void load()}>Check readiness</Button>}>
      <div className="va-stack">
        {error && <Notice danger>{error}</Notice>}
        {message && <Notice>{message}</Notice>}
        {data?.success && header}
        {roleNote}

        {data?.success && sprint?.state === 'future' && data.assessment && <>
          {data.assessment.empty ? <EmptyState title="This sprint has no work items">Add work items before starting it.</EmptyState> : <>
            <Notice danger={!data.assessment.ready}>
              {data.assessment.ready
                ? `All ${data.assessment.total} work items are ready.`
                : `${data.assessment.readyCount} of ${data.assessment.total} work items are ready. The sprint cannot start until every one is.`}
            </Notice>
            <Card title="Work items" flush>
              <Table columns={[{ key: 'item', label: 'Work item' }, { key: 'tree', label: 'Tree' }, { key: 'state', label: 'Readiness' }]}>
                {data.assessment.items.map(item => (
                  <tr key={item.issueId}>
                    <td><IssueLink issueKey={item.issueKey} summary={item.summary} /></td>
                    <td>{item.treeSize === 1 ? '1 item' : `${item.treeSize} items`}</td>
                    <td>{item.ready ? <Badge tone="success">Ready</Badge> : <div className="va-stack va-stack--tight">
                      <Badge tone="danger">Not ready</Badge>
                      {item.reasons.map((r, i) => <span key={i} className="va-hint">{r.issueKey} {REASON_TEXT[r.code] ?? r.code}</span>)}
                    </div>}</td>
                  </tr>
                ))}
              </Table>
            </Card>
          </>}
          {data.assessment.ready && data.canSign && <>
            <Field label="End date"><input className="va-input" type="date" value={endDate} min={new Date().toISOString().slice(0, 10)} disabled={busy} onChange={e => setEndDate(e.target.value)} /></Field>
            {signBox('Sign and start sprint', () => void start(), Boolean(endDate))}
          </>}
        </>}

        {data?.success && sprint?.state === 'active' && <>
          <Card title="Open work items" flush>
            {!data.openItems?.length ? <p style={{ padding: '0 16px' }}>Every work item is done.</p> : (
              <Table columns={[{ key: 'item', label: 'Work item' }, { key: 'status', label: 'Status' }]}>
                {data.openItems.map(item => <tr key={item.id}><td><IssueLink issueKey={item.key} summary={item.summary} /></td><td>{item.status}</td></tr>)}
              </Table>
            )}
            <p className="va-muted" style={{ padding: '0 16px' }}>{data.doneCount ?? 0} done work items stay with this sprint.</p>
          </Card>
          {data.canSign && !operation && <>
            <Field label="Move open work items to">
              <Select value={destination} onChange={setDestination} disabled={busy} placeholder="Choose where they go"
                options={[{ value: 'backlog', label: 'Backlog' }, ...(data.futureSprints ?? []).map(s => ({ value: s.id, label: s.name }))]} />
            </Field>
            {signBox('Sign and complete sprint', () => void complete(), Boolean(destination))}
          </>}
          {operation && !['DONE', 'FAILED'].includes(operation.state) && <Loading label="Moving open work items and closing the sprint…" />}
        </>}

        {data?.success && sprint && !['future', 'active'].includes(sprint.state) && <Notice>This sprint is closed.</Notice>}
      </div>
    </Page>
  );
}
