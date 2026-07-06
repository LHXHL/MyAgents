/**
 * url-resolver.ts — Parse user input into a GitHub skill source descriptor.
 *
 * Accepts any of:
 *   - owner/repo
 *   - owner/repo@skill-name
 *   - https://github.com/owner/repo
 *   - https://github.com/owner/repo/tree/<ref>/<sub/path>
 *   - https://github.com/owner/repo.git
 *   - https://example.com/anything.zip        (raw zip passthrough)
 *   - Any of the above prefixed with `npx skills add` / `npx -y skills add`,
 *     optionally followed by `--skill <name>` / `-g` / other CLI noise.
 *
 * Rejects: gitlab, bitbucket, git SSH URLs, private repo URLs, non-zip raw links.
 *
 * The resolver is intentionally permissive about the *input form* (so users can
 * paste whatever they copied from a README or chat) but strict about the
 * *output shape* (a fully-resolved GitHub coordinate or a raw-zip URL).
 */

export interface ResolvedSkillSource {
  /** Discriminator */
  kind: 'github' | 'raw-zip';
  /** Human-readable display for error messages / UI */
  displayName: string;
  /** GitHub owner (undefined for raw-zip) */
  owner?: string;
  /** GitHub repo (undefined for raw-zip) */
  repo?: string;
  /** GitHub ref (branch/tag); undefined means "try default branch" */
  ref?: string;
  /** Subdirectory inside the repo to extract (e.g. "skills/baz") */
  subPath?: string;
  /** Specific skill name hint (from `owner/repo@name` or `--skill name`) */
  skillName?: string;
  /** Already-resolved download URL (only set for raw-zip) */
  rawZipUrl?: string;
}

export class SkillUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillUrlError';
  }
}

/**
 * Normalize user input into a ResolvedSkillSource.
 * Throws SkillUrlError on unrecognized / unsupported input.
 */
export function resolveSkillUrl(rawInput: string): ResolvedSkillSource {
  if (typeof rawInput !== 'string') {
    throw new SkillUrlError('输入必须是字符串');
  }

  const cleaned = stripNpxWrapper(rawInput.trim());
  if (!cleaned.positional) {
    throw new SkillUrlError('未识别到有效的仓库地址');
  }

  // Explicit raw zip/tar.gz passthrough
  if (/^https:\/\//i.test(cleaned.positional) && /\.(zip|tar\.gz|tgz)(\?.*)?$/i.test(cleaned.positional)) {
    return {
      kind: 'raw-zip',
      displayName: cleaned.positional,
      rawZipUrl: cleaned.positional,
      skillName: cleaned.skillName,
    };
  }
  if (/^http:\/\//i.test(cleaned.positional) && /\.(zip|tar\.gz|tgz)(\?.*)?$/i.test(cleaned.positional)) {
    throw new SkillUrlError('直连压缩包必须使用 HTTPS 链接');
  }

  // Full GitHub URL (with optional tree/<ref>/<path>)
  const fullMatch = cleaned.positional.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/\s#?]+)\/([^/\s#?]+?)(?:\.git)?(?:\/tree\/([^/\s#?]+)((?:\/[^\s#?]+)?))?\/?(?:[?#].*)?$/i,
  );
  if (fullMatch) {
    const [, owner, repo, ref, subPath] = fullMatch;
    return buildGithubSource(owner, repo, ref, subPath, cleaned.skillName);
  }

  // Shorthand: owner/repo[@skillName]
  const shortMatch = cleaned.positional.match(/^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:@([\w.\-/]+))?$/);
  if (shortMatch) {
    const [, owner, repo, atSkill] = shortMatch;
    return buildGithubSource(owner, repo, undefined, undefined, cleaned.skillName ?? atSkill);
  }

  // Rejected cases with friendlier messages
  if (/^https?:\/\/(?:www\.)?gitlab\.com/i.test(cleaned.positional)) {
    throw new SkillUrlError('暂不支持 GitLab，请粘贴 GitHub 链接或使用 owner/repo 简写');
  }
  if (/^git@/i.test(cleaned.positional) || /\.git$/i.test(cleaned.positional)) {
    throw new SkillUrlError('暂不支持 SSH / .git 克隆地址，请使用 https://github.com/... 形式');
  }
  if (/^https?:\/\//i.test(cleaned.positional)) {
    throw new SkillUrlError('只支持 github.com 链接或直连 .zip/.tar.gz 文件');
  }

  throw new SkillUrlError(`无法识别的输入："${cleaned.positional}"。示例：foo/bar、https://github.com/foo/bar`);
}

/**
 * Extract the positional argument and optional `--skill` flag from an input
 * that may be a full `npx skills add ...` command or just a bare URL.
 *
 * Strategy: tokenize on whitespace, drop the known npx/skills wrapper prefix,
 * drop known-harmless flags (`-g`, `--global`, `--project`), capture `--skill`
 * value, and take the first remaining non-flag token as the positional arg.
 */
function stripNpxWrapper(input: string): { positional?: string; skillName?: string } {
  // Strip surrounding quotes / trailing backticks from markdown code fences
  const trimmed = input.replace(/^[`'"]+|[`'"]+$/g, '').trim();
  if (!trimmed) return {};

  // Unicode whitespace split — covers ASCII space/tab, NBSP (U+00A0),
  // ideographic space (U+3000), etc. Users copy-pasting from docs can bring
  // any of these along.
  const UNICODE_WS = /[\s\u00a0\u3000]+/;

  // Fast path: looks like a bare URL or owner/repo — no whitespace
  if (!UNICODE_WS.test(trimmed)) {
    return { positional: trimmed };
  }

  const tokens = trimmed.split(UNICODE_WS).filter(Boolean);
  // Drop leading `npx`, `-y`, `skills`, `add` noise (all optional / in any order up front)
  const WRAPPER_TOKENS = new Set(['npx', '-y', 'skills', 'add', 'install']);
  while (tokens.length > 0 && WRAPPER_TOKENS.has(tokens[0].toLowerCase())) {
    tokens.shift();
  }

  let positional: string | undefined;
  let skillName: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '--skill' || tok === '-s') {
      // Bounds-check: dangling flag means user truncated their paste. Silently
      // drop the flag rather than swallowing the next positional arg as the
      // skill name.
      if (i + 1 < tokens.length) {
        const next = tokens[i + 1];
        if (next && !next.startsWith('-')) {
          skillName = next;
          i++;
        }
      }
      continue;
    }
    if (tok.startsWith('--skill=')) {
      const v = tok.slice('--skill='.length);
      if (v) skillName = v;
      continue;
    }
    if (tok === '-g' || tok === '--global' || tok === '--project' || tok === '--user') {
      continue; // scope flags are handled separately by MyAgents UI/CLI
    }
    if (tok.startsWith('-')) {
      // Unknown flag — skip gracefully (forwards-compat with future `npx skills` flags)
      continue;
    }
    if (!positional) {
      positional = tok;
    }
  }

  // Reject empty string — `skillName = ''` would make `hint.toLowerCase()` in
  // analyseTree match every skill and cause an ambiguous install.
  if (skillName !== undefined && skillName.trim() === '') {
    skillName = undefined;
  }

  return { positional, skillName };
}

function buildGithubSource(
  owner: string,
  repo: string,
  ref: string | undefined,
  subPathRaw: string | undefined,
  skillName: string | undefined,
): ResolvedSkillSource {
  if (!isSafeSegment(owner) || !isSafeSegment(repo)) {
    throw new SkillUrlError(`非法的 owner/repo："${owner}/${repo}"`);
  }
  const cleanRepo = repo.replace(/\.git$/i, '');
  const subPath = normalizeSubPath(subPathRaw);

  return {
    kind: 'github',
    displayName: `${owner}/${cleanRepo}${ref ? `@${ref}` : ''}${subPath ? `/${subPath}` : ''}`,
    owner,
    repo: cleanRepo,
    ref: ref || undefined,
    subPath,
    skillName: skillName || undefined,
  };
}

function isSafeSegment(s: string): boolean {
  return /^[A-Za-z0-9][\w.-]*$/.test(s) && !s.includes('..');
}

function normalizeSubPath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return undefined;
  // Block path traversal
  if (trimmed.split('/').some(seg => seg === '..' || seg === '')) {
    throw new SkillUrlError(`非法的子路径："${raw}"`);
  }
  return trimmed;
}

/**
 * Build candidate tarball download URLs for a resolved GitHub source.
 *
 * codeload URL forms:
 *   - /zip/refs/heads/<branch>  — branch (explicit)
 *   - /zip/refs/tags/<tag>      — tag (explicit)
 *   - /zip/<ref>                — universal: accepts branches, tags, AND commit
 *                                  SHAs; this is the form codeload itself uses
 *                                  when serving GitHub's "Download ZIP" button
 *
 * Strategy:
 *   - No ref → try /zip/refs/heads/main, then /zip/refs/heads/master
 *     (explicit heads path avoids 302 ambiguity for the fallback case)
 *   - Explicit ref → use the universal /zip/<ref> form. This one call handles
 *     branches (`dev`), tags (`v1.0.0`), and commit SHAs uniformly.
 *
 * Returns an array — caller tries them in order, falling back on 404.
 */
export function buildGithubZipCandidates(src: ResolvedSkillSource): string[] {
  if (src.kind !== 'github' || !src.owner || !src.repo) {
    throw new SkillUrlError('not a github source');
  }
  const base = `https://codeload.github.com/${src.owner}/${src.repo}/zip`;
  if (src.ref) {
    return [`${base}/${encodeURIComponent(src.ref)}`];
  }
  return [`${base}/refs/heads/main`, `${base}/refs/heads/master`];
}
