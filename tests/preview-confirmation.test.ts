import assert from "node:assert/strict";
import test from "node:test";
import {
  PreviewConfirmationStore,
  PreviewProtocolError,
} from "../src/preview-confirmation.ts";
import {
  LOCAL_LIBRARY_PROVIDER_ID,
  exactSelectorDigest,
  localPublishedExactSelector,
} from "../src/providers.ts";

const selector = localPublishedExactSelector({
  templateId: "preview-protocol-fixture",
  revisionId: "revision-1",
  contentDigest: "a".repeat(64),
  releaseId: "release-1",
});
const otherSelector = localPublishedExactSelector({
  templateId: "other-preview-protocol-fixture",
  revisionId: "revision-2",
  contentDigest: "b".repeat(64),
  releaseId: "release-2",
});

function protocolError(code: string) {
  return (error: unknown) =>
    error instanceof PreviewProtocolError && error.code === code;
}

function preparedStore() {
  const store = new PreviewConfirmationStore();
  const state = {
    queryDigest: "query-revision",
    catalogRevision: "catalog-revision",
    libraryBindingDigest: "library-binding",
    providerIds: [LOCAL_LIBRARY_PROVIDER_ID],
  };
  const resultSetId = store.registerResultSet({
    ...state,
    candidates: [{ providerId: LOCAL_LIBRARY_PROVIDER_ID, exactSelector: selector }],
  });
  return { store, state, resultSetId };
}

function issueChallenge(input: ReturnType<typeof preparedStore>) {
  return input.store.issueChallenge({
    resultSetId: input.resultSetId,
    providerId: LOCAL_LIBRARY_PROVIDER_ID,
    exactSelector: selector,
    exactSelectorDigest: exactSelectorDigest(selector),
    previewSha256: "c".repeat(64),
    catalogRevision: input.state.catalogRevision,
    libraryBindingDigest: input.state.libraryBindingDigest,
  });
}

test("preview challenges are candidate-bound and one-time", () => {
  const prepared = preparedStore();
  assert.throws(
    () =>
      prepared.store.issueChallenge({
        resultSetId: prepared.resultSetId,
        providerId: LOCAL_LIBRARY_PROVIDER_ID,
        exactSelector: otherSelector,
        exactSelectorDigest: exactSelectorDigest(otherSelector),
        previewSha256: "c".repeat(64),
        catalogRevision: prepared.state.catalogRevision,
        libraryBindingDigest: prepared.state.libraryBindingDigest,
      }),
    protocolError("preview_selection_mismatch"),
  );

  const challenge = issueChallenge(prepared);
  const receipt = prepared.store.confirm(challenge, "app");
  assert.equal(receipt.confirmationMode, "app");
  assert.throws(
    () => prepared.store.confirm(challenge, "headless"),
    protocolError("preview_challenge_invalid"),
  );
});

test("receipts bind provider, selector, preview, catalog, root and are consumed once", () => {
  const prepared = preparedStore();
  const receipt = prepared.store.confirm(issueChallenge(prepared), "headless");
  const valid = {
    previewReceipt: receipt.previewReceipt,
    providerId: LOCAL_LIBRARY_PROVIDER_ID,
    exactSelector: selector,
    previewSha256: "c".repeat(64),
    catalogRevision: prepared.state.catalogRevision,
    libraryBindingDigest: prepared.state.libraryBindingDigest,
  };
  assert.equal(prepared.store.requireReceipt(valid).confirmationMode, "headless");
  assert.throws(
    () => prepared.store.requireReceipt({ ...valid, exactSelector: otherSelector }),
    protocolError("preview_receipt_mismatch"),
  );
  assert.throws(
    () => prepared.store.requireReceipt({ ...valid, previewSha256: "d".repeat(64) }),
    protocolError("preview_stale"),
  );
  assert.throws(
    () => prepared.store.requireReceipt({ ...valid, catalogRevision: "catalog-changed" }),
    protocolError("preview_stale"),
  );
  assert.throws(
    () => prepared.store.requireReceipt({ ...valid, libraryBindingDigest: "root-changed" }),
    protocolError("preview_stale"),
  );
  prepared.store.consumeReceipt(receipt.previewReceipt);
  assert.throws(
    () => prepared.store.requireReceipt(valid),
    protocolError("preview_receipt_used"),
  );
});

test("cursors bind the query and catalog revision and all tokens die on restart", () => {
  const prepared = preparedStore();
  const cursor = prepared.store.createCursor({
    resultSetId: prepared.resultSetId,
    queryDigest: prepared.state.queryDigest,
    catalogRevision: prepared.state.catalogRevision,
    libraryBindingDigest: prepared.state.libraryBindingDigest,
    offset: 6,
    limit: 6,
  });
  assert.equal(prepared.store.resolveCursor(cursor).offset, 6);
  assert.throws(
    () =>
      prepared.store.requireResultSet({
        resultSetId: prepared.resultSetId,
        queryDigest: "different-query",
        catalogRevision: prepared.state.catalogRevision,
        libraryBindingDigest: prepared.state.libraryBindingDigest,
      }),
    protocolError("search_results_stale"),
  );

  const receipt = prepared.store.confirm(issueChallenge(prepared), "app");
  const restarted = new PreviewConfirmationStore();
  assert.throws(() => restarted.resolveCursor(cursor), protocolError("search_results_stale"));
  assert.throws(
    () => restarted.getResultSet(prepared.resultSetId),
    protocolError("search_results_stale"),
  );
  assert.throws(
    () => restarted.getReceipt(receipt.previewReceipt),
    protocolError("preview_required"),
  );
});
