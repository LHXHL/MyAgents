export interface LargeValueRef {
  kind: "ref";
  /** 128-bit UUID encoded as 32 lowercase hex characters. */
  id: string;
  /** Total byte size of the full payload on disk. */
  sizeBytes: number;
  /** MIME type — drives renderer decoding (text vs binary, image preview, …). */
  mimetype: string;
  /**
   * Inline preview — head `previewBytes` of the payload as a UTF-8 string when
   * the mimetype is text-like, or the base64-encoded head when binary. The full
   * body is on disk; this is purely for SSE-side previews / log summaries.
   */
  preview: string;
  /** Epoch ms when the ref expires and may be GC'd. */
  expiresAt: number;
}
