import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AlertIcon,
  CheckIcon,
  LoaderIcon,
  RefreshIcon,
  UploadCloudIcon,
  WrenchIcon,
} from "@/components/icons";
import { spaceErrorMessage, type SpaceTool } from "@/api/spaceCloud";
import ConfirmDialog from "@/components/ConfirmDialog";
import Tip from "@/components/Tip";
import { useToast } from "@/components/Toast";
import type { AppConfig } from "@/config/types";
import { atomicModifyConfig } from "@/config/services/appConfigService";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import {
  SPACE_PRIMARY_TOOL_BUTTON_CLASS,
  SPACE_REFRESH_TOOL_BUTTON_CLASS,
} from "@/pages/space/spaceUi";
import {
  SPACE_VISIBLE_REFRESH_TTL_MS,
  withSpaceStoreMutationMetric,
  type SpaceActions,
  type SpaceToolDetailState,
  type SpaceToolRevisionState,
  type SpaceToolsState,
} from "@/pages/space/spaceStore";
import { trackSpaceToolMutation } from "@/pages/space/spaceMetrics";
import { dispatchHelperRequest } from "@/utils/dispatchHelperRequest";
import { buildSpaceToolInstallPrompt } from "@/utils/spaceToolInstallPrompt";
import { CUSTOM_EVENTS } from "../../../../shared/constants";
import { applyPortableMcpInstall } from "../../../../shared/spaceToolManifest";
import { ToolDetailDrawer, type ToolDetailView } from "./ToolDetailDrawer";
import { ToolIcon } from "./ToolParts";
import {
  ToolPublishDialog,
  type CustomPublishInput,
  type McpPublishInput,
  type ToolPublishMode,
} from "./ToolPublishDialog";

function openMcpSettings(mcpServerId: string) {
  window.dispatchEvent(
    new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
      detail: { section: "mcp", mcpServerId },
    }),
  );
}

function ToolRow({
  tool,
  config,
  onOpen,
}: {
  tool: SpaceTool;
  config: AppConfig;
  onOpen: () => void;
}) {
  const { t } = useTranslation("app");
  // The list only knows the server id; "differs from this version" needs the
  // revision manifest and is decided in the detail drawer.
  const installed =
    tool.kind === "mcp" &&
    Boolean(tool.mcpServerId) &&
    (config.mcpServers ?? []).some((server) => server.id === tool.mcpServerId);
  const enabled =
    installed && (config.mcpEnabledServers ?? []).includes(tool.mcpServerId!);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="-mx-2.5 grid min-w-0 grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3.5 rounded-xl px-2.5 py-3 text-left transition-colors hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)] focus-visible:outline-none"
    >
      <ToolIcon name={tool.name} iconUrl={tool.iconUrl} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-[var(--ink)]">
          {tool.name}
        </span>
        <span
          className={`mt-0.5 block truncate text-sm ${tool.description ? "text-[var(--ink-muted)]" : "text-[var(--ink-faint)]"}`}
        >
          {tool.description || t("space.tools.noDescription")}
        </span>
      </span>
      {installed ? (
        <Tip
          label={
            enabled
              ? t("space.tools.installedEnabledTip")
              : t("space.tools.installedDisabledTip")
          }
          position="top"
          align="end"
        >
          <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold text-[var(--ink-subtle)]">
            <CheckIcon className="h-3 w-3" />
            {t("space.tools.installedTag")}
          </span>
        </Tip>
      ) : (
        <span />
      )}
    </button>
  );
}

export function ToolsWorkspace({
  admin,
  spaceId,
  spaceName,
  config,
  toolsState,
  selectedToolId,
  detailState,
  revisionState,
  actions,
  onSelectTool,
  onRefresh,
}: {
  admin: boolean;
  spaceId: string;
  spaceName: string;
  config: AppConfig;
  toolsState: SpaceToolsState;
  selectedToolId: string | null;
  detailState?: SpaceToolDetailState;
  revisionState?: SpaceToolRevisionState;
  actions: SpaceActions;
  onSelectTool: (id: string | null) => void;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("app");
  const toast = useToast();
  const [publishMode, setPublishMode] = useState<ToolPublishMode | null>(null);
  const [editing, setEditing] = useState(false);
  const [editBaseLatestRevision, setEditBaseLatestRevision] = useState<
    number | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [view, setView] = useState<ToolDetailView>("detail");
  const [replaceConfirm, setReplaceConfirm] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const selectedSummary =
    toolsState.items.find((tool) => tool.id === selectedToolId) ?? null;
  const detail = detailState?.detail ?? null;

  const cancelReplace = () => {
    setReplaceConfirm(false);
    trackSpaceToolMutation({
      operation: "install",
      toolKind: "mcp",
      result: "cancel",
      ok: true,
    });
  };

  /** Closes the innermost open layer; false when nothing Tools-owned is open. */
  const dismissLayer = (): boolean => {
    if (busy) return true;
    if (menuOpen) {
      setMenuOpen(false);
      return true;
    }
    if (deleteConfirm) {
      setDeleteConfirm(false);
      return true;
    }
    if (editing) {
      setEditing(false);
      setEditBaseLatestRevision(null);
      return true;
    }
    if (publishMode) {
      setPublishMode(null);
      return true;
    }
    if (rollbackTarget !== null) {
      setRollbackTarget(null);
      return true;
    }
    if (replaceConfirm) {
      cancelReplace();
      return true;
    }
    if (selectedToolId) {
      onSelectTool(null);
      return true;
    }
    return false;
  };
  useCloseLayer(dismissLayer, 240);

  useEffect(() => {
    if (!selectedToolId) return;
    setView("detail");
    setReplaceConfirm(false);
    setRawOpen(false);
    setRollbackTarget(null);
    setMenuOpen(false);
    void actions.refreshToolDetail(selectedToolId, {
      maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS,
    });
  }, [actions, selectedToolId]);

  const publishMcp = async (input: McpPublishInput) => {
    setBusy(true);
    try {
      const result = await actions.publishMcpTool({
        spaceId,
        name: input.name,
        description: input.description,
        portableMcpManifest: input.portableMcpManifest,
        iconFilePath: input.iconFilePath,
      });
      setPublishMode(null);
      setView("detail");
      onSelectTool(result.tool.id);
      toast.success(t("space.tools.published"));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const publishCustom = async (input: CustomPublishInput) => {
    setBusy(true);
    try {
      const result = await actions.publishCustomTool({
        spaceId,
        name: input.name,
        description: input.description,
        customInstallInstruction: input.instruction,
        iconFilePath: input.iconFilePath,
      });
      setPublishMode(null);
      setView("detail");
      onSelectTool(result.tool.id);
      toast.success(t("space.tools.published"));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const finishEdit = () => {
    setEditing(false);
    setEditBaseLatestRevision(null);
    setView("detail");
    toast.success(t("space.tools.updated"));
  };

  const updateMcp = async (input: McpPublishInput) => {
    if (!detail || editBaseLatestRevision === null) return;
    setBusy(true);
    try {
      await actions.updateMcpTool({
        toolId: detail.tool.id,
        name: input.name,
        description: input.description,
        portableMcpManifest: input.portableMcpManifest,
        expectedLatestRevision: editBaseLatestRevision,
        iconFilePath: input.iconFilePath,
        resetIcon: input.resetIcon,
      });
      finishEdit();
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const updateCustom = async (input: CustomPublishInput) => {
    if (!detail || editBaseLatestRevision === null) return;
    setBusy(true);
    try {
      await actions.updateCustomTool({
        toolId: detail.tool.id,
        name: input.name,
        description: input.description,
        customInstallInstruction: input.instruction,
        expectedLatestRevision: editBaseLatestRevision,
        iconFilePath: input.iconFilePath,
        resetIcon: input.resetIcon,
      });
      finishEdit();
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const installMcp = async (allowReplace: boolean) => {
    const manifest = detail?.revision.portableMcpManifest;
    if (!detail || !manifest) return;
    setBusy(true);
    setInstalling(true);
    try {
      let outcome: "identical" | "installed" | "replaced" | "conflict" =
        "conflict";
      // The disk config read inside the lock is authoritative; the rendered
      // state may lag behind an edit made elsewhere.
      await withSpaceStoreMutationMetric(
        "tool.install",
        () =>
          atomicModifyConfig((latest) => {
            const result = applyPortableMcpInstall(
              latest,
              manifest,
              {
                name: detail.revision.name,
                description: detail.revision.description,
              },
              allowReplace,
            );
            outcome = result.outcome;
            return result.config;
          }),
        {
          toolKind: "mcp",
          toolResult: () =>
            outcome === "installed"
              ? "new"
              : outcome === "replaced"
                ? "replace"
                : outcome,
        },
      );
      if (outcome === "conflict") {
        setReplaceConfirm(true);
        toast.warning(t("space.tools.differentState"));
        return;
      }
      setReplaceConfirm(false);
      toast.success(
        outcome === "identical"
          ? t("space.tools.alreadyInstalledToast")
          : t("space.tools.installedToast", { name: detail.revision.name }),
      );
      openMcpSettings(manifest.serverId);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
      setInstalling(false);
    }
  };

  const installCustom = () => {
    if (!detail?.revision.customInstallInstruction) return;
    dispatchHelperRequest({
      scenario: "space_tool_install",
      description: buildSpaceToolInstallPrompt({
        toolName: detail.revision.name,
        toolDescription: detail.revision.description,
        spaceName,
        instruction: detail.revision.customInstallInstruction,
      }),
    });
  };

  const rollback = async () => {
    if (!detail || rollbackTarget === null) return;
    const target = rollbackTarget;
    setBusy(true);
    try {
      await actions.rollbackTool({
        toolId: detail.tool.id,
        revision: target,
        expectedCurrentRevision: detail.tool.currentRevision,
        toolKind: detail.tool.kind,
      });
      toast.success(t("space.tools.setCurrentDone", { revision: target }));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setRollbackTarget(null);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await actions.deleteTool({
        toolId: detail.tool.id,
        toolKind: detail.tool.kind,
      });
      setDeleteConfirm(false);
      onSelectTool(null);
      toast.success(t("space.tools.deleted"));
    } catch (error) {
      setDeleteConfirm(false);
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const items = toolsState.items;
  let list;
  if (toolsState.isLoading && !items.length) {
    list = (
      <div className="grid grid-cols-2 gap-x-7 gap-y-0.5 max-lg:grid-cols-1" aria-busy>
        {Array.from({ length: 6 }).map((_, index) => (
          <div
            key={index}
            className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-3.5 py-3"
          >
            <span className="h-10 w-10 rounded-xl bg-[var(--paper-inset)]" />
            <span>
              <span className="block h-3.5 w-28 rounded-md bg-[var(--paper-inset)]" />
              <span className="mt-2 block h-3 w-3/4 rounded-md bg-[var(--paper-inset)]/70" />
            </span>
          </div>
        ))}
      </div>
    );
  } else if (!items.length && toolsState.error) {
    list = (
      <div role="alert" className="grid min-h-72 place-items-center text-center">
        <div>
          <AlertIcon className="mx-auto h-6 w-6 text-[var(--warning)]" />
          <p className="mt-3 text-sm text-[var(--ink-muted)]">
            {spaceErrorMessage(toolsState.error)}
          </p>
          <button
            type="button"
            onClick={() => void onRefresh().catch(() => undefined)}
            className="mt-4 inline-flex h-9 items-center rounded-lg bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] hover:bg-[var(--button-secondary-bg-hover)]"
          >
            {t("space.common.retry")}
          </button>
        </div>
      </div>
    );
  } else if (!items.length) {
    list = (
      <div className="grid min-h-72 place-items-center text-center">
        <div className="max-w-sm">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)] text-[var(--ink-muted)]">
            <WrenchIcon className="h-5 w-5" />
          </span>
          <h2 className="mt-4 text-base font-semibold text-[var(--ink)]">
            {t("space.tools.empty")}
          </h2>
          <p className="mt-1.5 text-sm leading-6 text-[var(--ink-muted)]">
            {admin ? t("space.tools.emptyAdminHint") : t("space.tools.emptyMemberHint")}
          </p>
          {admin ? (
            <div className="mt-5 flex justify-center gap-2">
              {(["mcp", "custom"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setPublishMode(mode)}
                  className="inline-flex h-9 items-center rounded-lg bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] hover:bg-[var(--button-secondary-bg-hover)]"
                >
                  {mode === "mcp"
                    ? t("space.tools.publishMcpEntry")
                    : t("space.tools.publishGeneralEntry")}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  } else {
    list = (
      <>
        {toolsState.error ? (
          <div
            role="alert"
            className="mb-4 flex min-h-10 items-center gap-2 rounded-xl bg-[var(--warning-bg)] px-3 text-sm text-[var(--warning)]"
          >
            <AlertIcon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 font-medium">
              {t("space.tools.listStale")}
            </span>
            <button
              type="button"
              onClick={() => void onRefresh().catch(() => undefined)}
              className="shrink-0 rounded-lg px-2 py-1 font-semibold hover:bg-[var(--paper-elevated)]/60"
            >
              {t("space.common.retry")}
            </button>
          </div>
        ) : null}
        {/* Cloud returns updated_at DESC; keep its order so later pages append correctly. */}
        <div className="grid grid-cols-2 gap-x-7 gap-y-0.5 max-lg:grid-cols-1">
          {items.map((tool) => (
            <ToolRow
              key={tool.id}
              tool={tool}
              config={config}
              onOpen={() => onSelectTool(tool.id)}
            />
          ))}
        </div>
        {toolsState.hasMore ? (
          <div className="mt-5 flex justify-center">
            <button
              type="button"
              disabled={toolsState.isLoadingMore}
              onClick={() => void actions.loadMoreTools()}
              className="flex h-9 items-center gap-2 rounded-lg px-4 text-sm font-semibold text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] disabled:opacity-60"
            >
              {toolsState.isLoadingMore ? (
                <LoaderIcon className="h-4 w-4 animate-spin" />
              ) : null}
              {t("space.common.loadMore")}
            </button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <main className="min-h-0 flex-1 overflow-y-auto px-8 pb-12 pt-9 max-sm:px-4">
        <div className="mx-auto max-w-[900px]">
          <header className="mb-7 flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-semibold text-[var(--ink)]">
                {t("space.tools.title")}
              </h1>
              <p className="mt-1.5 text-sm text-[var(--ink-muted)]">
                {t("space.tools.subtitle")}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2 pt-0.5">
              <button
                type="button"
                onClick={() => void onRefresh().catch(() => undefined)}
                className={SPACE_REFRESH_TOOL_BUTTON_CLASS}
                aria-label={t("space.common.refresh")}
              >
                {toolsState.isLoading ? (
                  <LoaderIcon className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshIcon className="h-4 w-4" />
                )}
              </button>
              {admin ? (
                <button
                  type="button"
                  onClick={() => setPublishMode("mcp")}
                  className={SPACE_PRIMARY_TOOL_BUTTON_CLASS}
                >
                  <UploadCloudIcon className="h-4 w-4" />
                  {t("space.tools.publish")}
                </button>
              ) : null}
            </div>
          </header>
          <section aria-label={t("space.tools.listLabel")}>{list}</section>
        </div>
      </main>

      {selectedToolId ? (
        <ToolDetailDrawer
          admin={admin}
          config={config}
          tool={selectedSummary}
          detailState={detailState}
          revisionState={revisionState}
          view={view}
          busy={busy}
          installing={installing}
          replaceConfirm={replaceConfirm}
          rawOpen={rawOpen}
          rollbackTarget={rollbackTarget}
          menuOpen={menuOpen}
          onMenuOpenChange={setMenuOpen}
          onClose={() => {
            if (!busy) onSelectTool(null);
          }}
          onEscape={() => void dismissLayer()}
          onInstall={() => void installMcp(false)}
          onRequestReplace={() => setReplaceConfirm(true)}
          onCancelReplace={cancelReplace}
          onConfirmReplace={() => void installMcp(true)}
          onManage={() => {
            const serverId = detail?.revision.portableMcpManifest?.serverId;
            if (serverId) openMcpSettings(serverId);
          }}
          onHelperInstall={installCustom}
          onToggleRaw={() => setRawOpen((open) => !open)}
          onEdit={() => {
            if (!detail) return;
            if (detail.tool.kind === "mcp" && !detail.revision.portableMcpManifest) return;
            setEditBaseLatestRevision(detail.tool.latestRevision);
            setEditing(true);
          }}
          onOpenHistory={() => {
            if (!detail) return;
            setView("history");
            void actions
              .refreshToolRevisions(detail.tool.id, { force: true })
              .catch(() => undefined);
          }}
          onBackToDetail={() => {
            setRollbackTarget(null);
            setView("detail");
          }}
          onDelete={() => setDeleteConfirm(true)}
          onRequestRollback={setRollbackTarget}
          onCancelRollback={() => setRollbackTarget(null)}
          onConfirmRollback={() => void rollback()}
          onRetryDetail={() =>
            void actions
              .refreshToolDetail(selectedToolId, { force: true })
              .catch(() => undefined)
          }
          onRetryRevisions={() => {
            if (!detail) return;
            void actions
              .refreshToolRevisions(detail.tool.id, { force: true })
              .catch(() => undefined);
          }}
          onLoadMoreRevisions={() => {
            if (!detail) return;
            void actions.loadMoreToolRevisions(detail.tool.id).catch(() => undefined);
          }}
        />
      ) : null}

      {publishMode && !editing ? (
        <ToolPublishDialog
          mode={publishMode}
          editing={null}
          config={config}
          tools={items}
          busy={busy}
          onModeChange={setPublishMode}
          onClose={() => setPublishMode(null)}
          onSubmitMcp={(input) => void publishMcp(input)}
          onSubmitCustom={(input) => void publishCustom(input)}
        />
      ) : null}
      {editing && detail ? (
        <ToolPublishDialog
          mode={detail.tool.kind === "mcp" ? "mcp" : "custom"}
          editing={detail}
          config={config}
          tools={items}
          busy={busy}
          onModeChange={() => undefined}
          onClose={() => {
            setEditing(false);
            setEditBaseLatestRevision(null);
          }}
          onSubmitMcp={(input) => void updateMcp(input)}
          onSubmitCustom={(input) => void updateCustom(input)}
        />
      ) : null}
      {deleteConfirm && detail ? (
        <ConfirmDialog
          title={t("space.tools.deleteConfirmTitle", { name: detail.revision.name })}
          message={t("space.tools.deleteConfirmDescription")}
          confirmText={t("space.common.delete")}
          cancelText={t("space.common.cancel")}
          confirmVariant="danger"
          loading={busy}
          disableEnterShortcut
          onConfirm={() => void remove()}
          onCancel={() => {
            // ConfirmDialog's own Cmd+W layer sits above ours; keep the
            // busy guard so a pending delete cannot lose its dialog.
            if (!busy) setDeleteConfirm(false);
          }}
        />
      ) : null}
    </div>
  );
}
