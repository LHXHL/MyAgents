import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  agentDiscoverySchema,
  filterMentionAgents,
} from "../../../../shared/agentDiscovery";
import type { AgentMentionSnapshot } from "../../../../shared/agentMentions";
import type { Thought } from "../../../../shared/types/thought";
import { thoughtListPage, taskCenterAvailable } from "@/api/taskCenter";
import type { PickerPage } from "@/api/pickerPage";
import type {
  FileSearchResult,
  WorkspaceFileService,
} from "@/hooks/useWorkspaceFileService";
import { useAgentNetworkSnapshot } from "@/features/agent-network/store";

export type MentionKind = "agent" | "thought" | "file";
export type MentionItem =
  | { kind: "agent"; key: string; value: AgentMentionSnapshot }
  | { kind: "thought"; key: string; value: Thought }
  | { kind: "file"; key: string; value: FileSearchResult };
export interface MentionGroup {
  kind: MentionKind;
  items: MentionItem[];
  loading: boolean;
  error: boolean;
  unavailable: boolean;
  partial: boolean;
  visibleCount: number;
  cursor: string | null;
}
export type MentionOption =
  | MentionItem
  | {
      kind: "expand" | "collapse" | "retry";
      key: string;
      group: MentionKind;
    };
const ORDER: MentionKind[] = ["agent", "thought", "file"];
const empty = (kind: MentionKind): MentionGroup => ({
  kind,
  items: [],
  loading: true,
  error: false,
  unavailable: false,
  partial: false,
  visibleCount: 5,
  cursor: null,
});
function options(group: MentionGroup): MentionOption[] {
  const result: MentionOption[] = group.items.slice(0, group.visibleCount);
  if (
    (group.error || (group.kind === "agent" && group.partial)) &&
    !group.loading
  )
    result.push({
      kind: "retry",
      key: `${group.kind}:retry`,
      group: group.kind,
    });
  if (
    !group.loading &&
    (group.items.length > group.visibleCount || group.cursor)
  )
    result.push({
      kind: "expand",
      key: `${group.kind}:expand`,
      group: group.kind,
    });
  if (group.visibleCount > 5)
    result.push({
      kind: "collapse",
      key: `${group.kind}:collapse`,
      group: group.kind,
    });
  return result;
}

/** Each result commits only to the workspace/account/query/open generation that
 * requested it. Selection is an identity, never a drifting array index. */
export function useMentionPicker(
  open: boolean,
  query: string,
  workspace: string | null | undefined,
  files: WorkspaceFileService,
) {
  const network = useAgentNetworkSnapshot();
  const kinds = useMemo(
    () => (query.trim() ? ORDER : ORDER.slice(0, 2)),
    [query],
  );
  const scope = JSON.stringify([
    workspace,
    query,
    open,
    network.authGeneration,
    network.principalId,
    network.networkId,
  ]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const generation = useRef(0);
  const pendingLoads = useRef(new Set<string>());
  const [state, setState] = useState<{
    scope: string;
    groups: MentionGroup[];
    ready: boolean;
  }>({ scope: "", groups: kinds.map(empty), ready: false });
  const [selection, setSelection] = useState<{
    scope: string;
    key: string;
  } | null>(null);
  const groups = useMemo(
    () => (state.scope === scope ? state.groups : kinds.map(empty)),
    [state, scope, kinds],
  );
  const update = useCallback(
    (
      requestScope: string,
      requestGeneration: number,
      kind: MentionKind,
      transform: (group: MentionGroup) => MentionGroup,
    ) => {
      if (
        scopeRef.current !== requestScope ||
        generation.current !== requestGeneration
      )
        return;
      setState((previous) => {
        if (previous.scope !== requestScope) return previous;
        const groups = previous.groups.map((group) =>
          group.kind === kind ? transform(group) : group,
        );
        return {
          ...previous,
          groups,
          ready: previous.ready || groups.every((group) => !group.loading),
        };
      });
    },
    [],
  );
  const load = useCallback(
    async (
      kind: MentionKind,
      cursor: string | null,
      requestScope: string,
      requestGeneration: number,
      revealMore = false,
    ) => {
      const loadKey = JSON.stringify([requestScope, requestGeneration, kind]);
      if (pendingLoads.current.has(loadKey)) return;
      pendingLoads.current.add(loadKey);
      update(requestScope, requestGeneration, kind, (group) => ({
        ...group,
        loading: true,
        error: false,
        unavailable: false,
      }));
      try {
        if (
          (kind === "thought" && !taskCenterAvailable()) ||
          (kind === "file" && !files.isAvailable)
        ) {
          update(requestScope, requestGeneration, kind, (group) => ({
            ...group,
            items: [],
            loading: false,
            error: false,
            unavailable: true,
          }));
          return;
        }
        let items: MentionItem[],
          next: string | null = null,
          partial = false;
        if (kind === "agent") {
          const readAgents = async (localOnly: boolean) => {
            const result = agentDiscoverySchema.parse(
              await invoke("cmd_agent_discovery", { localOnly }),
            );
            if (
              result.authGeneration !== network.authGeneration ||
              result.principalId !== network.principalId ||
              result.networkId !== network.networkId
            )
              throw new Error("PICKER_ACCOUNT_CHANGED");
            return result;
          };
          // Stage local identities immediately, independently of the cloud read.
          // They stay behind the initial presentation barrier until it settles.
          const local = await readAgents(true);
          update(requestScope, requestGeneration, kind, (group) => ({
            ...group,
            items: filterMentionAgents(local.items, query).map((agent) => ({
              kind: "agent",
              key: `agent:${agent.selector}`,
              value: {
                agent,
                authGeneration: local.authGeneration,
                principalId: local.principalId,
                networkId: local.networkId,
              },
            })),
            partial: !local.complete,
          }));
          const result = local.complete ? local : await readAgents(false);
          partial = !result.complete;
          items = filterMentionAgents(result.items, query).map((agent) => ({
            kind: "agent",
            key: `agent:${agent.selector}`,
            value: {
              agent,
              authGeneration: result.authGeneration,
              principalId: result.principalId,
              networkId: result.networkId,
            },
          }));
        } else {
          let page: PickerPage<Thought> | PickerPage<FileSearchResult>;
          if (kind === "thought") {
            page = await thoughtListPage(query, cursor, 200);
            items = page.items.map((value) => ({
              kind: "thought",
              key: `thought:${value.id}`,
              value,
            }));
          } else {
            page = await files.searchFilesPage({ query, cursor, limit: 200 });
            items = page.items.map((value) => ({
              kind: "file",
              key: `file:${value.path}`,
              value,
            }));
          }
          if (
            page.hasMore !== Boolean(page.nextCursor) ||
            (page.complete && (page.hasMore || page.scanLimitReached))
          )
            throw new Error("PICKER_PAGE_INVALID");
          next = page.nextCursor;
          partial = page.scanLimitReached;
        }
        update(requestScope, requestGeneration, kind, (group) => {
          const merged = cursor ? [...group.items, ...items] : items;
          if (new Set(merged.map((item) => item.key)).size !== merged.length)
            return { ...group, loading: false, error: true };
          return {
            ...group,
            items: merged,
            visibleCount: revealMore
              ? group.visibleCount + 5
              : group.visibleCount,
            unavailable: false,
            cursor: next,
            partial,
            loading: false,
            error: false,
          };
        });
      } catch {
        update(requestScope, requestGeneration, kind, (group) => ({
          ...group,
          loading: false,
          error: true,
        }));
      } finally {
        pendingLoads.current.delete(loadKey);
      }
    },
    [
      files,
      network.authGeneration,
      network.principalId,
      network.networkId,
      query,
      update,
    ],
  );
  const invalidate = useCallback(() => {
    ++generation.current;
  }, []);
  useEffect(() => {
    const current = ++generation.current;
    if (!open) {
      setSelection(null);
      setState({ scope: "", groups: kinds.map(empty), ready: false });
      return;
    }
    setState({ scope, groups: kinds.map(empty), ready: false });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(
      () => {
        deadline = setTimeout(() => {
          if (generation.current !== current || scopeRef.current !== scope)
            return;
          // Freeze this first page: late completions cannot insert above the rows
          // the user is now navigating. A retry gets the new request generation.
          invalidate();
          setState((previous) =>
            previous.scope !== scope
              ? previous
              : {
                  ...previous,
                  ready: true,
                  groups: previous.groups.map((group) =>
                    !group.loading
                      ? group
                      : {
                          ...group,
                          loading: false,
                          partial:
                            group.kind === "agent" && group.items.length > 0,
                          error:
                            group.kind !== "agent" || group.items.length === 0,
                        },
                  ),
                },
          );
        }, 2000);
        void Promise.all(
          kinds.map((kind) => load(kind, null, scope, current)),
        ).then(() => clearTimeout(deadline));
      },
      query ? 150 : 0,
    );
    return () => {
      clearTimeout(timer);
      clearTimeout(deadline);
      invalidate();
    };
  }, [open, scope, load, query, kinds, invalidate]);
  const loading = state.scope !== scope || !state.ready;
  const allOptions = useMemo(
    () => (loading ? [] : groups.flatMap(options)),
    [groups, loading],
  );
  const selectedKey =
    selection?.scope === scope &&
    allOptions.some((item) => item.key === selection.key)
      ? selection.key
      : allOptions[0]?.key;
  useEffect(() => {
    if (
      selectedKey &&
      (selection?.scope !== scope || selection.key !== selectedKey)
    )
      setSelection({ scope, key: selectedKey });
  }, [scope, selectedKey, selection]);
  const select = (key: string) => setSelection({ scope, key });
  const move = (direction: number) => {
    const index = allOptions.findIndex((item) => item.key === selectedKey);
    const item =
      allOptions[
        Math.min(allOptions.length - 1, Math.max(0, index + direction))
      ];
    if (item) select(item.key);
  };
  const activateControl = (option: Exclude<MentionOption, MentionItem>) => {
    const group = groups.find((value) => value.kind === option.group)!;
    if (group.loading) return;
    if (option.kind === "collapse") {
      update(scope, generation.current, option.group, (value) => ({
        ...value,
        visibleCount: 5,
      }));
      select(group.items[0]?.key ?? `${group.kind}:expand`);
    } else if (option.kind === "expand") {
      if (group.items.length > group.visibleCount) {
        update(scope, generation.current, option.group, (value) => ({
          ...value,
          visibleCount: value.visibleCount + 5,
        }));
      } else if (group.cursor) {
        void load(option.group, group.cursor, scope, generation.current, true);
      }
    } else if (option.kind === "retry") {
      void load(
        option.group,
        group.items.length ? group.cursor : null,
        scope,
        generation.current,
        Boolean(group.cursor) && group.visibleCount >= group.items.length,
      );
    }
  };
  return {
    groups,
    loading,
    allOptions,
    selectedKey,
    select,
    move,
    activateControl,
    options,
  };
}
