import { useState, useEffect, useRef, useMemo } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import Textfield from '@atlaskit/textfield';

import {
  Badge, Card, EmptyState, Facts, Field, Name, Page, ProjectLink, Section, Select, StatusFlow, Table
} from '../../ui/primitives';
import { AssuranceChip } from '../../ui/feedback';
import type { AssuranceLevel } from '../../lib/assurance';
import { CONTROLLED_TRANSITION_ASSURANCE_OPTIONS } from '../../lib/assurance';
import { assertResult, errorMessage } from '../../lib/result';
import { formatDate } from '../../ui/format';
import { useConfigurationUpdates } from '../../lib/configurationUpdates';

type Project = { id: string; key: string; name: string };
type IssueType = { id: string; name: string };
type Status = { id: string; name: string };

type WorkflowTransition = {
  transitionId: string;
  name: string;
  fromStatusId: string;
  fromStatusName: string | null;
  toStatusId: string;
  toStatusName: string | null;
  global: boolean;
  hasScreen: boolean;
  validatorAttached: boolean;
  jiraRules: {
    conditions: boolean;
    otherValidators: number;
    postFunctions: number;
  };
};

const optionKey = (t: WorkflowTransition) =>
  `${t.transitionId}:${t.fromStatusId}`;

type ControlledTransition = {
  ctId: string;
  revision?: string;
  projectId: string;
  issueTypeId: string;
  transitionId: string | null;
  fromStatusId: string;
  toStatusId: string;
  rejectToStatusId?: string;
  requireDecision?: boolean;
  requiredAssurance: AssuranceLevel;
  captureBaseline: boolean;
  projectKey: string | null;
  projectName: string | null;
  issueTypeName: string | null;
  fromStatusName: string | null;
  toStatusName: string | null;
  rejectConfigured: boolean;
  rejectToStatusName: string | null;
  requiredRole: string;
  meaning: string;
  createdAt: number | null;
  createdByName: string | null;
};

const COLUMNS = [
  { key: 'scope', label: 'Applies to' },
  { key: 'transition', label: 'Transition' },
  { key: 'meaning', label: 'Signature means' },
  { key: 'role', label: 'Signed by' },
  { key: 'reject', label: 'If declined' },
  { key: 'actions', label: '', align: 'right' as const }
];

// The filter represents a workflow edge (from-status to to-status), not an
// individual Jira transition id. Jira can expose more than one action for the
// same edge; those must appear only once in the filter dropdown.
function ruleFilterTransitionKey(rule: ControlledTransition) {
  return `${rule.fromStatusId}:${rule.toStatusId}`;
}

// One status-to-status edge offered by the transition filter. It comes from the
// live Jira workflow and/or from a saved rule, so an edge that has no rule yet
// (for example In Progress -> Done) is still listed.
type FilterEdge = {
  key: string;
  fromStatusName: string | null;
  toStatusName: string | null;
  hasRule: boolean;
};

// Lifecycle order of the common workflow, matching the "Exact transition"
// dropdown: To Do / Backlog -> Selected for development -> In Progress ->
// Code Review -> Testing -> Done.
// Statuses not listed here come after the known ones, in name order.
const STATUS_ORDER: Record<string, number> = {
  'to do': 0,
  backlog: 0,
  'selected for development': 1,
  'in progress': 2,
  'code review': 3,
  testing: 4,
  done: 5
};
const UNKNOWN_RANK = 100;

function normaliseStatusName(value: string | null | undefined) {
  return (value ?? '').trim().toLocaleLowerCase();
}

function compareWorkflowEdges(
  a: { fromStatusName: string | null; toStatusName: string | null },
  b: { fromStatusName: string | null; toStatusName: string | null }
) {
  const aFrom = normaliseStatusName(a.fromStatusName);
  const bFrom = normaliseStatusName(b.fromStatusName);
  const aTo = normaliseStatusName(a.toStatusName);
  const bTo = normaliseStatusName(b.toStatusName);

  const aFromRank = STATUS_ORDER[aFrom] ?? UNKNOWN_RANK;
  const bFromRank = STATUS_ORDER[bFrom] ?? UNKNOWN_RANK;
  if (aFromRank !== bFromRank) return aFromRank - bFromRank;
  if (aFromRank === UNKNOWN_RANK && aFrom !== bFrom) return aFrom.localeCompare(bFrom);

  const aToRank = STATUS_ORDER[aTo] ?? UNKNOWN_RANK;
  const bToRank = STATUS_ORDER[bTo] ?? UNKNOWN_RANK;
  if (aToRank !== bToRank) return aToRank - bToRank;
  return aTo.localeCompare(bTo);
}

// A stable position for every distinct edge among the given rules, so the
// dropdown and the table list transitions in lifecycle order.
function getWorkflowEdgeOrder(rules: ControlledTransition[]) {
  const edges = new Map<string, {
    fromStatusName: string | null;
    toStatusName: string | null;
  }>();

  for (const rule of rules) {
    const key = ruleFilterTransitionKey(rule);
    if (!edges.has(key)) {
      edges.set(key, {
        fromStatusName: rule.fromStatusName,
        toStatusName: rule.toStatusName
      });
    }
  }

  const ordered = Array.from(edges.entries()).sort((a, b) =>
    compareWorkflowEdges(a[1], b[1])
  );

  const order = new Map<string, number>();
  ordered.forEach(([key], index) => { order.set(key, index); });
  return order;
}

export default function TransitionsPage({
  projects
}: {
  projects: Project[];
}) {
  const [editing, setEditing] = useState<ControlledTransition | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [rolesRefresh, setRolesRefresh] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [message, setMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const [transitions, setTransitions] = useState<ControlledTransition[]>([]);
  const [issueTypes, setIssueTypes] = useState<IssueType[]>([]);
  const [projectStatuses, setProjectStatuses] = useState<Status[]>([]);

  const [projectId, setProjectId] = useState('');
  const [issueTypeId, setIssueTypeId] = useState('');

  const [workflowTransitions, setWorkflowTransitions] =
    useState<WorkflowTransition[]>([]);

  const [discovery, setDiscovery] = useState<
    'idle' | 'loading' | 'loaded' | 'error'
  >('idle');

  const [selectedKey, setSelectedKey] = useState('');

  const discoverySeq = useRef(0);
  const statusSeq = useRef(0);
  const listSequence = useRef(0);

  const [role, setRole] = useState('');
  const [meaning, setMeaning] = useState('');
  const [requiredAssurance, setAssurance] =
    useState<AssuranceLevel>('ESIGNATURE');
  const [captureBaseline, setCapture] = useState(true);
  const [rejectStatus, setRejectStatus] = useState('');
  const [availableRoles, setAvailableRoles] = useState<string[]>([]);

  // Active-rules filters. Independent of the Add/Edit rule form.
  // An empty value means "all". Each filter narrows the next one: the work
  // item type list belongs to the chosen project, and the transition filter
  // only unlocks once a specific work item type is chosen.
  const [filterProjectId, setFilterProjectId] = useState('');
  const [filterIssueTypeId, setFilterIssueTypeId] = useState('');
  const [filterTransitionKey, setFilterTransitionKey] = useState('');
  // The live workflow edges of the chosen type, so the transition filter lists
  // every transition, not only those that already have a rule.
  const [liveEdges, setLiveEdges] = useState<FilterEdge[]>([]);
  const [liveEdgesState, setLiveEdgesState] = useState<
    'idle' | 'loading' | 'loaded' | 'error'
  >('idle');
  const liveEdgesSeq = useRef(0);

  const loadTransitions = async (quiet?: unknown) => {
    const background = quiet === true;
    const seq = ++listSequence.current;

    if (!background) {
      setLoading(true);
      setLoaded(false);
      setTransitions([]);
    }

    try {
      const response = await invoke('admin:listControlledTransitions') as {
        success: boolean;
        transitions?: ControlledTransition[];
        error?: string;
      };

      if (seq !== listSequence.current) return;

      if (response.success) {
        setTransitions(response.transitions ?? []);
        setLoaded(true);
      } else if (!background) {
        setMessage({
          type: 'error',
          text: response.error || 'Failed to load controlled transitions.'
        });
      }
    } catch (err: any) {
      if (seq !== listSequence.current || background) return;

      setMessage({
        type: 'error',
        text: err.message || 'Failed to load data.'
      });
    } finally {
      if (seq === listSequence.current && !background) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadTransitions();

    return () => {
      ++listSequence.current;
    };
  }, []);

  useConfigurationUpdates(() => {
    if (!saving) {
      setRolesRefresh(v => v + 1);
      return loadTransitions(!loading);
    }
  });

  // Load project statuses and issue types.
  useEffect(() => {
    let active = true;
    const seq = ++statusSeq.current;

    if (!projectId) {
      setIssueTypes([]);
      setProjectStatuses([]);

      return () => {
        active = false;
      };
    }

    setIssueTypes([]);
    setProjectStatuses([]);

    invoke('admin:listStatusesForProject', {
      projectId,
      issueTypeId: ''
    })
      .then((r: any) => {
        assertResult(r);

        if (active && seq === statusSeq.current) {
          setProjectStatuses(r.statuses ?? []);
        }
      })
      .catch(e => {
        if (active) {
          setMessage({
            type: 'error',
            text: errorMessage(e)
          });
        }
      });

    invoke('admin:listIssueTypesForProject', { projectId })
      .then((r: any) => {
        assertResult(r);

        if (active) {
          setIssueTypes(r.issueTypes ?? []);
        }
      })
      .catch(e => {
        if (active) {
          setMessage({
            type: 'error',
            text: errorMessage(e)
          });
        }
      });

    return () => {
      active = false;
    };
  }, [projectId, refresh]);

  useEffect(() => {
    let active = true;

    if (!projectId) {
      ++statusSeq.current;
      setProjectStatuses([]);

      return () => {
        active = false;
      };
    }

    if (!issueTypeId) {
      return () => {
        active = false;
      };
    }

    const seq = ++statusSeq.current;
    setProjectStatuses([]);

    invoke('admin:listStatusesForProject', {
      projectId,
      issueTypeId
    })
      .then((r: any) => {
        assertResult(r);

        if (active && seq === statusSeq.current) {
          setProjectStatuses(r.statuses ?? []);
        }
      })
      .catch(e => {
        if (active) {
          setMessage({
            type: 'error',
            text: errorMessage(e)
          });
        }
      });

    return () => {
      active = false;
    };
  }, [projectId, issueTypeId, refresh, editing]);

  // Load eligible approver roles.
  useEffect(() => {
    let active = true;

    if (!projectId || !issueTypeId) {
      setAvailableRoles([]);
      setRole('');

      return () => {
        active = false;
      };
    }

    setAvailableRoles([]);

    invoke('admin:listAvailableRoles', {
      projectId,
      issueTypeId
    })
      .then((r: any) => {
        if (!active) return;

        assertResult(r);

        if (r.success) {
          const roles = r.roles ?? [];
          setAvailableRoles(roles);

          setRole(cur => {
            const next = editing?.requiredRole ?? cur;
            return roles.includes(next) ? next : '';
          });
        }
      })
      .catch(e => {
        if (active) {
          setMessage({
            type: 'error',
            text: errorMessage(e)
          });
        }
      });

    return () => {
      active = false;
    };
  }, [projectId, issueTypeId, refresh, rolesRefresh, editing]);

  // Discover exact live Jira transitions.
  useEffect(() => {
    const seq = ++discoverySeq.current;

    setSelectedKey('');
    setWorkflowTransitions([]);

    if (!projectId || !issueTypeId) {
      setDiscovery('idle');
      return;
    }

    setDiscovery('loading');

    invoke('admin:listWorkflowTransitions', {
      projectId,
      issueTypeId
    })
      .then((r: any) => {
        if (discoverySeq.current !== seq) return;

        if (r.success) {
          setWorkflowTransitions(r.transitions ?? []);
          setDiscovery('loaded');

          if (
            editing &&
            editing.projectId === projectId &&
            editing.issueTypeId === issueTypeId
          ) {
            setSelectedKey(
              `${editing.transitionId}:${editing.fromStatusId}`
            );
          }
        } else {
          setDiscovery('error');

          setMessage({
            type: 'error',
            text: r.error || 'Could not read the live Jira workflow.'
          });
        }
      })
      .catch((err: any) => {
        if (discoverySeq.current !== seq) return;

        setDiscovery('error');

        setMessage({
          type: 'error',
          text: err.message || 'Could not read the live Jira workflow.'
        });
      });

    return () => {
      if (discoverySeq.current === seq) {
        ++discoverySeq.current;
      }
    };
  }, [projectId, issueTypeId, refresh, editing]);

  const selectedTransition =
    workflowTransitions.find(t => optionKey(t) === selectedKey) ?? null;

  const controls = (
    rule: ControlledTransition,
    transition: WorkflowTransition
  ) =>
    rule.projectId === projectId &&
    rule.issueTypeId === issueTypeId &&
    String(rule.transitionId) === String(transition.transitionId) &&
    String(rule.fromStatusId) === String(transition.fromStatusId) &&
    String(rule.toStatusId) === String(transition.toStatusId);

  const existingRule = selectedTransition
    ? transitions.find(
        rule =>
          rule.ctId !== editing?.ctId &&
          controls(rule, selectedTransition)
      ) ?? null
    : null;

  const allTransitionsAlreadyControlled =
    discovery === 'loaded' &&
    workflowTransitions.length > 0 &&
    workflowTransitions.every(transition =>
      transitions.some(rule => controls(rule, transition))
    );

  const blockingFinding =
    selectedTransition != null &&
    !selectedTransition.validatorAttached;

  // The "Exact transition" dropdown, in lifecycle order.
  const transitionOptions = useMemo(() => {
    const unique = new Map<string, WorkflowTransition>();
    for (const transition of workflowTransitions) {
      const key = optionKey(transition);
      if (!unique.has(key)) unique.set(key, transition);
    }

    return Array.from(unique.values())
      .sort((a, b) => compareWorkflowEdges(a, b))
      .map(transition => ({
        value: optionKey(transition),
        label: `${transition.global ? 'Any status' : transition.fromStatusName} -> ${transition.toStatusName} - ${transition.name} (#${transition.transitionId})`
      }));
  }, [workflowTransitions]);

  const statusOptions = projectStatuses.map(s => ({
    value: s.id,
    label: s.name
  }));

  const complete = Boolean(
    projectId &&
    issueTypeId &&
    selectedTransition &&
    role.trim() &&
    meaning.trim()
  );

  const canSave =
    loaded &&
    complete &&
    discovery === 'loaded' &&
    !blockingFinding &&
    !existingRule &&
    availableRoles.includes(role) &&
    (!rejectStatus ||
      projectStatuses.some(s => s.id === rejectStatus));

  // ── Active-rules filters ───────────────────────────────────────────────
  // The Select component shows its own placeholder as the first, empty choice
  // ("All work item types" / "All transitions"). The option lists below must
  // therefore hold only the real choices, or the "All" entry appears twice.

  // Step 1: the projects that have at least one saved rule.
  const filterProjectOptions = useMemo(() => {
    const unique = new Map<string, string>();

    transitions.forEach(rule => {
      if (rule.projectId && !unique.has(rule.projectId)) {
        unique.set(
          rule.projectId,
          rule.projectName || rule.projectKey || 'Unknown project'
        );
      }
    });

    return Array.from(unique.entries())
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => ({ value, label }));
  }, [transitions]);

  // Step 2: the work item types of the chosen project that have at least one
  // saved rule. Each project has its own work item types.
  const filterIssueTypeOptions = useMemo(() => {
    const unique = new Map<string, string>();

    transitions.forEach(rule => {
      if (!filterProjectId || rule.projectId !== filterProjectId) return;
      if (rule.issueTypeId) {
        unique.set(
          rule.issueTypeId,
          rule.issueTypeName || 'Unknown work item type'
        );
      }
    });

    return Array.from(unique.entries())
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => ({ value, label }));
  }, [transitions, filterProjectId]);

  // The projects that own rules of the chosen type, as a stable string so the
  // live workflow is read again only when that set really changes (not on every
  // background refresh of the rules). With a project chosen, only that project's
  // workflow is read.
  const filterProjectIdsKey = useMemo(() => {
    if (!filterIssueTypeId) return '';
    if (filterProjectId) return filterProjectId;
    return Array.from(new Set(
      transitions
        .filter(rule => rule.issueTypeId === filterIssueTypeId)
        .map(rule => rule.projectId)
    )).sort().join(',');
  }, [transitions, filterIssueTypeId, filterProjectId]);

  // Read the live Jira workflow of the chosen type, so the transition filter
  // offers every transition (Backlog -> Selected for development,
  // Selected for development -> In Progress, In Progress -> Done, ...), not
  // only those that already have a rule.
  useEffect(() => {
    const seq = ++liveEdgesSeq.current;
    setLiveEdges([]);

    if (!filterIssueTypeId || !filterProjectIdsKey) {
      setLiveEdgesState('idle');
      return;
    }

    setLiveEdgesState('loading');

    Promise.all(
      filterProjectIdsKey.split(',').map(projectIdForType =>
        invoke('admin:listWorkflowTransitions', {
          projectId: projectIdForType,
          issueTypeId: filterIssueTypeId
        })
      )
    )
      .then(results => {
        if (liveEdgesSeq.current !== seq) return;

        const edges = new Map<string, FilterEdge>();
        for (const result of results as any[]) {
          if (!result?.success) continue;
          for (const t of (result.transitions ?? []) as WorkflowTransition[]) {
            const key = `${t.fromStatusId}:${t.toStatusId}`;
            if (!edges.has(key)) {
              edges.set(key, {
                key,
                fromStatusName: t.global ? null : t.fromStatusName,
                toStatusName: t.toStatusName,
                hasRule: false
              });
            }
          }
        }

        setLiveEdges(Array.from(edges.values()));
        setLiveEdgesState('loaded');
      })
      .catch(() => {
        if (liveEdgesSeq.current === seq) setLiveEdgesState('error');
      });

    return () => {
      if (liveEdgesSeq.current === seq) ++liveEdgesSeq.current;
    };
  }, [filterIssueTypeId, filterProjectIdsKey]);

  // Step 2: every transition of the chosen type, one per workflow edge, in
  // lifecycle order. An edge that has no rule yet is marked as such. Empty
  // until a type is chosen. If the live workflow cannot be read, the edges that
  // already have rules are still offered.
  const filterTransitionOptions = useMemo(() => {
    if (!filterIssueTypeId) return [];

    const edges = new Map<string, FilterEdge>();
    for (const edge of liveEdges) edges.set(edge.key, { ...edge, hasRule: false });

    for (const rule of transitions) {
      if (rule.issueTypeId !== filterIssueTypeId) continue;
      if (filterProjectId && rule.projectId !== filterProjectId) continue;
      const key = ruleFilterTransitionKey(rule);
      const existing = edges.get(key);
      edges.set(key, existing
        ? { ...existing, hasRule: true }
        : {
            key,
            fromStatusName: rule.fromStatusName,
            toStatusName: rule.toStatusName,
            hasRule: true
          });
    }

    return Array.from(edges.values())
      .sort((a, b) => compareWorkflowEdges(a, b) || a.key.localeCompare(b.key))
      .map(edge => ({
        value: edge.key,
        label: `${edge.fromStatusName || 'Any status'} → ${edge.toStatusName || 'Unknown status'}${edge.hasRule ? '' : ' (no rule yet)'}`
      }));
  }, [transitions, filterIssueTypeId, filterProjectId, liveEdges]);

  // Choosing a different project clears the work item type and transition
  // below it, because they belong to the old project.
  const handleFilterProjectChange = (value: string) => {
    setFilterProjectId(value);
    setFilterIssueTypeId('');
    setFilterTransitionKey('');
  };

  // Choosing a different work item type always clears the old transition.
  const handleFilterIssueTypeChange = (value: string) => {
    setFilterIssueTypeId(value);
    setFilterTransitionKey('');
  };

  // If a refresh removes the rules a filter pointed at, fall back to "all"
  // rather than showing an empty table behind a choice nobody can see.
  useEffect(() => {
    if (!loaded) return;
    if (
      filterProjectId &&
      !filterProjectOptions.some(option => option.value === filterProjectId)
    ) {
      setFilterProjectId('');
      setFilterIssueTypeId('');
      setFilterTransitionKey('');
      return;
    }
    if (
      filterIssueTypeId &&
      !filterIssueTypeOptions.some(option => option.value === filterIssueTypeId)
    ) {
      setFilterIssueTypeId('');
      setFilterTransitionKey('');
      return;
    }
    if (
      filterTransitionKey &&
      liveEdgesState !== 'loading' &&
      !filterTransitionOptions.some(option => option.value === filterTransitionKey)
    ) {
      setFilterTransitionKey('');
    }
  }, [
    loaded,
    filterProjectId,
    filterIssueTypeId,
    filterTransitionKey,
    filterProjectOptions,
    filterIssueTypeOptions,
    filterTransitionOptions,
    liveEdgesState
  ]);

  // The table: filtered, then ordered by work item type and, within a type,
  // by workflow lifecycle order.
  const filteredTransitions = useMemo(() => {
    const edgeOrdersByType = new Map<string, Map<string, number>>();
    for (const rule of transitions) {
      if (!edgeOrdersByType.has(rule.issueTypeId)) {
        edgeOrdersByType.set(
          rule.issueTypeId,
          getWorkflowEdgeOrder(
            transitions.filter(item => item.issueTypeId === rule.issueTypeId)
          )
        );
      }
    }

    return transitions
      .filter(rule => {
        const matchesProject =
          !filterProjectId || rule.projectId === filterProjectId;
        const matchesIssueType =
          !filterIssueTypeId || rule.issueTypeId === filterIssueTypeId;
        const matchesTransition =
          !filterTransitionKey ||
          ruleFilterTransitionKey(rule) === filterTransitionKey;
        return matchesProject && matchesIssueType && matchesTransition;
      })
      .sort((a, b) => {
        const typeCompare = (a.issueTypeName ?? '').localeCompare(b.issueTypeName ?? '');
        if (typeCompare !== 0) return typeCompare;

        const edgeOrder = edgeOrdersByType.get(a.issueTypeId);
        const edgeCompare =
          (edgeOrder?.get(ruleFilterTransitionKey(a)) ?? Number.MAX_SAFE_INTEGER) -
          (edgeOrder?.get(ruleFilterTransitionKey(b)) ?? Number.MAX_SAFE_INTEGER);
        if (edgeCompare !== 0) return edgeCompare;

        return a.meaning.localeCompare(b.meaning) || a.ctId.localeCompare(b.ctId);
      });
  }, [transitions, filterProjectId, filterIssueTypeId, filterTransitionKey]);

  const filtersActive = Boolean(
    filterProjectId || filterIssueTypeId || filterTransitionKey
  );

  const clearFilters = () => {
    setFilterProjectId('');
    setFilterIssueTypeId('');
    setFilterTransitionKey('');
  };

  const handleCreate = async () => {
    setMessage(null);

    if (!canSave || !selectedTransition) {
      setMessage({
        type: 'error',
        text: 'Choose a project, type, an exact transition, a role and a meaning.'
      });
      return;
    }

    setSaving(true);

    try {
      const result = await invoke(
        editing
          ? 'admin:updateControlledTransition'
          : 'admin:createControlledTransition',
        {
          ...(editing
            ? {
                ctId: editing.ctId,
                expectedRevision: editing.revision,
                requireDecision: editing.requireDecision ?? false
              }
            : {}),
          projectId,
          issueTypeId,
          transitionId: selectedTransition.transitionId,
          fromStatusId: selectedTransition.fromStatusId,
          toStatusId: selectedTransition.toStatusId,
          requiredAssurance,
          captureBaseline,
          requiredRole: role.trim(),
          meaning: meaning.trim(),
          rejectToStatusId: rejectStatus || null
        }
      ) as {
        success: boolean;
        error?: string;
        note?: string;
      };

      if (result.success) {
        const project = projects.find(p => p.id === projectId);

        setMessage({
          type: 'success',
          text: `Rule ${editing ? 'updated' : 'added'}; approval required${project ? ` in ${project.name}` : ''} for "${meaning.trim()}".${result.note ? ` ${result.note}` : ''}`
        });

        setEditing(null);
        setRole('');
        setMeaning('');
        setRejectStatus('');
        setSelectedKey('');

        await loadTransitions();
      } else {
        setMessage({
          type: 'error',
          text: result.error || 'Failed to add the rule.'
        });
      }
    } catch (err: any) {
      setMessage({
        type: 'error',
        text: err.message || 'Failed to add the rule.'
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRevoke = async (rule: ControlledTransition) => {
    if (saving) return;

    setSaving(true);
    setMessage(null);

    try {
      assertResult(
        await invoke('admin:revokeControlledTransition', {
          ctId: rule.ctId,
          expectedRevision: rule.revision
        }) as any
      );

      if (editing?.ctId === rule.ctId) {
        setEditing(null);
      }

      await loadTransitions();
    } catch (e) {
      setMessage({
        type: 'error',
        text: errorMessage(e)
      });
    } finally {
      setSaving(false);
    }
  };

  const edit = (rule: ControlledTransition) => {
    setEditing(rule);
    setMessage(null);
    setProjectId(rule.projectId);
    setIssueTypeId(rule.issueTypeId);
    setMeaning(rule.meaning);
    setRole(rule.requiredRole);
    setAssurance(rule.requiredAssurance);
    setCapture(rule.captureBaseline);
    setRejectStatus(rule.rejectToStatusId ?? '');
    setSelectedKey(`${rule.transitionId}:${rule.fromStatusId}`);
  };

  return (
    <Page
      eyebrow="Setup"
      title="Controlled transitions"
      actions={
        <Button
          isDisabled={saving || loading}
          onClick={() => {
            setRefresh(v => v + 1);
            void loadTransitions();
          }}
        >
          Refresh rules and roles
        </Button>
      }
    >
      {message && (
        <div style={{ marginBottom: '20px' }}>
          <SectionMessage appearance={message.type}>
            <p>{message.text}</p>

            {message.type === 'error' && (
              <Button
                isDisabled={saving}
                onClick={() => {
                  setMessage(null);
                  setRefresh(v => v + 1);
                  void loadTransitions();
                }}
              >
                Retry loading configuration
              </Button>
            )}
          </SectionMessage>
        </div>
      )}

      <Card
        title={editing ? 'Edit controlled transition' : 'Require an approval'}
        subtitle="Company-managed projects only. Team-managed projects cannot express segregation of duties."
      >
        <fieldset
          disabled={saving}
          style={{
            border: 0,
            padding: 0,
            margin: 0,
            minWidth: 0
          }}
        >
          <div className="va-form-grid">
            <Field label="Project">
              <Select
                placeholder="Choose a project…"
                value={projectId}
                onChange={value => {
                  setRole('');
                  setProjectId(value);
                  setIssueTypeId('');
                  setRejectStatus('');
                }}
                options={projects.map(p => ({
                  value: p.id,
                  label: p.name
                }))}
              />
            </Field>

            <Field label="Work item type">
              <Select
                placeholder="Choose a type…"
                value={issueTypeId}
                disabled={!projectId}
                onChange={value => {
                  setIssueTypeId(value);
                  setRejectStatus('');
                }}
                options={issueTypes.map(t => ({
                  value: t.id,
                  label: t.name
                }))}
              />
            </Field>

            <Field
              label="Exact transition"
              hint={
                discovery === 'loading'
                  ? 'Reading the live Jira workflow…'
                  : discovery === 'error'
                    ? 'Could not read the live Jira workflow.'
                    : discovery === 'loaded' &&
                        transitionOptions.length === 0
                      ? 'This workflow has no controllable transitions.'
                      : "Read the exact transition from Jira's live workflow."
              }
            >
              <Select
                placeholder="Choose the exact transition…"
                value={selectedKey}
                disabled={!issueTypeId || discovery !== 'loaded'}
                onChange={setSelectedKey}
                options={transitionOptions}
              />
            </Field>
          </div>

          {allTransitionsAlreadyControlled && !editing && (
            <SectionMessage appearance="information">
              <p>
                All transitions in this workflow already have approval
                rules. Edit an existing rule below to change its requirements.
              </p>
            </SectionMessage>
          )}

          {selectedTransition && (
            <div style={{ marginTop: '12px' }}>
              <Facts
                items={[
                  {
                    label: 'Has a transition screen',
                    value: selectedTransition.hasScreen ? 'Yes' : 'No'
                  },
                  {
                    label: 'Signature validator',
                    value: selectedTransition.validatorAttached
                      ? 'Attached and enabled'
                      : (
                          <span className="va-unknown">
                            Not attached. This edge cannot be enforced yet
                          </span>
                        )
                  },
                  {
                    label: 'Other Jira rules on this edge',
                    value:
                      `${selectedTransition.jiraRules.otherValidators} other validator(s), ${selectedTransition.jiraRules.postFunctions} post function(s)` +
                      (selectedTransition.jiraRules.conditions
                        ? ', has conditions'
                        : '')
                  },
                  ...(existingRule
                    ? [
                        {
                          label: 'Approval rule',
                          value: (
                            <span className="va-unknown">
                              This transition already has an approval rule.
                              Edit its existing rule below.
                            </span>
                          )
                        }
                      ]
                    : [])
                ]}
              />
            </div>
          )}

          <div
            className="va-form-grid va-form-grid--wide"
            style={{ marginTop: '16px' }}
          >
            <Field
              label="Who must sign"
              hint="Roles defined in Approver roles. Create a grant there first to add new roles."
            >
              <Select
                placeholder="Choose a role…"
                value={role}
                onChange={setRole}
                disabled={!projectId || !issueTypeId}
                options={availableRoles.map(r => ({
                  value: r,
                  label: r
                }))}
              />
            </Field>

            <Field
              label="What the signature means"
              hint="Shown to the signer as the statement they are attesting to. Write it as a declaration."
            >
              <Textfield
                placeholder="Approved for release"
                value={meaning}
                maxLength={32}
                onChange={(e: any) => setMeaning(e.target.value)}
              />
            </Field>

            <Field
              label="If declined, send back to"
              hint="Optional. Leave empty to leave a declined work item exactly where it is."
            >
              <Select
                placeholder="Stay where it is"
                value={rejectStatus}
                disabled={!issueTypeId}
                onChange={setRejectStatus}
                options={statusOptions}
              />
            </Field>
          </div>

          <div
            className="va-form-grid"
            style={{ marginTop: 16 }}
          >
            <Field
              label="Required assurance"
              hint={
                requiredAssurance === 'BIOMETRIC'
                  ? 'Add the "Biometric Authentication" field to this transition screen.'
                  : 'Add the "Electronic Signature" field to this transition screen.'
              }
            >
              <Select
                value={requiredAssurance}
                onChange={v =>
                  setAssurance(v as AssuranceLevel)
                }
                placeholder="Choose assurance"
                options={CONTROLLED_TRANSITION_ASSURANCE_OPTIONS}
              />
            </Field>

            <Field label="Capture approved baseline">
              <input
                type="checkbox"
                checked={captureBaseline}
                onChange={e => setCapture(e.target.checked)}
              />
            </Field>
          </div>

          <div className="va-form-actions">
            <Button
              appearance="primary"
              onClick={handleCreate}
              isDisabled={saving || !canSave}
            >
              {saving
                ? 'Saving…'
                : editing
                  ? 'Save rule'
                  : 'Add rule'}
            </Button>

            {editing && (
              <Button
                isDisabled={saving}
                onClick={() => {
                  setEditing(null);
                  setSelectedKey('');
                  setRole('');
                  setMeaning('');
                  setRejectStatus('');
                }}
              >
                Cancel edit
              </Button>
            )}

            <span className="va-hint">
              {blockingFinding
                ? 'Attach the signature validator to this transition in Jira before it can be controlled.'
                : existingRule
                  ? 'This transition already has an approval rule. Edit its existing rule below.'
                  : canSave
                    ? 'Takes effect immediately.'
                    : 'Choose a project, type, exact transition, a role and a meaning.'}
            </span>
          </div>
        </fieldset>
      </Card>

      <Section
        title={`Active rules (${filteredTransitions.length}${filtersActive ? ` of ${transitions.length}` : ''})`}
      >
        <Card flush>
          <div
            style={{
              padding: '16px',
              borderBottom: '1px solid var(--ds-border, #DFE1E6)'
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                gap: '16px',
                alignItems: 'start'
              }}
            >
              <Field
                label="Project"
                hint={
                  filterProjectOptions.length === 0
                    ? 'No project has a rule yet.'
                    : 'Start here. Each project has its own work item types.'
                }
              >
                <Select
                  placeholder="All projects"
                  value={filterProjectId}
                  onChange={handleFilterProjectChange}
                  disabled={loading || !loaded}
                  options={filterProjectOptions}
                />
              </Field>

              <Field
                label="Work item type"
                hint={
                  !filterProjectId
                    ? 'Select a project first.'
                    : 'Types of the chosen project.'
                }
              >
                <Select
                  placeholder={
                    filterProjectId ? 'All work item types' : 'Select a project first'
                  }
                  value={filterIssueTypeId}
                  onChange={handleFilterIssueTypeChange}
                  disabled={loading || !loaded || !filterProjectId}
                  options={filterIssueTypeOptions}
                />
              </Field>

              <Field
                label="Transition"
                hint={
                  !filterIssueTypeId
                    ? 'Select a project and a work item type first.'
                    : liveEdgesState === 'loading'
                      ? 'Reading the live Jira workflow…'
                      : liveEdgesState === 'error'
                        ? 'The live workflow could not be read. Only transitions that already have a rule are listed.'
                        : 'Transitions marked "no rule yet" have no approval rule.'
                }
              >
                <Select
                  placeholder={
                    !filterIssueTypeId
                      ? 'Select a work item type first'
                      : liveEdgesState === 'loading'
                        ? 'Loading transitions…'
                        : 'All transitions'
                  }
                  value={filterTransitionKey}
                  onChange={setFilterTransitionKey}
                  disabled={
                    loading ||
                    !loaded ||
                    !filterIssueTypeId ||
                    liveEdgesState === 'loading'
                  }
                  options={filterTransitionOptions}
                />
              </Field>
            </div>

            {filtersActive && (
              <div style={{ marginTop: '8px' }}>
                <Button
                  appearance="subtle"
                  isDisabled={saving}
                  onClick={clearFilters}
                >
                  Clear filters
                </Button>
              </div>
            )}
          </div>

          {loading ? (
            <EmptyState title="Loading rules…" />
          ) : !loaded ? (
            <EmptyState title="Rules are unavailable. Retry loading before making changes." />
          ) : transitions.length === 0 ? (
            <EmptyState title="No transitions are controlled yet">
              Until a rule exists here, no workflow transition requires
              approval and the validator has nothing to enforce.
            </EmptyState>
          ) : filteredTransitions.length === 0 ? (
            filterTransitionKey ? (
              <EmptyState title="No approval rule for this transition yet">
                This transition exists in the workflow but has no approval
                rule. Add one under "Require an approval" above, or clear the
                filters.
              </EmptyState>
            ) : (
              <EmptyState title="No matching rules found">
                No active rules match the selected work item type. Try another
                filter or clear the filters.
              </EmptyState>
            )
          ) : (
            <Table columns={COLUMNS}>
              {filteredTransitions.map(rule => (
                <tr key={rule.ctId}>
                  <td>
                    <div className="va-primary">
                      <ProjectLink
                        projectKey={rule.projectKey}
                        name={rule.projectName}
                      />
                    </div>

                    <div className="va-secondary">
                      <Name
                        value={rule.issueTypeName}
                        noun="work item type"
                      />
                    </div>
                  </td>

                  <td>
                    <StatusFlow
                      from={
                        <Badge tone="neutral">
                          <Name
                            value={rule.fromStatusName}
                            noun="status"
                          />
                        </Badge>
                      }
                      to={
                        <Badge tone="brand">
                          <Name
                            value={rule.toStatusName}
                            noun="status"
                          />
                        </Badge>
                      }
                    />
                  </td>

                  <td>
                    <div className="va-primary">
                      {rule.meaning}
                    </div>

                    <AssuranceChip
                      level={rule.requiredAssurance}
                    />

                    <p className="va-secondary">
                      {rule.captureBaseline
                        ? 'Captures baseline'
                        : 'No baseline capture'}
                    </p>

                    {rule.createdAt != null && (
                      <div className="va-secondary">
                        Added {formatDate(rule.createdAt)}
                        {rule.createdByName
                          ? ` by ${rule.createdByName}`
                          : ''}
                      </div>
                    )}
                  </td>

                  <td>
                    <Badge tone="neutral">
                      {rule.requiredRole}
                    </Badge>
                  </td>

                  <td className="va-muted">
                    {rule.rejectConfigured ? (
                      <StatusFlow
                        from={<span />}
                        to={
                          <Name
                            value={rule.rejectToStatusName}
                            noun="status"
                          />
                        }
                      />
                    ) : (
                      <>
                        Stays at{' '}
                        <Name
                          value={rule.fromStatusName}
                          noun="status"
                        />
                      </>
                    )}
                  </td>

                  <td className="va-table__actions">
                    <Button
                      appearance="subtle"
                      isDisabled={saving}
                      onClick={() => edit(rule)}
                    >
                      Edit
                    </Button>

                    <Button
                      appearance="subtle"
                      isDisabled={saving}
                      onClick={() => handleRevoke(rule)}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </Section>
    </Page>
  );
}