import { randomBytes } from "node:crypto";
import type { ExactTemplateSelector } from "./types.ts";
import { exactSelectorDigest } from "./providers.ts";

export type ConfirmationMode = "app" | "headless";

export class PreviewProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PreviewProtocolError";
    this.code = code;
  }
}

interface ResultSetState {
  resultSetId: string;
  queryDigest: string;
  catalogRevision: string;
  libraryBindingDigest: string;
  providerIds: string[];
  candidateKeys: Set<string>;
}

interface CursorState {
  resultSetId: string;
  queryDigest: string;
  catalogRevision: string;
  libraryBindingDigest: string;
  offset: number;
  limit: number;
}

export interface PreviewBinding {
  resultSetId: string;
  providerId: string;
  exactSelector: ExactTemplateSelector;
  exactSelectorDigest: string;
  previewSha256: string;
  catalogRevision: string;
  libraryBindingDigest: string;
}

interface ChallengeState extends PreviewBinding {
  previewChallenge: string;
}

export interface ReceiptState extends PreviewBinding {
  previewReceipt: string;
  confirmationMode: ConfirmationMode;
  consumed: boolean;
}

function token(prefix: string) {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function candidateKey(providerId: string, selectorDigest: string) {
  return `${providerId}:${selectorDigest}`;
}

export class PreviewConfirmationStore {
  private readonly resultSets = new Map<string, ResultSetState>();
  private readonly cursors = new Map<string, CursorState>();
  private readonly challenges = new Map<string, ChallengeState>();
  private readonly receipts = new Map<string, ReceiptState>();

  registerResultSet(input: {
    queryDigest: string;
    catalogRevision: string;
    libraryBindingDigest: string;
    providerIds: string[];
    candidates: Array<{ providerId: string; exactSelector: ExactTemplateSelector }>;
  }) {
    const resultSetId = token("result");
    this.resultSets.set(resultSetId, {
      resultSetId,
      queryDigest: input.queryDigest,
      catalogRevision: input.catalogRevision,
      libraryBindingDigest: input.libraryBindingDigest,
      providerIds: [...input.providerIds],
      candidateKeys: new Set(
        input.candidates.map((candidate) =>
          candidateKey(candidate.providerId, exactSelectorDigest(candidate.exactSelector)),
        ),
      ),
    });
    while (this.resultSets.size > 128) {
      const oldest = this.resultSets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.resultSets.delete(oldest);
      for (const [cursor, value] of this.cursors) {
        if (value.resultSetId === oldest) this.cursors.delete(cursor);
      }
    }
    return resultSetId;
  }

  getResultSet(resultSetId: string) {
    const state = this.resultSets.get(resultSetId);
    if (!state) {
      throw new PreviewProtocolError(
        "search_results_stale",
        "The search result set is unavailable in this server session; run the search again.",
      );
    }
    return { ...state, providerIds: [...state.providerIds] };
  }

  requireResultSet(input: {
    resultSetId: string;
    queryDigest?: string;
    catalogRevision: string;
    libraryBindingDigest: string;
  }) {
    const state = this.resultSets.get(input.resultSetId);
    if (!state) {
      throw new PreviewProtocolError(
        "search_results_stale",
        "The search result set is unavailable in this server session; run the search again.",
      );
    }
    if (
      (input.queryDigest !== undefined && state.queryDigest !== input.queryDigest) ||
      state.catalogRevision !== input.catalogRevision ||
      state.libraryBindingDigest !== input.libraryBindingDigest
    ) {
      throw new PreviewProtocolError(
        "search_results_stale",
        "The Local Published or FigureYa catalog changed; run the search again.",
      );
    }
    return state;
  }

  createCursor(input: CursorState) {
    this.requireResultSet(input);
    const cursor = token("cursor");
    this.cursors.set(cursor, { ...input });
    while (this.cursors.size > 1024) {
      const oldest = this.cursors.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cursors.delete(oldest);
    }
    return cursor;
  }

  resolveCursor(cursor: string) {
    const state = this.cursors.get(cursor);
    if (!state) {
      throw new PreviewProtocolError(
        "search_results_stale",
        "The pagination cursor is invalid or belongs to another server session.",
      );
    }
    return { ...state };
  }

  issueChallenge(input: PreviewBinding) {
    const resultSet = this.requireResultSet(input);
    const key = candidateKey(input.providerId, input.exactSelectorDigest);
    if (!resultSet.candidateKeys.has(key)) {
      throw new PreviewProtocolError(
        "preview_selection_mismatch",
        "The exact selector is not a member of this search result set.",
      );
    }
    const previewChallenge = token("challenge");
    this.challenges.set(previewChallenge, { ...input, previewChallenge });
    return previewChallenge;
  }

  confirm(previewChallenge: string, confirmationMode: ConfirmationMode) {
    const challenge = this.challenges.get(previewChallenge);
    if (!challenge) {
      throw new PreviewProtocolError(
        "preview_challenge_invalid",
        "The preview challenge is invalid, already confirmed, or belongs to another server session.",
      );
    }
    this.challenges.delete(previewChallenge);
    const previewReceipt = token("receipt");
    const receipt: ReceiptState = {
      ...challenge,
      previewReceipt,
      confirmationMode,
      consumed: false,
    };
    this.receipts.set(previewReceipt, receipt);
    return { ...receipt };
  }

  getReceipt(previewReceipt: string) {
    const receipt = this.receipts.get(previewReceipt);
    if (!receipt) {
      throw new PreviewProtocolError(
        "preview_required",
        "A valid preview confirmation receipt is required before materialization can be planned.",
      );
    }
    return { ...receipt };
  }

  requireReceipt(input: {
    previewReceipt: string;
    providerId: string;
    exactSelector: ExactTemplateSelector;
    previewSha256: string;
    catalogRevision: string;
    libraryBindingDigest: string;
  }) {
    const receipt = this.receipts.get(input.previewReceipt);
    if (!receipt) {
      throw new PreviewProtocolError(
        "preview_required",
        "A valid preview confirmation receipt is required before materialization can be planned.",
      );
    }
    if (receipt.consumed) {
      throw new PreviewProtocolError(
        "preview_receipt_used",
        "The preview confirmation receipt has already been consumed by a materialization plan.",
      );
    }
    if (
      receipt.providerId !== input.providerId ||
      receipt.exactSelectorDigest !== exactSelectorDigest(input.exactSelector)
    ) {
      throw new PreviewProtocolError(
        "preview_receipt_mismatch",
        "The preview confirmation receipt does not match the requested provider and exact selector.",
      );
    }
    if (
      receipt.previewSha256 !== input.previewSha256 ||
      receipt.catalogRevision !== input.catalogRevision ||
      receipt.libraryBindingDigest !== input.libraryBindingDigest
    ) {
      throw new PreviewProtocolError(
        "preview_stale",
        "The confirmed preview, catalog, or Library binding changed; search and confirm again.",
      );
    }
    this.requireResultSet(receipt);
    return { ...receipt };
  }

  consumeReceipt(previewReceipt: string) {
    const receipt = this.receipts.get(previewReceipt);
    if (!receipt || receipt.consumed) {
      throw new PreviewProtocolError(
        "preview_receipt_used",
        "The preview confirmation receipt is unavailable or already consumed.",
      );
    }
    receipt.consumed = true;
  }
}
