import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Copy, Download, FileText, Loader2, MessageSquare, Paperclip, Send, Target, UploadCloud, X } from 'lucide-react';

import { spaceErrorMessage, type SpaceAttachment, type SpaceSession } from '@/api/spaceCloud';
import Markdown from '@/components/Markdown';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useToast } from '@/components/Toast';
import type { Project } from '@/config/types';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { copyPlainText } from '@/utils/markdownClipboard';
import {
  buildIssueCommandPrompt,
  claimHandlerLabel,
  claimHandlerTypeKey,
  getIssueStatusOptions,
  issueDisplayTitle,
  issueStatusLabel,
} from '@/pages/space/spaceHelpers';
import {
  SPACE_VISIBLE_REFRESH_TTL_MS,
  type SpaceActions,
  type SpaceIssueDetailState,
} from '@/pages/space/spaceStore';
import { formatBytes, formatTime, statusPillClass } from '@/pages/space/spaceUi';

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function buildAttachmentDownloadCommand(attachmentId: string): string {
  return `myagents space attachment download ${attachmentId}`;
}

function IssueMarkdown({ children }: { children: string }) {
  return (
    <div className="ai-message-content max-w-[66ch] text-[var(--ink-secondary)]">
      <Markdown raw preserveNewlines>{children}</Markdown>
    </div>
  );
}

export function IssueDetailDrawer({
  issueId,
  session,
  projects,
  detailState,
  actions,
  onClose,
  onChanged,
}: {
  issueId: string;
  session: SpaceSession;
  projects: Project[];
  detailState?: SpaceIssueDetailState;
  actions: SpaceActions;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation('app');
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState<string | null>(null);
  const [downloadedAttachmentPaths, setDownloadedAttachmentPaths] = useState<Record<string, string>>({});
  const [downloadTargetAttachmentId, setDownloadTargetAttachmentId] = useState<string | null>(null);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const statusMenuRef = useRef<HTMLSpanElement | null>(null);
  const downloadMenuRef = useRef<HTMLSpanElement | null>(null);
  const detail = detailState?.detail ?? null;
  const loading = detailState?.isLoading ?? true;
  const statusOptions = useMemo(
    () => getIssueStatusOptions({ session, issue: detail?.issue ?? null, t }),
    [detail?.issue, session, t],
  );

  useCloseLayer(() => {
    onClose();
    return true;
  }, 230);

  useEffect(() => {
    void actions.refreshIssueDetail(issueId, { maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }).catch((error) => toast.error(spaceErrorMessage(error)));
  }, [actions, issueId, toast]);

  useEffect(() => {
    setDownloadedAttachmentPaths({});
    setDownloadTargetAttachmentId(null);
  }, [issueId]);

  useEffect(() => {
    if (!statusMenuOpen && !downloadTargetAttachmentId) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (statusMenuOpen && statusMenuRef.current && !statusMenuRef.current.contains(target)) {
        setStatusMenuOpen(false);
      }
      if (downloadTargetAttachmentId && downloadMenuRef.current && !downloadMenuRef.current.contains(target)) {
        setDownloadTargetAttachmentId(null);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [downloadTargetAttachmentId, statusMenuOpen]);

  const changeStatus = async (option: { value: string; kind: 'set-status' | 'close-own' }) => {
    if (!detail) return;
    setStatusBusy(true);
    try {
      if (option.kind === 'close-own') {
        await actions.closeOwnIssue(issueId);
      } else {
        await actions.setIssueState(issueId, option.value);
      }
      setStatusMenuOpen(false);
      toast.success(t('space.toasts.issueStatusUpdated'));
      await actions.refreshIssueDetail(issueId, { force: true, silent: true });
      onChanged();
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setStatusBusy(false);
    }
  };

  const sendComment = async () => {
    if (!comment.trim()) return;
    setBusy(true);
    try {
      await actions.commentIssue(issueId, comment.trim());
      setComment('');
      await actions.refreshIssueDetail(issueId, { force: true, silent: true });
      onChanged();
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const uploadAttachments = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ multiple: true, directory: false, title: t('space.createIssue.pickAttachmentsTitle') });
      const filePaths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (filePaths.length === 0) return;
      setAttachmentUploading(true);
      const attachments = await actions.uploadIssueAttachments(issueId, filePaths);
      toast.success(t('space.toasts.attachmentsUploaded', { count: attachments.length }));
      await actions.refreshIssueDetail(issueId, { force: true, silent: true });
      onChanged();
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setAttachmentUploading(false);
    }
  };

  const downloadAttachment = async (attachment: SpaceAttachment, workspacePath: string) => {
    if (!workspacePath) {
      toast.error(t('space.toasts.selectWorkspace'));
      return;
    }
    setDownloadTargetAttachmentId(null);
    setDownloadingAttachmentId(attachment.id);
    try {
      const result = await actions.downloadIssueAttachment({
        issueId,
        attachmentId: attachment.id,
        workspacePath,
        fileName: attachment.name,
      });
      setDownloadedAttachmentPaths((paths) => ({ ...paths, [attachment.id]: result.fullPath }));
      toast.success(t('space.toasts.attachmentDownloaded', { path: result.relativePath }));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setDownloadingAttachmentId(null);
    }
  };

  const requestAttachmentDownload = (attachment: SpaceAttachment) => {
    if (projects.length === 0) {
      toast.error(t('space.toasts.noAgentWorkspaces'));
      return;
    }
    if (projects.length === 1) {
      void downloadAttachment(attachment, projects[0].path);
      return;
    }
    setDownloadTargetAttachmentId((current) => (current === attachment.id ? null : attachment.id));
  };

  const copyAttachmentCommand = async (attachment: SpaceAttachment) => {
    try {
      await copyPlainText(buildAttachmentDownloadCommand(attachment.id));
      toast.success(t('space.toasts.attachmentCommandCopied'));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  };

  const copyDownloadedAttachmentPath = async (attachment: SpaceAttachment) => {
    const fullPath = downloadedAttachmentPaths[attachment.id];
    if (!fullPath) return;
    try {
      await copyPlainText(fullPath);
      toast.success(t('space.toasts.attachmentPathCopied'));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  };

  const copyIssueCommand = async () => {
    try {
      await copyPlainText(buildIssueCommandPrompt({ spaceName: session.space.name, issueId }));
      toast.success(t('space.toasts.issueCommandCopied'));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  };
  const issueAuthorName = detail?.issue.creator?.name ?? detail?.issue.creator?.id ?? detail?.issue.author?.name ?? detail?.issue.author?.id ?? 'owner';
  const claim = detail?.claim ?? detail?.issue.claim;
  const claimHandlerName = claimHandlerLabel(claim);
  const claimHandlerTypeKeyValue = claimHandlerTypeKey(claim);
  const claimHandlerType = claimHandlerTypeKeyValue
    ? t(claimHandlerTypeKeyValue)
    : t('space.detail.claimHandlerUnknownType');

  return (
    <OverlayBackdrop onClose={onClose} className="z-[230] items-stretch justify-end bg-black/20 backdrop-blur-sm">
      <aside className="relative h-full w-[min(75vw,1120px)] border-l border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
        <header className="absolute right-4 top-4 z-10 flex justify-end">
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]" aria-label={t('space.detail.close')}>
            <X className="h-4 w-4" />
          </button>
        </header>

        {!detail && loading ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('space.detail.loadingIssue')}
          </div>
        ) : !detail ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
            {detailState?.error ?? t('space.detail.notFound')}
          </div>
        ) : (
          <section className="h-full min-h-0 overflow-y-auto px-[56px] py-[58px] max-lg:px-8 max-sm:px-5">
            <div className="mx-auto max-w-[840px] pb-10">
              <article className="pb-7">
                <div className="mb-4 flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--ink-subtle)]">
                  <span ref={statusMenuRef} className="relative">
                    {statusOptions.length > 0 ? (
                      <button
                        type="button"
                        disabled={statusBusy}
                        onClick={() => setStatusMenuOpen((value) => !value)}
                        className={`inline-flex min-h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-semibold transition-colors ${statusPillClass(detail.issue.state)} disabled:cursor-wait disabled:opacity-70`}
                      >
                        {statusBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                        {issueStatusLabel(detail.issue.state, t)}
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <span className={`inline-flex min-h-8 items-center whitespace-nowrap rounded-md px-2.5 text-xs font-semibold ${statusPillClass(detail.issue.state)}`}>
                        {issueStatusLabel(detail.issue.state, t)}
                      </span>
                    )}
                    {statusMenuOpen && statusOptions.length > 0 && (
                      <div className="absolute left-0 top-full z-30 mt-2 w-48 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-1.5 shadow-lg">
                        {statusOptions.map((option) => (
                          <button
                            key={`${option.kind}:${option.value}`}
                            type="button"
                            onClick={() => void changeStatus(option)}
                            className={`flex h-9 w-full items-center justify-between rounded-lg px-2.5 text-left text-sm font-semibold transition-colors hover:bg-[var(--paper-inset)] ${
                              detail.issue.state === option.value ? 'text-[var(--accent-warm)]' : 'text-[var(--ink-secondary)]'
                            }`}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </span>
                  <span>{issueAuthorName}</span>
                  <span className="text-[var(--line-strong)]">·</span>
                  <span>{formatTime(detail.issue.createdAt)}</span>
                  {detail.goalReference && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-[var(--accent-cool-subtle)] px-2 py-1 text-xs font-semibold text-[var(--accent-cool)]">
                      <Target className="h-3.5 w-3.5" />
                      {detail.goalReference.goalPathLabel || detail.goalReference.goalTitle}
                    </span>
                  )}
                  {detail.issue.humanOnly && (
                    <span className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs font-semibold text-[var(--ink-muted)]">
                      {t('space.issues.humanOnly')}
                    </span>
                  )}
                  {claimHandlerName && (
                    <span className="rounded-md bg-[var(--warning-bg)] px-2 py-1 text-xs font-semibold text-[var(--warning)]">
                      {t('space.detail.claimHandler', {
                        name: claimHandlerName,
                        type: claimHandlerType,
                      })}
                    </span>
                  )}
                </div>
                <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 max-sm:grid-cols-1">
                  <h2 className="max-w-[68ch] text-2xl font-semibold leading-snug text-[var(--ink)]">{issueDisplayTitle(detail.issue)}</h2>
                  <button
                    type="button"
                    onClick={() => void copyIssueCommand()}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-transparent px-2.5 text-sm font-semibold text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] max-sm:justify-self-start"
                    title={t('space.detail.copyIssueCommand')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    {t('space.detail.copyIssueCommand')}
                  </button>
                </div>
                <div className="mt-5">
                  <IssueMarkdown>{detail.issue.body}</IssueMarkdown>
                </div>

                <section className="mt-7">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--ink-secondary)]">
                      <Paperclip className="h-4 w-4" />
                      <span>{t('space.detail.attachments')}</span>
                      <span className="text-xs font-semibold text-[var(--ink-subtle)]">{detail.attachments.length}</span>
                    </h3>
                    <button
                      type="button"
                      disabled={attachmentUploading}
                      onClick={() => void uploadAttachments()}
                      className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-70"
                      title={t('space.detail.uploadAttachment')}
                    >
                      {attachmentUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
                      {t('space.common.upload')}
                    </button>
                  </div>
                  {detail.attachments.length === 0 ? (
                    <div className="py-2 text-sm text-[var(--ink-muted)]">{t('space.detail.emptyAttachments')}</div>
                  ) : (
                    <div className="divide-y divide-dashed divide-[var(--line-subtle)]">
                      {detail.attachments.map((attachment) => (
                        <div key={attachment.id} className="grid min-h-10 grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 py-1.5 text-sm text-[var(--ink-secondary)]">
                          <Paperclip className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                          <span className="min-w-0">
                            <span className="block truncate">{attachment.name}</span>
                            <small className="block text-xs leading-4 text-[var(--ink-subtle)]">{formatBytes(attachment.sizeBytes)}</small>
                          </span>
                          <span
                            ref={downloadTargetAttachmentId === attachment.id ? downloadMenuRef : undefined}
                            className="relative flex items-center gap-1"
                          >
                            <button
                              type="button"
                              disabled={downloadingAttachmentId !== null}
                              onClick={() => requestAttachmentDownload(attachment)}
                              className="grid h-7 w-7 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-55"
                              aria-label={t('space.detail.downloadAttachment', { name: attachment.name })}
                              title={projects.length > 1 ? t('space.detail.chooseDownloadWorkspace') : t('space.detail.downloadAttachment', { name: attachment.name })}
                            >
                              {downloadingAttachmentId === attachment.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                            </button>
                            {downloadTargetAttachmentId === attachment.id && projects.length > 1 && (
                              <div className="absolute right-0 top-full z-30 mt-2 w-56 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-1.5 shadow-lg">
                                <div className="px-2 pb-1 text-xs font-semibold text-[var(--ink-muted)]">{t('space.detail.downloadToAgentWorkspace')}</div>
                                {projects.map((project) => (
                                  <button
                                    key={project.path}
                                    type="button"
                                    disabled={downloadingAttachmentId !== null}
                                    onClick={() => void downloadAttachment(attachment, project.path)}
                                    className="block h-9 w-full truncate rounded-lg px-2.5 text-left text-sm font-semibold text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)] disabled:cursor-wait disabled:opacity-60"
                                  >
                                    {project.displayName || project.name || basename(project.path)}
                                  </button>
                                ))}
                              </div>
                            )}
                            <button
                              type="button"
                              onClick={() => void copyAttachmentCommand(attachment)}
                              className="grid h-7 w-7 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                              aria-label={t('space.detail.copyAttachmentCommand', { name: attachment.name })}
                              title={t('space.detail.copyCliDownloadCommand')}
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={!downloadedAttachmentPaths[attachment.id]}
                              onClick={() => void copyDownloadedAttachmentPath(attachment)}
                              className="grid h-7 w-7 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-45"
                              aria-label={t('space.detail.copyAttachmentPath', { name: attachment.name })}
                              title={t('space.detail.copyLocalPath')}
                            >
                              <FileText className="h-3.5 w-3.5" />
                            </button>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </article>

              <section>
                <h3 className="mb-5 flex items-center justify-between gap-3 text-lg font-semibold text-[var(--ink)]">
                  <span className="inline-flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" />
                    {t('space.detail.comments')}
                  </span>
                  <small className="text-xs font-semibold text-[var(--ink-subtle)]">{t('space.detail.commentCount', { count: detail.comments.items.length })}</small>
                </h3>
                <div className="divide-y divide-[var(--line-subtle)]">
                  {detail.comments.items.length === 0 ? (
                    <div className="py-3 text-sm text-[var(--ink-muted)]">
                      {t('space.detail.emptyComments')}
                    </div>
                  ) : (
                    detail.comments.items.map((item) => (
                      <article key={item.id} className="py-5 first:pt-0">
                        <div className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-[var(--ink-subtle)]">
                          <strong className="text-[var(--ink)]">{item.author.type}</strong>
                          <span>{formatTime(item.createdAt)}</span>
                        </div>
                        <IssueMarkdown>{item.body}</IssueMarkdown>
                      </article>
                    ))
                  )}
                </div>

                <div className="mt-6 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/70 shadow-sm">
                  <textarea
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    className="min-h-[104px] w-full resize-none border-0 bg-transparent p-4 text-base leading-7 text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]"
                    placeholder={t('space.detail.commentPlaceholder')}
                  />
                  <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 px-2.5 pb-2.5">
                    <button
                      type="button"
                      disabled={attachmentUploading}
                      onClick={() => void uploadAttachments()}
                      className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-70"
                      aria-label={t('space.detail.uploadAttachmentAria')}
                    >
                      {attachmentUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                    </button>
                    <span />
                    <button
                      type="button"
                      disabled={busy || !comment.trim()}
                      onClick={() => void sendComment()}
                      className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--button-primary-bg)] text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
                      aria-label={t('space.detail.sendComment')}
                      title={t('space.detail.sendComment')}
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              </section>
            </div>
          </section>
        )}
      </aside>
    </OverlayBackdrop>
  );
}
