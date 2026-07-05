import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronDown, Download, FileText, Folder, Loader2, MoreHorizontal, Package, RefreshCw, Trash2, UploadCloud, X } from 'lucide-react';

import { spaceErrorMessage, type SpaceSkill, type SpaceSkillFile } from '@/api/spaceCloud';
import ConfirmDialog from '@/components/ConfirmDialog';
import Markdown from '@/components/Markdown';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useToast } from '@/components/Toast';
import type { Project } from '@/config/types';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { SpaceIdentityLine } from '@/pages/space/SpaceAvatar';
import { getSkillFileState, SPACE_VISIBLE_REFRESH_TTL_MS, type SpaceActions, type SpaceSkillDetailState } from '@/pages/space/spaceStore';
import { SPACE_LIST_FRAME_CLASS, SPACE_PRIMARY_TOOL_BUTTON_CLASS, SPACE_REFRESH_TOOL_BUTTON_CLASS, SPACE_TWO_COLUMN_GRID_CLASS, formatBytes, formatDate } from '@/pages/space/spaceUi';

type SkillDetailMode = 'entry' | 'files';
const EMPTY_SKILL_FILES: SpaceSkillFile[] = [];

export function SkillsWorkspace({ admin, skills, loading, selectedSkillId, projects, actions, skillDetailState, onSelectSkill, onRefresh, onUploaded }: { admin: boolean; skills: SpaceSkill[]; loading: boolean; selectedSkillId: string | null; projects: Project[]; actions: SpaceActions; skillDetailState?: SpaceSkillDetailState; onSelectSkill: (id: string | null) => void; onRefresh: () => Promise<void>; onUploaded: (id: string) => void }) {
  const { t } = useTranslation('app');
  const toast = useToast();
  const [detailMode, setDetailMode] = useState<SkillDetailMode>('entry');
  const [uploading, setUploading] = useState(false);
  const selected = skills.find((skill) => skill.id === selectedSkillId) ?? null;

  const uploadSkill = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selectedPath = await open({
        multiple: false,
        directory: false,
        title: t('space.skills.pickZipTitle'),
        filters: [{ name: 'Skill ZIP', extensions: ['zip'] }],
      });
      if (!selectedPath || Array.isArray(selectedPath)) return;
      setUploading(true);
      const result = await actions.uploadSkillZip({ filePath: selectedPath });
      toast.success(t('space.toasts.skillUploaded', { name: result.name }));
      await actions.refreshSkills({ force: true, silent: true });
      onUploaded(result.id);
      setDetailMode('entry');
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setUploading(false);
    }
  };

  const openSkill = (id: string) => {
    onSelectSkill(id);
    setDetailMode('entry');
  };

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
      <section className="flex min-h-12 items-center gap-2.5 border-b border-[var(--line)] bg-[var(--paper-elevated)]/60 px-5 py-1.5 backdrop-blur-md">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-[var(--ink-secondary)]">
          <Package className="h-4 w-4 shrink-0" />
          <span>Skills</span>
          <span className="rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">{skills.length}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {admin && (
            <button type="button" disabled={uploading} onClick={() => void uploadSkill()} className={SPACE_PRIMARY_TOOL_BUTTON_CLASS}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              {t('space.skills.upload')}
            </button>
          )}
          <button type="button" onClick={() => void onRefresh()} className={SPACE_REFRESH_TOOL_BUTTON_CLASS} aria-label={t('space.common.refresh')} title={t('space.common.refresh')}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>
      </section>

      <main className="min-h-0 overflow-y-auto px-6 pb-10 pt-5">
        <section className={SPACE_LIST_FRAME_CLASS} aria-label="Skill list">
          {skills.length === 0 && loading ? (
            <div className={SPACE_TWO_COLUMN_GRID_CLASS}>
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="rounded-xl bg-[var(--paper-elevated)] px-3.5 py-3">
                  <div className="flex items-center gap-2">
                    <div className="h-4 w-32 rounded-md bg-[var(--paper-inset)]" />
                    <div className="h-5 w-12 rounded-md bg-[var(--paper-inset)]" />
                  </div>
                  <div className="mt-3 h-3 w-full rounded-md bg-[var(--paper-inset)]" />
                  <div className="mt-2 h-3 w-2/3 rounded-md bg-[var(--paper-inset)]" />
                  <div className="mt-3 h-3 w-56 rounded-md bg-[var(--paper-inset)]/70" />
                </div>
              ))}
            </div>
          ) : skills.length === 0 ? (
            <div className="grid min-h-52 place-items-center rounded-xl border border-dashed border-[var(--line-subtle)] bg-[var(--paper-elevated)]/55 text-sm text-[var(--ink-muted)]">
              <div className="text-center">
                <Package className="mx-auto mb-3 h-9 w-9 text-[var(--ink-subtle)]" />
                <p>{t('space.skills.empty')}</p>
                {admin && (
                  <button type="button" disabled={uploading} onClick={() => void uploadSkill()} className="mt-3 inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-wait disabled:opacity-70">
                    {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                    {t('space.skills.uploadSkill')}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className={SPACE_TWO_COLUMN_GRID_CLASS}>
              {skills.map((skill) => (
                <SpaceSkillCard key={skill.id} skill={skill} onOpen={() => openSkill(skill.id)} t={t} />
              ))}
            </div>
          )}
        </section>
      </main>

      {selected && <SkillDetailWorkspace skill={selected} mode={detailMode} admin={admin} projects={projects} actions={actions} detailState={skillDetailState} onModeChange={setDetailMode} onBack={() => onSelectSkill(null)} onDeleted={() => onSelectSkill(null)} t={t} />}
    </div>
  );
}

function SpaceSkillCard({ skill, onOpen, t }: { skill: SpaceSkill; onOpen: () => void; t: ReturnType<typeof useTranslation>['t'] }) {
  const uploader = skill.uploader;
  return (
    <button type="button" onClick={onOpen} className="group flex w-full flex-col gap-1.5 rounded-xl bg-[var(--paper-elevated)] px-3.5 py-3 text-left transition-shadow hover:shadow-sm">
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--ink)]">{skill.name}</span>
      </span>
      <span className="line-clamp-2 min-h-[2.6em] text-sm leading-relaxed text-[var(--ink-muted)]">{skill.description || t('space.common.noDescription')}</span>
      <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium text-[var(--ink-subtle)]">
        <SpaceIdentityLine
          name={uploader?.name ?? uploader?.id ?? t('space.skills.unknownUploader')}
          avatarUrl={uploader?.avatarUrl}
          avatarSize={18}
          nameClassName="font-semibold text-[var(--ink-muted)]"
        />
        <span className="text-[var(--line-strong)]">·</span>
        <span>
          <span className="font-semibold text-[var(--ink-muted)]">{formatDate(skill.createdAt)}</span>
        </span>
        <span className="text-[var(--line-strong)]">·</span>
        <span className="inline-flex max-w-full rounded-md bg-[var(--accent-cool-subtle)] px-1.5 py-0.5 text-xs font-semibold text-[var(--accent-cool)]">
          <span className="truncate"># {t('space.skills.officialTag')}</span>
        </span>
      </span>
    </button>
  );
}

function isRootFile(file: SpaceSkillFile, name: string): boolean {
  return !file.isDir && file.parentPath === '' && file.name.toLowerCase() === name.toLowerCase();
}

function findEntryFile(files: SpaceSkillFile[]): SpaceSkillFile | null {
  return files.find((file) => isRootFile(file, 'SKILL.md')) ?? files.find((file) => isRootFile(file, 'README.md')) ?? null;
}

function fileDepth(file: SpaceSkillFile): number {
  return Math.max(0, file.path.split('/').length - 1);
}

function sortSkillFiles(files: SpaceSkillFile[]): SpaceSkillFile[] {
  return [...files].sort((left, right) => {
    if (left.parentPath === right.parentPath && left.isDir !== right.isDir) {
      return left.isDir ? -1 : 1;
    }
    return left.path.localeCompare(right.path);
  });
}

function isPreviewableFile(file: SpaceSkillFile): boolean {
  if (file.isDir) return false;
  const name = file.name.toLowerCase();
  const mimeType = file.mimeType?.toLowerCase() ?? '';
  return mimeType.startsWith('text/') || name.endsWith('.md') || name.endsWith('.mdx') || name.endsWith('.json') || name.endsWith('.yaml') || name.endsWith('.yml') || name.endsWith('.toml') || name.endsWith('.js') || name.endsWith('.ts') || name.endsWith('.tsx') || name.endsWith('.py') || name.endsWith('.sh') || name.endsWith('.txt');
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}

function SkillMarkdownDocument({ text }: { text: string }) {
  return (
    <div className="ai-message-content text-[var(--ink-secondary)] [&>h1:first-child]:mt-0 [&>h1]:mb-3 [&>h1]:text-xl [&>h2]:mb-2 [&>h2]:mt-4 [&>h2]:text-lg [&>h3]:mb-2 [&>h3]:mt-4 [&>h3]:text-base [&>ol]:my-2.5 [&>ol]:space-y-1.5 [&>p]:my-3 [&>ul]:my-2.5 [&>ul]:space-y-1.5" style={{ fontSize: 'var(--text-sm)', lineHeight: 1.65 }}>
      <Markdown raw>{stripFrontmatter(text)}</Markdown>
    </div>
  );
}

function SkillDetailWorkspace({ skill, mode, admin, projects, actions, detailState, onModeChange, onBack, onDeleted, t }: { skill: SpaceSkill; mode: SkillDetailMode; admin: boolean; projects: Project[]; actions: SpaceActions; detailState?: SpaceSkillDetailState; onModeChange: (mode: SkillDetailMode) => void; onBack: () => void; onDeleted: () => void; t: ReturnType<typeof useTranslation>['t'] }) {
  const toast = useToast();
  const [previewPath, setPreviewPath] = useState('');
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const [installingTarget, setInstallingTarget] = useState<'global' | 'project' | null>(null);
  const [revisionUploading, setRevisionUploading] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const workspaceMenuRef = useRef<HTMLSpanElement | null>(null);
  const adminMenuRef = useRef<HTMLSpanElement | null>(null);
  const detail = detailState?.detail ?? null;
  const detailLoading = detailState?.isLoading ?? true;
  const files = detail?.files ?? EMPTY_SKILL_FILES;
  const entryFile = useMemo(() => findEntryFile(files), [files]);
  const sortedFiles = useMemo(() => sortSkillFiles(files), [files]);
  const activeMode: SkillDetailMode = entryFile ? mode : 'files';
  const previewFile = activeMode === 'files' && previewPath ? (files.find((file) => file.path === previewPath && !file.isDir) ?? null) : null;
  const activeFile = activeMode === 'entry' ? entryFile : previewFile;
  const activePath = activeFile?.path ?? '';
  const fileState = activePath ? getSkillFileState(skill.id, activePath) : null;
  const fileLoading = fileState?.isLoading ?? false;
  const fileText = fileState?.text ?? '';

  const projectOptions = useMemo(
    () =>
      projects.map((project) => ({
        value: project.path,
        label: project.displayName || project.name,
      })),
    [projects],
  );
  const hasProjects = projectOptions.length > 0;

  useEffect(() => {
    setPreviewPath('');
    setWorkspaceMenuOpen(false);
    setAdminMenuOpen(false);
    void actions.refreshSkillDetail(skill.id, { maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }).catch((error) => toast.error(spaceErrorMessage(error)));
  }, [actions, skill.id, toast]);

  useEffect(() => {
    if (!detail || entryFile || mode !== 'entry') return;
    onModeChange('files');
  }, [detail, entryFile, mode, onModeChange]);

  useEffect(() => {
    if (!activePath) return;
    void actions
      .refreshSkillFile(skill.id, activePath, {
        maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS,
      })
      .catch((error) => toast.error(spaceErrorMessage(error)));
  }, [actions, activePath, skill.id, toast]);

  useEffect(() => {
    if (!workspaceMenuOpen && !adminMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (workspaceMenuOpen && workspaceMenuRef.current && !workspaceMenuRef.current.contains(target)) {
        setWorkspaceMenuOpen(false);
      }
      if (adminMenuOpen && adminMenuRef.current && !adminMenuRef.current.contains(target)) {
        setAdminMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [adminMenuOpen, workspaceMenuOpen]);

  const changeMode = (nextMode: SkillDetailMode) => {
    setPreviewPath('');
    setWorkspaceMenuOpen(false);
    setAdminMenuOpen(false);
    onModeChange(nextMode);
  };

  const install = async (target: 'global' | 'project', workspacePath?: string) => {
    if (target === 'project' && !workspacePath) {
      toast.error(t('space.toasts.selectWorkspace'));
      return;
    }
    setInstallingTarget(target);
    try {
      const result = await actions.installSkill({
        skillId: skill.id,
        skillName: skill.name,
        target,
        workspacePath,
      });
      toast.success(t('space.toasts.skillInstalled', { target: result.target }));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setInstallingTarget(null);
    }
  };

  const uploadRevision = async () => {
    setAdminMenuOpen(false);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selectedPath = await open({
        multiple: false,
        directory: false,
        title: t('space.skills.pickRevisionZipTitle'),
        filters: [{ name: 'Skill ZIP', extensions: ['zip'] }],
      });
      if (!selectedPath || Array.isArray(selectedPath)) return;
      setRevisionUploading(true);
      const result = await actions.uploadSkillRevision(skill.id, selectedPath);
      toast.success(
        t('space.toasts.skillRevisionUploaded', {
          revision: result.latestRevision,
        }),
      );
      await Promise.all([actions.refreshSkills({ force: true, silent: true }), actions.refreshSkillDetail(skill.id, { force: true, silent: true })]);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setRevisionUploading(false);
    }
  };

  const deleteSkill = async () => {
    setAdminMenuOpen(false);
    setDeleting(true);
    try {
      await actions.deleteSkill(skill.id);
      toast.success(t('space.toasts.skillDeleted'));
      setDeleteConfirmOpen(false);
      onDeleted();
      await actions.refreshSkills({ force: true, silent: true });
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setDeleting(false);
    }
  };

  useCloseLayer(() => {
    onBack();
    return true;
  }, 230);

  const renderFilePreview = () => {
    if (!previewFile) return null;
    return (
      <section className="overflow-hidden rounded-xl border border-[var(--line-subtle)] bg-[var(--paper-elevated)]">
        <header className="grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--line-subtle)] px-3.5">
          <button type="button" onClick={() => setPreviewPath('')} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 text-sm font-semibold text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)]">
            <ArrowLeft className="h-4 w-4" />
            {t('space.skills.backToFiles')}
          </button>
          <div className="min-w-0 text-center">
            <div className="truncate text-sm font-semibold text-[var(--ink)]">{previewFile.path}</div>
            <div className="text-xs font-medium text-[var(--ink-subtle)]">{formatBytes(previewFile.sizeBytes)}</div>
          </div>
          <FileText className="h-4 w-4 text-[var(--ink-subtle)]" />
        </header>
        <div className="min-h-[460px] bg-[var(--paper-elevated)]">
          {fileLoading ? (
            <div className="flex min-h-[360px] items-center justify-center text-sm text-[var(--ink-muted)]">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('space.skills.loadingFile')}
            </div>
          ) : fileState?.error ? (
            <div className="flex min-h-[360px] items-center justify-center px-8 text-sm text-[var(--ink-muted)]">{fileState.error}</div>
          ) : (
            <pre className="max-h-[64vh] min-h-[460px] overflow-auto whitespace-pre p-5 font-mono text-sm leading-6 text-[var(--ink-secondary)]">{fileText}</pre>
          )}
        </div>
      </section>
    );
  };

  const renderFilesList = () => (
    <section className="rounded-xl border border-[var(--line-subtle)] bg-[var(--paper-elevated)] px-4 py-4">
      <header className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-[var(--ink)]">{t('space.skills.packageContents')}</h3>
        <span className="text-sm font-medium text-[var(--ink-muted)]">{t('space.skills.totalFiles', { count: files.length })}</span>
      </header>
      <div className="mt-3 overflow-hidden rounded-xl border border-[var(--line-subtle)] bg-[var(--paper)]/45 p-1.5">
        {sortedFiles.map((file) => {
          const isEntry = entryFile?.path === file.path;
          const previewable = isPreviewableFile(file);
          const content = (
            <>
              <span className="flex min-w-0 flex-1 items-center gap-2.5" style={{ paddingLeft: `${fileDepth(file) * 1.25}rem` }}>
                {file.isDir ? <Folder className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" /> : <FileText className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />}
                <span className={`min-w-0 truncate ${file.isDir ? 'font-semibold text-[var(--ink-secondary)]' : 'font-medium text-[var(--ink-muted)]'}`}>{file.name}</span>
                {isEntry && <span className="shrink-0 rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">{t('space.skills.mainFile')}</span>}
              </span>
              <span className="shrink-0 text-sm font-medium text-[var(--ink-muted)]">{file.isDir ? '' : formatBytes(file.sizeBytes)}</span>
            </>
          );
          if (!previewable) {
            return (
              <div key={file.id} className="flex min-h-10 items-center gap-3 rounded-lg px-2.5 text-left text-sm opacity-80">
                {content}
              </div>
            );
          }
          return (
            <button key={file.id} type="button" onClick={() => setPreviewPath(file.path)} className="flex min-h-10 w-full items-center gap-3 rounded-lg px-2.5 text-left text-sm transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--accent-warm)]">
              {content}
            </button>
          );
        })}
      </div>
    </section>
  );

  const renderEntryDocument = () => {
    if (!entryFile) return null;
    return (
      <article className="rounded-xl border border-[var(--line-subtle)] bg-[var(--paper-elevated)] px-6 py-5 shadow-sm shadow-[var(--line-subtle)] max-sm:px-5">
        {fileLoading ? (
          <div className="flex min-h-56 items-center justify-center text-sm text-[var(--ink-muted)]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('space.skills.loadingFile')}
          </div>
        ) : fileState?.error ? (
          <div className="flex min-h-56 items-center justify-center text-sm text-[var(--ink-muted)]">{fileState.error}</div>
        ) : (
          <SkillMarkdownDocument text={fileText} />
        )}
      </article>
    );
  };

  return (
    <>
      <OverlayBackdrop onClose={onBack} className="z-[230] items-stretch justify-end bg-black/20 backdrop-blur-sm">
        <aside className="relative h-full w-[min(78vw,1180px)] border-l border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
          <header className="absolute right-4 top-4 z-10 flex justify-end">
            <button type="button" onClick={onBack} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]" aria-label={t('space.detail.close')}>
              <X className="h-4 w-4" />
            </button>
          </header>

          <section className="h-full min-h-0 overflow-y-auto px-12 py-11 max-lg:px-8 max-sm:px-5">
            <div className="mx-auto max-w-[900px] pb-8">
              <section className="border-b border-[var(--line-subtle)] pb-5">
                <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--ink-subtle)]">
                  <SpaceIdentityLine
                    name={skill.uploader?.name ?? skill.uploader?.id ?? t('space.skills.unknownUploader')}
                    avatarUrl={skill.uploader?.avatarUrl}
                    avatarSize={20}
                    nameClassName="font-semibold text-[var(--ink-subtle)]"
                  />
                  <span className="text-[var(--line-strong)]">·</span>
                  <span>{formatDate(skill.createdAt)}</span>
                  <span className="inline-flex rounded-md bg-[var(--accent-cool-subtle)] px-2 py-1 text-xs font-semibold text-[var(--accent-cool)]"># {t('space.skills.officialTag')}</span>
                  <span className="min-w-0 flex-1" />
                  {admin && (
                    <span ref={adminMenuRef} className="relative">
                      <button type="button" disabled={revisionUploading || deleting} onClick={() => setAdminMenuOpen((open) => !open)} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-70" aria-label={t('space.skills.moreActions')} title={t('space.skills.moreActions')}>
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                      {adminMenuOpen && (
                        <span className="absolute right-0 top-9 z-20 w-44 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-1 shadow-lg">
                          <button type="button" disabled={revisionUploading || deleting} onClick={() => void uploadRevision()} className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm font-semibold text-[var(--ink-secondary)] transition-colors hover:bg-[var(--hover-bg)] disabled:cursor-wait disabled:opacity-60">
                            {revisionUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                            {t('space.skills.updateRevision')}
                          </button>
                          <button
                            type="button"
                            disabled={revisionUploading || deleting}
                            onClick={() => {
                              setAdminMenuOpen(false);
                              setDeleteConfirmOpen(true);
                            }}
                            className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm font-semibold text-[var(--error)] transition-colors hover:bg-[var(--error-bg)] disabled:cursor-wait disabled:opacity-60"
                          >
                            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            {t('space.skills.delete')}
                          </button>
                        </span>
                      )}
                    </span>
                  )}
                </div>
                <div className="mt-3 min-w-0">
                  <h2 className="max-w-[68ch] text-xl font-semibold leading-snug text-[var(--ink)]">{skill.name}</h2>
                  <p className="mt-2 max-w-[72ch] whitespace-pre-wrap text-sm leading-6 text-[var(--ink-secondary)]">{skill.description || t('space.common.noDescription')}</p>
                </div>
              </section>

              <section className="mt-5 border-b border-[var(--line-subtle)] pb-5">
                <div className="mb-3 flex items-center justify-between gap-4">
                  <h3 className="text-base font-semibold text-[var(--ink)]">{t('space.skills.install')}</h3>
                </div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <button type="button" disabled={installingTarget !== null} onClick={() => void install('global')} className="inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3.5 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-wait disabled:opacity-70">
                    {installingTarget === 'global' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    {t('space.skills.installGlobal')}
                  </button>
                  <span ref={workspaceMenuRef} className="relative">
                    <button type="button" disabled={installingTarget !== null || !hasProjects} title={hasProjects ? t('space.skills.installWorkspaceTitle') : t('space.skills.noInstallProjectsTitle')} onClick={() => setWorkspaceMenuOpen((open) => !open)} className="inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-3.5 text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-70">
                      {installingTarget === 'project' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      {t('space.skills.installWorkspace')}
                      <ChevronDown className="h-4 w-4" />
                    </button>
                    {workspaceMenuOpen && (
                      <span className="absolute right-0 top-12 z-20 max-h-72 w-64 overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-1 shadow-lg">
                        {projectOptions.map((project) => (
                          <button
                            key={project.value}
                            type="button"
                            onClick={() => {
                              setWorkspaceMenuOpen(false);
                              void install('project', project.value);
                            }}
                            className="flex min-h-10 w-full flex-col rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--hover-bg)]"
                          >
                            <span className="max-w-full truncate text-sm font-semibold text-[var(--ink)]">{project.label}</span>
                            <span className="max-w-full truncate text-xs font-medium text-[var(--ink-subtle)]">{project.value}</span>
                          </button>
                        ))}
                      </span>
                    )}
                  </span>
                  {!hasProjects && <span className="text-sm font-medium text-[var(--ink-muted)]">{t('space.skills.noProjects')}</span>}
                </div>
              </section>

              {!detail && detailLoading ? (
                <div className="flex min-h-80 items-center justify-center text-sm text-[var(--ink-muted)]">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('space.skills.loadingSkill')}
                </div>
              ) : !detail ? (
                <div className="flex min-h-80 items-center justify-center text-sm text-[var(--ink-muted)]">{detailState?.error ?? t('space.skills.notFound')}</div>
              ) : (
                <>
                  <nav className="mt-6 flex items-center gap-6 border-b border-[var(--line)]" aria-label="Skill detail">
                    {entryFile && (
                      <button type="button" onClick={() => changeMode('entry')} className={`border-b-2 px-0 pb-2.5 text-sm font-semibold transition-colors ${activeMode === 'entry' ? 'border-[var(--ink)] text-[var(--ink)]' : 'border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]'}`}>
                        {entryFile.name}
                      </button>
                    )}
                    <button type="button" onClick={() => changeMode('files')} className={`border-b-2 px-0 pb-2.5 text-sm font-semibold transition-colors ${activeMode === 'files' ? 'border-[var(--ink)] text-[var(--ink)]' : 'border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]'}`}>
                      {t('space.skills.files')}
                    </button>
                  </nav>
                  <div className="mt-5">{activeMode === 'entry' ? renderEntryDocument() : previewFile ? renderFilePreview() : renderFilesList()}</div>
                </>
              )}
            </div>
          </section>
        </aside>
      </OverlayBackdrop>
      {deleteConfirmOpen && <ConfirmDialog title={t('space.skills.deleteTitle')} message={t('space.skills.deleteMessage', { name: skill.name })} confirmText={t('space.skills.delete')} cancelText={t('space.common.cancel')} confirmVariant="danger" loading={deleting} onConfirm={() => void deleteSkill()} onCancel={() => setDeleteConfirmOpen(false)} />}
    </>
  );
}
