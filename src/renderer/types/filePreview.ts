export interface FilePreviewFocusTarget {
  /** Source-local navigation event id. Same line can be focused repeatedly. */
  requestId: number;
  lineNumber: number;
  query?: string;
  highlights?: [number, number][];
}

/** A navigation intent, before any document content has been loaded. */
export interface FilePreviewTarget {
  name: string;
  path: string;
  sourceScope?: 'workspace' | 'local';
  localPath?: string;
  initialLineNumber?: number;
  focusTarget?: FilePreviewFocusTarget;
  initialEditMode?: boolean;
}

export interface FilePreviewOptions {
  initialEditMode?: boolean;
  /** The initiating surface retains authority over a superseded navigation. */
  isCurrent?: () => boolean;
}
