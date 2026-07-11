"use strict";

const DEFAULT_MODEL = "gemini-flash-latest";
const FALLBACK_MODEL = "gemini-flash-lite-latest";
const FALLBACK_MODEL_LABEL = "Gemini Flash-Lite Latest";
const API_KEY_STORAGE_KEY = "menuTranslator.geminiApiKey";
const API_KEY_HASH_PARAM = "key";
const MODEL_STORAGE_KEY = "menuTranslator.geminiModel";
const PHOTO_STORAGE_DB_NAME = "menual.photos";
const PHOTO_STORAGE_DB_VERSION = 1;
const PHOTO_STORAGE_STORE_NAME = "snapshots";
const PHOTO_STORAGE_RECORD_ID = "current";
const PHOTO_SESSION_STORAGE_KEY = "menual.photoSnapshot";
const PROCESSED_RESULTS_RECORD_ID = "processed-results";
const PROCESSED_RESULTS_SESSION_STORAGE_KEY = "menual.processedResults";
const CART_RECORD_ID = "cart";
const CART_SESSION_STORAGE_KEY = "menual.cart";
const PHOTO_STORAGE_SAVE_DELAY_MS = 100;
const PHOTO_STORAGE_TIMEOUT_MS = 1200;
const LARGE_IMAGE_WARNING_BYTES = 2 * 1024 * 1024;
const INLINE_PAYLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
const PAYLOAD_SAFETY_LIMIT_BYTES = 19 * 1024 * 1024;
const RESULT_SWIPE_THRESHOLD_PX = 78;
const RESULT_SWIPE_MAX_PX = 118;
const RESULT_SWIPE_INTENT_PX = 10;
const RESULT_SWIPE_AXIS_LOCK_RATIO = 0.75;
const SUPPORTED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const TARGET_LANGUAGES = {
  "zh-TW": {
    label: "Traditional Chinese",
    promptValue: "Traditional Chinese (Taiwan)",
  },
  en: {
    label: "English",
    promptValue: "English",
  },
};

const GEMINI_MODELS = {
  flash: {
    label: "Flash",
    apiModel: DEFAULT_MODEL,
  },
  lite: {
    label: "Lite",
    apiModel: FALLBACK_MODEL,
  },
};

const RESTORABLE_RESULT_STATUSES = new Set(["done", "error"]);

const MENU_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          translatedText: {
            type: "string",
            description: "The menu item translated into the requested target language.",
          },
          originalText: {
            type: "string",
            description: "The original visible menu item text from the image.",
          },
          price: {
            type: "string",
            description: "The visible price copied exactly from the menu, or an empty string.",
          },
          note: {
            type: "string",
            description: "English note about uncertainty, truncation, inference, or readability issues.",
          },
        },
        required: ["translatedText", "originalText", "price", "note"],
      },
    },
  },
  required: ["items"],
};

const state = {
  files: [],
  results: [],
  cart: [],
  activeImageId: "",
  modalResolver: null,
  replaceTargetImageId: "",
  copyResetTimer: 0,
  orderCopyResetTimer: 0,
  photoSaveTimer: 0,
  photoSavePromise: Promise.resolve(),
  activeSwipe: null,
  lastPayloadEstimate: 0,
  isBusy: false,
  isRestoringPhotos: false,
  photoSaveFailed: false,
};

let photoStorageDbPromise = null;
const photoDataUrlCache = new WeakMap();
const photoDataUrlPromiseCache = new WeakMap();

const elements = {
  form: document.querySelector("#translator-form"),
  apiKey: document.querySelector("#api-key"),
  apiKeyButton: document.querySelector("#api-key-button"),
  apiKeyState: document.querySelector("#api-key-state"),
  apiKeyCheck: document.querySelector("#api-key-check"),
  targetLanguage: document.querySelector("#target-language"),
  imageInput: document.querySelector("#image-input"),
  replaceImageInput: document.querySelector("#replace-image-input"),
  uploadZone: document.querySelector(".upload-zone"),
  analyzeButton: document.querySelector("#analyze-button"),
  clearButton: document.querySelector("#clear-button"),
  compressAllButton: document.querySelector("#compress-all-button"),
  uploadHeaderTools: document.querySelector(".upload-header-tools"),
  fileList: document.querySelector("#file-list"),
  payloadMeter: document.querySelector("#payload-meter"),
  oversizePanel: document.querySelector("#oversize-panel"),
  oversizeMessage: document.querySelector("#oversize-message"),
  batchButton: document.querySelector("#batch-button"),
  compressButton: document.querySelector("#compress-button"),
  removeModeButton: document.querySelector("#remove-mode-button"),
  statusMessage: document.querySelector("#status-message"),
  progressBar: document.querySelector("#progress-bar"),
  progressFill: document.querySelector("#progress-fill"),
  resultsTabs: document.querySelector("#results-tabs"),
  resultsList: document.querySelector("#results-list"),
  copyButton: document.querySelector("#copy-button"),
  noteOverlay: document.querySelector("#note-overlay"),
  noteCloseButton: document.querySelector("#note-close-button"),
  noteTitle: document.querySelector("#note-title"),
  noteText: document.querySelector("#note-text"),
  orderBar: document.querySelector("#order-bar"),
  orderBarButton: document.querySelector("#order-bar-button"),
  orderBarIcon: document.querySelector("#order-bar-icon"),
  orderBarCount: document.querySelector("#order-bar-count"),
  orderBarSwipeIcon: document.querySelector("#order-bar-swipe-icon"),
  orderBarHintSuffix: document.querySelector("#order-bar-hint-suffix"),
  orderBarHintCartIcon: document.querySelector("#order-bar-hint-cart-icon"),
  orderModal: document.querySelector("#order-modal"),
  orderModalClose: document.querySelector("#order-modal-close"),
  orderModalCount: document.querySelector("#order-modal-count"),
  orderCopyButton: document.querySelector("#order-copy-button"),
  orderList: document.querySelector("#order-list"),
  orderTotalRow: document.querySelector("#order-total-row"),
  orderTotalAmount: document.querySelector("#order-total-amount"),
  appModal: document.querySelector("#app-modal"),
  appModalClose: document.querySelector("#app-modal-close"),
  appModalBody: document.querySelector("#app-modal-body"),
  appModalActions: document.querySelector("#app-modal-actions"),
  appModalCancel: document.querySelector("#app-modal-cancel"),
  appModalConfirm: document.querySelector("#app-modal-confirm"),
  keyModal: document.querySelector("#key-modal"),
  keyModalClose: document.querySelector("#key-modal-close"),
  keyModalInput: document.querySelector("#key-modal-input"),
  keyModalClear: document.querySelector("#key-modal-clear"),
  keyModalSave: document.querySelector("#key-modal-save"),
  modelChoiceField: document.querySelector("#model-choice-field"),
  modelInputs: Array.from(document.querySelectorAll("input[name='geminiModel']")),
};

init();

function init() {
  populateLanguageSelect();
  elements.apiKey.value = getInitialApiKey();
  updateApiKeyState();
  attachEvents();
  renderFiles();
  renderResults();
  renderCart();
  updateOversizePanel();
  restoreUploadedPhotos();
}

function populateLanguageSelect() {
  const fragment = document.createDocumentFragment();

  Object.entries(TARGET_LANGUAGES).forEach(([code, config]) => {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = config.label;
    fragment.append(option);
  });

  elements.targetLanguage.append(fragment);
  elements.targetLanguage.value = "zh-TW";
}

function preventDoubleTapZoom() {
  let lastTouchEnd = 0;

  document.addEventListener(
    "touchend",
    (event) => {
      if (event.touches.length > 0) {
        return;
      }

      const now = Date.now();

      if (now - lastTouchEnd <= 300) {
        event.preventDefault();
      }

      lastTouchEnd = now;
    },
    { passive: false },
  );
}

function attachEvents() {
  preventDoubleTapZoom();

  elements.apiKeyButton.addEventListener("click", openKeyModal);
  elements.keyModalClose.addEventListener("click", closeKeyModal);
  elements.keyModal.addEventListener("click", (event) => {
    if (event.target === elements.keyModal) {
      closeKeyModal();
    }
  });
  elements.keyModalSave.addEventListener("click", saveApiKeyFromModal);
  elements.keyModalClear.addEventListener("click", clearApiKeyFromModal);
  elements.modelChoiceField.addEventListener("click", toggleKeyModalModelChoice);
  window.addEventListener("hashchange", syncApiKeyFromHash);
  elements.uploadHeaderTools.addEventListener("click", triggerUploadFromEmptyState);
  elements.uploadHeaderTools.addEventListener("keydown", triggerUploadFromEmptyState);

  elements.imageInput.addEventListener("change", (event) => {
    addFiles(Array.from(event.target.files || []));
    elements.imageInput.value = "";
  });

  elements.replaceImageInput.addEventListener("change", (event) => {
    const [file] = Array.from(event.target.files || []);

    if (file && state.replaceTargetImageId) {
      replaceImage(state.replaceTargetImageId, file);
    }

    state.replaceTargetImageId = "";
    elements.replaceImageInput.value = "";
  });

  elements.uploadZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.uploadZone.classList.add("drag-over");
  });

  elements.uploadZone.addEventListener("dragleave", () => {
    elements.uploadZone.classList.remove("drag-over");
  });

  elements.uploadZone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.uploadZone.classList.remove("drag-over");
    addFiles(Array.from(event.dataTransfer.files || []));
  });

  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.files.length === 0) {
      elements.imageInput.click();
      return;
    }

    if (!hasApiKey()) {
      await showAppAlert("API key required", "Paste a Gemini API key before analyzing.");
      return;
    }

    const entriesToTranslate = getMainTranslateEntries(state.files);

    if (entriesToTranslate.length === 0) {
      await showNothingToTranslateAlert();
      return;
    }

    analyzeImages({ entries: entriesToTranslate, forceCompress: false });
  });

  elements.clearButton.addEventListener("click", () => {
    revokePreviewUrls(state.files);
    state.files = [];
    state.results = [];
    state.cart = [];
    state.activeImageId = "";
    setStatus("Images cleared.");
    clearUploadedPhotoSnapshot();
    renderFiles();
    renderResults();
    renderCart();
    updateOversizePanel();
  });

  elements.batchButton.addEventListener("click", async () => {
    const entriesToTranslate = getMainTranslateEntries(state.files);
    const safeEntries = entriesToTranslate.filter((entry) => !isEntryOversized(entry));

    if (safeEntries.length === 0) {
      const message =
        entriesToTranslate.length === 0
          ? getNothingToTranslateMessage()
          : "No safe images are available. Compress or remove oversized images first.";
      setStatus(message, "error");
      await showAppAlert(entriesToTranslate.length === 0 ? "Nothing to translate" : "No safe images", message);
      return;
    }

    analyzeImages({ entries: safeEntries, forceCompress: false });
  });

  elements.compressAllButton.addEventListener("click", () => {
    compressUploadedImages(state.files);
  });

  elements.compressButton.addEventListener("click", () => {
    compressUploadedImages(state.files);
  });

  elements.removeModeButton.addEventListener("click", () => {
    setStatus("Remove one or more images, then run Analyze again.");
    elements.fileList.focus();
  });

  elements.copyButton.addEventListener("click", copyResultsText);
  window.addEventListener("pagehide", flushUploadedPhotosBeforeUnload);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushUploadedPhotosBeforeUnload();
    }
  });
  elements.orderBarButton.addEventListener("click", openOrderModal);
  elements.orderModalClose.addEventListener("click", closeOrderModal);
  elements.orderCopyButton.addEventListener("click", copyOrderText);
  elements.orderModal.addEventListener("click", (event) => {
    if (event.target === elements.orderModal) {
      closeOrderModal();
    }
  });
  elements.noteCloseButton.addEventListener("click", closeNote);
  elements.noteOverlay.addEventListener("click", (event) => {
    if (event.target === elements.noteOverlay) {
      closeNote();
    }
  });

  elements.appModalClose.addEventListener("click", () => closeAppModal(false));
  elements.appModalCancel.addEventListener("click", () => closeAppModal(false));
  elements.appModalConfirm.addEventListener("click", () => closeAppModal(true));
  elements.appModal.addEventListener("click", (event) => {
    if (event.target === elements.appModal) {
      closeAppModal(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.noteOverlay.hidden) {
      closeNote();
    }

    if (event.key === "Escape" && !elements.appModal.hidden) {
      closeAppModal(false);
    }

    if (event.key === "Escape" && !elements.orderModal.hidden) {
      closeOrderModal();
    }

    if (event.key === "Escape" && !elements.keyModal.hidden) {
      closeKeyModal();
    }
  });
}

function addFiles(files) {
  const accepted = [];
  const rejected = [];

  files.forEach((file) => {
    const type = getFileType(file);

    if (!SUPPORTED_TYPES.has(type)) {
      rejected.push(file.name);
      return;
    }

    accepted.push({
      id: createId(),
      file,
      name: file.name,
      type,
      originalSize: file.size,
      workingFile: file,
      previewUrl: URL.createObjectURL(file),
      status: "idle",
      results: [],
      error: "",
      shouldSuggestCompression: file.size >= LARGE_IMAGE_WARNING_BYTES,
      compressionSuggestionShown: false,
      wasCompressed: false,
    });
  });

  if (accepted.length > 0) {
    state.files.push(...accepted);
    if (!state.activeImageId) {
      state.activeImageId = accepted[0].id;
    }
    setStatus(`${accepted.length} image${accepted.length === 1 ? "" : "s"} added.`);
  }

  if (rejected.length > 0) {
    setStatus(`Unsupported file type: ${rejected.join(", ")}`, "error");
  }

  renderFiles();
  renderResults();
  renderCart();
  updateOversizePanel();
  saveUploadedPhotos();
  maybeSuggestCompression(accepted);
}

function renderFiles() {
  elements.fileList.innerHTML = "";

  if (state.files.length === 0) {
    elements.fileList.hidden = true;
    updatePayloadMeter();
    return;
  }

  elements.fileList.hidden = false;

  if (!state.files.some((entry) => entry.id === state.activeImageId)) {
    state.activeImageId = state.files[0].id;
  }

  const fragment = document.createDocumentFragment();

  state.files.forEach((entry) => {
    const item = document.createElement("li");
    item.className = `image-slide is-${entry.status}${entry.id === state.activeImageId ? " is-active" : ""}`;

    const tabButton = document.createElement("button");
    tabButton.type = "button";
    tabButton.className = "image-thumb-button";
    tabButton.setAttribute("role", "tab");
    tabButton.setAttribute("aria-selected", String(entry.id === state.activeImageId));
    tabButton.setAttribute("aria-controls", "results-list");
    tabButton.addEventListener("click", () => handleImageThumbClick(entry.id));

    const frame = document.createElement("span");
    frame.className = "image-thumb-frame";

    const image = document.createElement("img");
    image.src = entry.previewUrl;
    image.alt = entry.name;
    image.addEventListener("error", () => {
      frame.classList.add("is-broken");
    });

    const fallback = document.createElement("span");
    fallback.className = "image-thumb-fallback";
    fallback.textContent = "IMG";

    const status = document.createElement("span");
    status.className = "image-process-status";
    status.setAttribute("aria-hidden", "true");
    status.textContent = getImageStatusSymbol(entry.status);

    frame.append(image, fallback, status);

    const name = document.createElement("span");
    name.className = "image-slide-name";
    name.textContent = entry.name;

    const meta = document.createElement("span");
    meta.className = "image-slide-meta";
    meta.textContent = getImageMeta(entry);

    tabButton.append(frame, name, meta);

    const actions = createImageActions(entry);

    item.append(tabButton, actions);
    fragment.append(item);
  });

  elements.fileList.append(fragment);
  updatePayloadMeter();
  scrollActiveCarouselItemIntoView();
}

function removeFile(id) {
  const removedEntry = state.files.find((entry) => entry.id === id);
  if (removedEntry?.previewUrl) {
    URL.revokeObjectURL(removedEntry.previewUrl);
  }

  state.files = state.files.filter((entry) => entry.id !== id);
  removeCartEntriesForImages([id]);
  if (state.activeImageId === id) {
    state.activeImageId = state.files[0]?.id || "";
  }
  updateFlatResults();
  setStatus("Image removed.");
  renderFiles();
  renderResults();
  renderCart();
  updateOversizePanel();
  saveUploadedPhotos();
  saveProcessedResults();
}

function createImageActions(entry) {
  const actions = document.createElement("div");
  actions.className = "image-slide-actions";

  const wasSubmitted = isRetryEntry(entry);
  const actionLabel = wasSubmitted ? "Retry" : "Analyze";
  const actionIcon = wasSubmitted ? "fa-rotate-right" : "fa-magnifying-glass";
  const analyzeButton = createImageActionButton(actionLabel, actionIcon, () => analyzeImage(entry.id));
  analyzeButton.disabled = state.isBusy || isEntryOversized(entry);
  analyzeButton.title = isEntryOversized(entry) ? "Compress this image first" : `${actionLabel} ${entry.name}`;

  const removeButton = createImageActionButton("Delete", "fa-xmark", () => removeFile(entry.id), "is-danger is-icon-only");
  removeButton.disabled = state.isBusy;

  actions.append(analyzeButton, removeButton);
  return actions;
}

function createImageActionButton(label, iconClass, onClick, variant = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `image-action-chip${variant ? ` ${variant}` : ""}`;
  button.setAttribute("aria-label", label);

  const labelElement = document.createElement("span");
  labelElement.textContent = label;
  button.append(createIcon(iconClass), labelElement);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function createIcon(iconClass) {
  const icon = document.createElement("i");
  icon.className = `fa-solid ${iconClass}`;
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function handleImageThumbClick(id) {
  if (state.activeImageId === id) {
    if (!state.isBusy) {
      startReplaceImage(id);
    }
    return;
  }

  selectImage(id);
}

function selectImage(id) {
  state.activeImageId = id;
  renderFiles();
  renderResults();
  renderCart();
  scheduleUploadedPhotosSave();
}

function analyzeImage(id) {
  const entry = state.files.find((fileEntry) => fileEntry.id === id);
  if (!entry) {
    return;
  }

  state.activeImageId = id;
  analyzeImages({ entries: [entry], forceCompress: false });
}

function startReplaceImage(id) {
  state.replaceTargetImageId = id;
  elements.replaceImageInput.click();
}

function replaceImage(id, file) {
  const type = getFileType(file);

  if (!SUPPORTED_TYPES.has(type)) {
    setStatus(`Unsupported file type: ${file.name}`, "error");
    return;
  }

  const index = state.files.findIndex((entry) => entry.id === id);
  if (index === -1) {
    return;
  }

  const previousEntry = state.files[index];
  if (previousEntry.previewUrl) {
    URL.revokeObjectURL(previousEntry.previewUrl);
  }

  state.files[index] = {
    ...previousEntry,
    file,
    name: file.name,
    type,
    originalSize: file.size,
    workingFile: file,
    previewUrl: URL.createObjectURL(file),
    status: "idle",
    results: [],
    error: "",
    shouldSuggestCompression: file.size >= LARGE_IMAGE_WARNING_BYTES,
    compressionSuggestionShown: false,
    wasCompressed: false,
  };

  state.activeImageId = id;
  removeCartEntriesForImages([id]);
  updateFlatResults();
  setStatus("Image replaced. Run Analyze to process it.");
  renderFiles();
  renderResults();
  renderCart();
  updateOversizePanel();
  saveUploadedPhotos();
  saveProcessedResults();
  maybeSuggestCompression([state.files[index]]);
}

function getActiveEntry() {
  return state.files.find((entry) => entry.id === state.activeImageId) || null;
}

function hasAnyResults() {
  return state.files.some((entry) => entry.results.length > 0);
}

function isRetryEntry(entry) {
  return entry.status === "done" || entry.status === "error";
}

function getMainTranslateEntries(entries) {
  return entries.filter((entry) => entry.status !== "done");
}

function updateFlatResults() {
  state.results = state.files.flatMap((entry) => entry.results);
}

function replaceEntries(updatedEntries) {
  const updatedById = new Map(updatedEntries.map((entry) => [entry.id, entry]));
  state.files = state.files.map((entry) => updatedById.get(entry.id) || entry);
  scheduleUploadedPhotosSave();
}

async function restoreUploadedPhotos() {
  state.isRestoringPhotos = true;

  try {
    const snapshots = await readUploadedPhotoSnapshots();
    let snapshot = null;
    let restoredFiles = [];

    if (state.files.length > 0) {
      return;
    }

    for (const candidate of snapshots) {
      if (!candidate || !Array.isArray(candidate.files) || candidate.files.length === 0) {
        continue;
      }

      const candidateFiles = candidate.files.map(restoreUploadedPhotoEntry).filter(Boolean);

      if (candidateFiles.length > 0) {
        snapshot = candidate;
        restoredFiles = candidateFiles;
        break;
      }
    }

    if (restoredFiles.length === 0) {
      return;
    }

    state.files = restoredFiles;
    state.results = [];
    state.cart = [];
    state.activeImageId = restoredFiles.some((entry) => entry.id === snapshot.activeImageId)
      ? snapshot.activeImageId
      : restoredFiles[0].id;

    await restoreProcessedResultsIntoFiles(restoredFiles);
    await restoreCartIntoState(restoredFiles);
    updateFlatResults();
    renderFiles();
    renderResults();
    renderCart();
    updateOversizePanel();
    const restoredResultCount = state.results.length;
    const imageText = `${restoredFiles.length} image${restoredFiles.length === 1 ? "" : "s"}`;
    const resultText = `${restoredResultCount} item${restoredResultCount === 1 ? "" : "s"}`;
    setStatus(restoredResultCount > 0 ? `Restored ${imageText} and ${resultText}.` : `Restored ${imageText}. Run Analyze to translate.`, "success");
  } catch (error) {
    console.warn("Could not restore uploaded photos.", error);
  } finally {
    state.isRestoringPhotos = false;
  }
}

function restoreUploadedPhotoEntry(entry) {
  const workingFile =
    normalizeRestoredPhotoFile(entry?.workingFile, entry?.name, entry?.type) ||
    dataUrlToFile(entry?.workingFileDataUrl, entry?.name, entry?.type);

  if (!workingFile) {
    return null;
  }

  const type = entry?.type || getFileType(workingFile);
  const originalSize = Number(entry?.originalSize) || workingFile.size;

  if (!SUPPORTED_TYPES.has(type)) {
    return null;
  }

  return {
    id: entry?.id || createId(),
    file: workingFile,
    name: entry?.name || workingFile.name || "menu-image",
    type,
    originalSize,
    workingFile,
    previewUrl: URL.createObjectURL(workingFile),
    status: "idle",
    results: [],
    error: "",
    shouldSuggestCompression: Boolean(entry?.shouldSuggestCompression ?? (originalSize >= LARGE_IMAGE_WARNING_BYTES)),
    compressionSuggestionShown: Boolean(entry?.compressionSuggestionShown),
    wasCompressed: Boolean(entry?.wasCompressed),
    processingModelLabel: "",
  };
}

async function restoreProcessedResultsIntoFiles(files) {
  try {
    const snapshot = await readProcessedResultsSnapshot();

    if (!snapshot || !Array.isArray(snapshot.entries)) {
      return;
    }

    const resultEntries = new Map(snapshot.entries.map((entry) => [entry.imageId, entry]));

    files.forEach((fileEntry) => {
      const resultEntry = resultEntries.get(fileEntry.id);

      if (!resultEntry || !doesProcessedResultMatchFile(resultEntry, fileEntry)) {
        return;
      }

      if (resultEntry.status === "done") {
        const results = normalizeProcessedResults(resultEntry.results);

        if (results.length === 0) {
          return;
        }

        fileEntry.status = "done";
        fileEntry.results = results;
        fileEntry.error = "";
        return;
      }

      if (resultEntry.status === "error") {
        fileEntry.status = "error";
        fileEntry.results = [];
        fileEntry.error = resultEntry.error || "This image could not be processed.";
      }
    });
  } catch (error) {
    console.warn("Could not restore processed results.", error);
  }
}

function normalizeProcessedResults(results) {
  if (!Array.isArray(results)) {
    return [];
  }

  return results.map(normalizeItem).filter((item) => item.translatedText || item.originalText);
}

function doesProcessedResultMatchFile(resultEntry, fileEntry) {
  return (
    resultEntry.name === fileEntry.name &&
    resultEntry.type === fileEntry.type &&
    Number(resultEntry.originalSize) === Number(fileEntry.originalSize) &&
    Number(resultEntry.workingSize) === Number(fileEntry.workingFile.size)
  );
}

function normalizeRestoredPhotoFile(value, name, type) {
  if (!(value instanceof Blob)) {
    return null;
  }

  if (value instanceof File) {
    return value;
  }

  return new File([value], name || "menu-image", { type: type || value.type || "image/jpeg" });
}

function scheduleUploadedPhotosSave() {
  if (state.isRestoringPhotos) {
    return;
  }

  if (state.photoSaveTimer) {
    window.clearTimeout(state.photoSaveTimer);
  }

  state.photoSaveTimer = window.setTimeout(() => {
    state.photoSaveTimer = 0;
    saveUploadedPhotos();
  }, PHOTO_STORAGE_SAVE_DELAY_MS);
}

function saveUploadedPhotos() {
  if (state.isRestoringPhotos) {
    return Promise.resolve();
  }

  if (state.photoSaveTimer) {
    window.clearTimeout(state.photoSaveTimer);
    state.photoSaveTimer = 0;
  }

  state.photoSavePromise = state.photoSavePromise.catch(() => null).then(saveUploadedPhotosNow);
  return state.photoSavePromise;
}

function flushUploadedPhotosBeforeUnload() {
  writeUploadedPhotoSessionSnapshotSync();
  saveUploadedPhotos();
  saveProcessedResults();
  saveCartSnapshot();
}

async function saveUploadedPhotosNow() {
  try {
    if (state.files.length === 0) {
      await deleteUploadedPhotoSnapshot();
      state.photoSaveFailed = false;
      return;
    }

    const snapshot = createUploadedPhotoSnapshot();
    const saveResults = await Promise.allSettled([
      withPhotoStorageTimeout(writeUploadedPhotoSnapshotRecord(snapshot)),
      writeUploadedPhotoSessionSnapshot(snapshot),
    ]);

    if (saveResults.every((result) => result.status === "rejected")) {
      throw saveResults[0].reason;
    }

    state.photoSaveFailed = false;
  } catch (error) {
    if (!state.photoSaveFailed) {
      state.photoSaveFailed = true;
      console.warn("Could not preserve uploaded photos.", error);
      setStatus("This browser could not preserve uploaded photos for reload.", "error");
    }
  }
}

function clearUploadedPhotoSnapshot() {
  if (state.photoSaveTimer) {
    window.clearTimeout(state.photoSaveTimer);
    state.photoSaveTimer = 0;
  }

  state.photoSavePromise = state.photoSavePromise
    .catch(() => null)
    .then(deleteUploadedPhotoSnapshot)
    .then(() => {
      state.photoSaveFailed = false;
    })
    .catch((error) => {
      console.warn("Could not clear uploaded photo snapshot.", error);
    });
  deleteProcessedResultsSnapshot().catch((error) => {
    console.warn("Could not clear processed results snapshot.", error);
  });
  deleteCartSnapshot().catch((error) => {
    console.warn("Could not clear cart snapshot.", error);
  });
}

function createUploadedPhotoSnapshot() {
  return {
    id: PHOTO_STORAGE_RECORD_ID,
    savedAt: Date.now(),
    activeImageId: state.activeImageId,
    files: state.files.map(serializeUploadedPhotoEntry),
  };
}

function serializeUploadedPhotoEntry(entry) {
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    originalSize: entry.originalSize,
    workingFile: entry.workingFile,
    shouldSuggestCompression: Boolean(entry.shouldSuggestCompression),
    compressionSuggestionShown: Boolean(entry.compressionSuggestionShown),
    wasCompressed: Boolean(entry.wasCompressed),
  };
}

async function serializeUploadedPhotoSessionEntry(entry) {
  return {
    ...entry,
    workingFile: undefined,
    workingFileDataUrl: await fileToDataUrl(entry.workingFile),
  };
}

async function readUploadedPhotoSnapshots() {
  const results = await Promise.allSettled([
    withPhotoStorageTimeout(readUploadedPhotoSnapshotRecord()),
    Promise.resolve().then(readUploadedPhotoSessionSnapshot),
  ]);
  const snapshots = results
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value)
    .sort((a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0));

  if (snapshots.length > 0) {
    return snapshots;
  }

  const errors = results.filter((result) => result.status === "rejected");

  if (errors.length === results.length) {
    throw errors[0].reason;
  }

  return [];
}

function readUploadedPhotoSnapshotRecord() {
  return withPhotoStorageStore("readonly", (store) => store.get(PHOTO_STORAGE_RECORD_ID));
}

function writeUploadedPhotoSnapshotRecord(snapshot) {
  return withPhotoStorageStore("readwrite", (store) => store.put(snapshot));
}

function deleteUploadedPhotoSnapshotRecord() {
  return withPhotoStorageStore("readwrite", (store) => store.delete(PHOTO_STORAGE_RECORD_ID));
}

async function writeUploadedPhotoSessionSnapshot(snapshot) {
  const sessionSnapshot = {
    ...snapshot,
    files: await Promise.all(snapshot.files.map(serializeUploadedPhotoSessionEntry)),
  };

  sessionStorage.setItem(PHOTO_SESSION_STORAGE_KEY, JSON.stringify(sessionSnapshot));
}

function writeUploadedPhotoSessionSnapshotSync() {
  if (state.isRestoringPhotos || state.files.length === 0) {
    return false;
  }

  try {
    const snapshot = createUploadedPhotoSnapshot();
    const files = [];

    for (const entry of snapshot.files) {
      const dataUrl = photoDataUrlCache.get(entry.workingFile);

      if (!dataUrl) {
        return false;
      }

      files.push({
        ...entry,
        workingFile: undefined,
        workingFileDataUrl: dataUrl,
      });
    }

    sessionStorage.setItem(PHOTO_SESSION_STORAGE_KEY, JSON.stringify({ ...snapshot, files }));
    return true;
  } catch (error) {
    console.warn("Could not preserve uploaded photos before unload.", error);
    return false;
  }
}

function readUploadedPhotoSessionSnapshot() {
  const value = sessionStorage.getItem(PHOTO_SESSION_STORAGE_KEY);

  if (!value) {
    return null;
  }

  return JSON.parse(value);
}

function deleteUploadedPhotoSessionSnapshot() {
  sessionStorage.removeItem(PHOTO_SESSION_STORAGE_KEY);
}

async function deleteUploadedPhotoSnapshot() {
  const results = await Promise.allSettled([
    withPhotoStorageTimeout(deleteUploadedPhotoSnapshotRecord()),
    Promise.resolve().then(deleteUploadedPhotoSessionSnapshot),
  ]);

  if (results.every((result) => result.status === "rejected")) {
    throw results[0].reason;
  }
}

function createProcessedResultsSnapshot() {
  return {
    id: PROCESSED_RESULTS_RECORD_ID,
    savedAt: Date.now(),
    entries: state.files.map(serializeProcessedResultEntry).filter(Boolean),
  };
}

function serializeProcessedResultEntry(entry) {
  if (!RESTORABLE_RESULT_STATUSES.has(entry.status)) {
    return null;
  }

  if (entry.status === "done" && entry.results.length === 0) {
    return null;
  }

  return {
    imageId: entry.id,
    name: entry.name,
    type: entry.type,
    originalSize: entry.originalSize,
    workingSize: entry.workingFile.size,
    status: entry.status,
    results: entry.status === "done" ? entry.results : [],
    error: entry.status === "error" ? entry.error || "" : "",
  };
}

async function saveProcessedResults() {
  if (state.isRestoringPhotos) {
    return;
  }

  const snapshot = createProcessedResultsSnapshot();

  try {
    const saveResults = await Promise.allSettled([
      withPhotoStorageTimeout(writeProcessedResultsSnapshotRecord(snapshot)),
      Promise.resolve().then(() => writeProcessedResultsSessionSnapshot(snapshot)),
    ]);

    if (saveResults.every((result) => result.status === "rejected")) {
      throw saveResults[0].reason;
    }
  } catch (error) {
    console.warn("Could not preserve processed results.", error);
  }
}

async function readProcessedResultsSnapshot() {
  const results = await Promise.allSettled([
    withPhotoStorageTimeout(readProcessedResultsSnapshotRecord()),
    Promise.resolve().then(readProcessedResultsSessionSnapshot),
  ]);
  const snapshots = results
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value)
    .sort((a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0));

  return snapshots[0] || null;
}

function readProcessedResultsSnapshotRecord() {
  return withPhotoStorageStore("readonly", (store) => store.get(PROCESSED_RESULTS_RECORD_ID));
}

function writeProcessedResultsSnapshotRecord(snapshot) {
  return withPhotoStorageStore("readwrite", (store) => store.put(snapshot));
}

function deleteProcessedResultsSnapshotRecord() {
  return withPhotoStorageStore("readwrite", (store) => store.delete(PROCESSED_RESULTS_RECORD_ID));
}

function writeProcessedResultsSessionSnapshot(snapshot) {
  sessionStorage.setItem(PROCESSED_RESULTS_SESSION_STORAGE_KEY, JSON.stringify(snapshot));
}

function readProcessedResultsSessionSnapshot() {
  const value = sessionStorage.getItem(PROCESSED_RESULTS_SESSION_STORAGE_KEY);

  if (!value) {
    return null;
  }

  return JSON.parse(value);
}

function deleteProcessedResultsSessionSnapshot() {
  sessionStorage.removeItem(PROCESSED_RESULTS_SESSION_STORAGE_KEY);
}

async function deleteProcessedResultsSnapshot() {
  const results = await Promise.allSettled([
    withPhotoStorageTimeout(deleteProcessedResultsSnapshotRecord()),
    Promise.resolve().then(deleteProcessedResultsSessionSnapshot),
  ]);

  if (results.every((result) => result.status === "rejected")) {
    throw results[0].reason;
  }
}

async function restoreCartIntoState(files) {
  try {
    const snapshot = await readCartSnapshot();

    if (!snapshot || !Array.isArray(snapshot.items)) {
      return;
    }

    const entriesById = new Map(files.map((entry) => [entry.id, entry]));
    state.cart = snapshot.items
      .map((item) => restoreCartSnapshotItem(item, entriesById))
      .filter(Boolean);
  } catch (error) {
    console.warn("Could not restore cart.", error);
  }
}

function restoreCartSnapshotItem(item, entriesById) {
  const imageId = item?.imageId || "";
  const entry = entriesById.get(imageId);

  if (!entry || entry.status !== "done") {
    return null;
  }

  const matchingResult = entry.results.find((result) => createCartItemKey(result, imageId) === item.itemKey);

  if (!matchingResult) {
    return null;
  }

  const quantity = Math.max(1, Math.floor(Number(item.quantity) || 0));

  return {
    id: item.id || createId(),
    imageId,
    itemKey: item.itemKey,
    originalText: matchingResult.originalText || item.originalText || "",
    translatedText: matchingResult.translatedText || item.translatedText || "",
    price: matchingResult.price || item.price || "",
    quantity,
  };
}

function createCartSnapshot() {
  return {
    id: CART_RECORD_ID,
    savedAt: Date.now(),
    items: state.cart.map(serializeCartSnapshotItem),
  };
}

function serializeCartSnapshotItem(item) {
  return {
    id: item.id,
    imageId: item.imageId,
    itemKey: item.itemKey,
    originalText: item.originalText,
    translatedText: item.translatedText,
    price: item.price,
    quantity: item.quantity,
  };
}

async function saveCartSnapshot() {
  if (state.isRestoringPhotos) {
    return;
  }

  const snapshot = createCartSnapshot();

  try {
    const saveResults = await Promise.allSettled([
      withPhotoStorageTimeout(writeCartSnapshotRecord(snapshot)),
      Promise.resolve().then(() => writeCartSessionSnapshot(snapshot)),
    ]);

    if (saveResults.every((result) => result.status === "rejected")) {
      throw saveResults[0].reason;
    }
  } catch (error) {
    console.warn("Could not preserve cart.", error);
  }
}

async function readCartSnapshot() {
  const results = await Promise.allSettled([
    withPhotoStorageTimeout(readCartSnapshotRecord()),
    Promise.resolve().then(readCartSessionSnapshot),
  ]);
  const snapshots = results
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value)
    .sort((a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0));

  return snapshots[0] || null;
}

function readCartSnapshotRecord() {
  return withPhotoStorageStore("readonly", (store) => store.get(CART_RECORD_ID));
}

function writeCartSnapshotRecord(snapshot) {
  return withPhotoStorageStore("readwrite", (store) => store.put(snapshot));
}

function deleteCartSnapshotRecord() {
  return withPhotoStorageStore("readwrite", (store) => store.delete(CART_RECORD_ID));
}

function writeCartSessionSnapshot(snapshot) {
  sessionStorage.setItem(CART_SESSION_STORAGE_KEY, JSON.stringify(snapshot));
}

function readCartSessionSnapshot() {
  const value = sessionStorage.getItem(CART_SESSION_STORAGE_KEY);

  if (!value) {
    return null;
  }

  return JSON.parse(value);
}

function deleteCartSessionSnapshot() {
  sessionStorage.removeItem(CART_SESSION_STORAGE_KEY);
}

async function deleteCartSnapshot() {
  const results = await Promise.allSettled([
    withPhotoStorageTimeout(deleteCartSnapshotRecord()),
    Promise.resolve().then(deleteCartSessionSnapshot),
  ]);

  if (results.every((result) => result.status === "rejected")) {
    throw results[0].reason;
  }
}

function withPhotoStorageTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error("Photo storage timed out.")), PHOTO_STORAGE_TIMEOUT_MS);
    }),
  ]);
}

async function withPhotoStorageStore(mode, operation) {
  const db = await getPhotoStorageDb();

  return new Promise((resolve, reject) => {
    let request;
    const transaction = db.transaction(PHOTO_STORAGE_STORE_NAME, mode);
    const store = transaction.objectStore(PHOTO_STORAGE_STORE_NAME);

    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error || request?.error || new Error("Photo storage failed."));
    transaction.onabort = () => reject(transaction.error || request?.error || new Error("Photo storage was aborted."));

    try {
      request = operation(store);
    } catch (error) {
      reject(error);
    }
  });
}

function getPhotoStorageDb() {
  if (photoStorageDbPromise) {
    return photoStorageDbPromise;
  }

  photoStorageDbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB is not available."));
      return;
    }

    const request = indexedDB.open(PHOTO_STORAGE_DB_NAME, PHOTO_STORAGE_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(PHOTO_STORAGE_STORE_NAME)) {
        db.createObjectStore(PHOTO_STORAGE_STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.addEventListener("versionchange", () => db.close());
      resolve(db);
    };

    request.onerror = () => reject(request.error || new Error("Could not open photo storage."));
    request.onblocked = () => reject(new Error("Photo storage is blocked."));
  });

  photoStorageDbPromise.catch(() => {
    photoStorageDbPromise = null;
  });

  return photoStorageDbPromise;
}

async function compressUploadedImages(entries) {
  if (state.isBusy) {
    return;
  }

  const compressibleEntries = entries.filter((entry) => !entry.wasCompressed);

  if (entries.length === 0) {
    setStatus("Add at least one image before compressing.", "error");
    return;
  }

  if (compressibleEntries.length === 0) {
    setStatus("All uploaded images have already been compressed.", "error");
    updateCompressionControls();
    return;
  }

  setBusy(true);

  try {
    setStatus("Compressing images...");
    const beforeSize = compressibleEntries.reduce((total, entry) => total + entry.workingFile.size, 0);
    const compressedEntries = await compressEntries(compressibleEntries);
    const afterSize = compressedEntries.reduce((total, entry) => total + entry.workingFile.size, 0);
    replaceEntries(compressedEntries);
    removeCartEntriesForImages(
      compressedEntries
        .filter((entry) => entry.wasCompressed && entry.results.length === 0)
        .map((entry) => entry.id),
    );
    updateFlatResults();
    renderFiles();
    renderResults();
    renderCart();
    updateOversizePanel();
    saveProcessedResults();

    if (afterSize < beforeSize) {
      setStatus(`Compression saved ${formatBytes(beforeSize - afterSize)}. Run Analyze when you are ready.`, "success");
    } else {
      setStatus("No selected images became smaller. Try uploading smaller images.", "error");
    }
  } catch (error) {
    setStatus(error.message || "Image compression failed.", "error");
  } finally {
    setBusy(false);
  }
}

function revokePreviewUrls(entries) {
  entries.forEach((entry) => {
    if (entry.previewUrl) {
      URL.revokeObjectURL(entry.previewUrl);
    }
  });
}

function isEntryOversized(entry) {
  return estimateRequestBytes([entry]) > PAYLOAD_SAFETY_LIMIT_BYTES;
}

function getImageStatusSymbol(status) {
  if (status === "processing") {
    return "";
  }

  if (status === "done") {
    return "✓";
  }

  if (status === "error") {
    return "!";
  }

  return "";
}

function getImageMeta(entry) {
  if (entry.status === "processing") {
    return "Processing";
  }

  if (entry.status === "done") {
    const count = entry.results.length;
    return `${count} item${count === 1 ? "" : "s"}`;
  }

  if (entry.status === "error") {
    return "Needs retry";
  }

  if (isEntryOversized(entry)) {
    return "Oversized";
  }

  return `${formatBytes(entry.workingFile.size)}${entry.wasCompressed ? " compressed" : ""}`;
}

function renderResults() {
  elements.resultsList.innerHTML = "";
  elements.copyButton.disabled = !hasAnyResults();
  renderChromeTabs();

  const activeEntry = getActiveEntry();

  if (!activeEntry) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Select or upload an image to see results.";
    elements.resultsList.append(empty);
    return;
  }

  if (activeEntry.status === "idle") {
    renderResultMessage("Analyze this image to see translated menu items.");
    return;
  }

  if (activeEntry.status === "processing") {
    const modelText = activeEntry.processingModelLabel ? ` with ${activeEntry.processingModelLabel}` : "";
    renderResultMessage(`Analyzing this image${modelText}...`);
    return;
  }

  if (activeEntry.status === "error") {
    renderResultMessage(activeEntry.error || "This image could not be processed. Tap Analyze on the image.");
    return;
  }

  if (activeEntry.results.length === 0) {
    renderResultMessage("No menu items were found for this image.");
    return;
  }

  const fragment = document.createDocumentFragment();

  activeEntry.results.forEach((item) => {
    const imageId = activeEntry.id;
    const cartItem = getCartItem(item, imageId);
    const card = document.createElement("article");
    card.className = `menu-result-card${cartItem ? " is-in-order" : ""}`;
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Open original text for ${item.originalText || item.translatedText || "this menu item"}`);
    card.addEventListener("click", () => {
      if (card.dataset.suppressClick === "true") {
        card.dataset.suppressClick = "false";
        return;
      }

      openResultDetail(item);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openResultDetail(item);
      }
    });
    attachResultSwipe(card, item, imageId);

    const removeIndicator = createSwipeIndicator("remove_shopping_cart", "result-swipe-indicator is-remove");
    const addIndicator = createSwipeIndicator("add_shopping_cart", "result-swipe-indicator is-add");
    const content = document.createElement("div");
    content.className = "menu-result-content";

    const textStack = document.createElement("div");
    textStack.className = "result-text-stack";
    textStack.append(
      createResultText(item.originalText, "result-original"),
      createResultText(item.translatedText, "result-translation"),
    );

    const side = document.createElement("div");
    side.className = "result-side";

    const price = document.createElement("div");
    price.className = "result-price";
    price.textContent = item.price || "";
    price.setAttribute("aria-label", item.price ? `Price: ${item.price}` : "No price");
    side.append(price);

    const iconRow = document.createElement("div");
    iconRow.className = `result-icon-row${item.note ? " has-note" : ""}`;

    if (cartItem) {
      const count = document.createElement("div");
      count.className = "result-cart-count";
      count.textContent = `×${cartItem.quantity}`;
      iconRow.append(count);
    }

    const imageSearchButton = createImageSearchButton(item);
    if (imageSearchButton) {
      iconRow.append(imageSearchButton);
    }

    if (item.note) {
      const noteButton = document.createElement("button");
      noteButton.type = "button";
      noteButton.className = "note-info-button";
      noteButton.textContent = "i";
      noteButton.title = "Show note";
      noteButton.setAttribute("aria-label", `Show note for ${item.translatedText || item.originalText || "this item"}`);
      noteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        openNote(item);
      });
      noteButton.addEventListener("keydown", (event) => {
        event.stopPropagation();
      });
      iconRow.append(noteButton);
    }
    if (iconRow.children.length > 0) {
      side.append(iconRow);
    }

    content.append(textStack, side);
    card.append(removeIndicator, addIndicator, content);
    fragment.append(card);
  });

  elements.resultsList.append(fragment);
}

function renderChromeTabs() {
  elements.resultsTabs.innerHTML = "";
  elements.resultsTabs.hidden = state.files.length === 0;

  if (state.files.length === 0) {
    return;
  }

  const fragment = document.createDocumentFragment();

  state.files.forEach((entry, index) => {
    const tab = document.createElement("button");
    const isActive = entry.id === state.activeImageId;

    tab.type = "button";
    tab.className = `chrome-tab is-${entry.status}${isActive ? " is-active" : ""}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(isActive));
    tab.setAttribute("aria-controls", "results-list");
    tab.addEventListener("click", () => selectImage(entry.id));

    const status = document.createElement("span");
    status.className = "chrome-tab-status";
    status.setAttribute("aria-hidden", "true");
    status.textContent = getImageStatusSymbol(entry.status);

    const label = document.createElement("span");
    label.className = "chrome-tab-label";
    label.textContent = `Image ${index + 1}`;

    const count = document.createElement("span");
    count.className = "chrome-tab-count";
    count.textContent = entry.status === "done" ? String(entry.results.length) : "";

    tab.append(status, label, count);
    fragment.append(tab);
  });

  elements.resultsTabs.append(fragment);
  scrollActiveResultTabIntoView();
}

function scrollActiveCarouselItemIntoView() {
  scrollChildIntoHorizontalView(elements.fileList, elements.fileList.querySelector(".image-slide.is-active"));
}

function scrollActiveResultTabIntoView() {
  scrollChildIntoHorizontalView(elements.resultsTabs, elements.resultsTabs.querySelector(".chrome-tab.is-active"));
}

function scrollChildIntoHorizontalView(container, child) {
  if (!container || !child || container.hidden) {
    return;
  }

  window.requestAnimationFrame(() => {
    if (!child.isConnected || !container.isConnected) {
      return;
    }

    const scrollPadding = 12;
    const currentLeft = container.scrollLeft;
    const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const visibleStart = currentLeft + scrollPadding;
    const visibleEnd = currentLeft + container.clientWidth - scrollPadding;
    const childStart = child.offsetLeft;
    const childEnd = childStart + child.offsetWidth;
    let nextLeft = currentLeft;

    if (childStart < visibleStart) {
      nextLeft = childStart - scrollPadding;
    } else if (childEnd > visibleEnd) {
      nextLeft = childEnd - container.clientWidth + scrollPadding;
    } else {
      return;
    }

    nextLeft = Math.round(Math.max(0, Math.min(maxLeft, nextLeft)));

    if (Math.abs(nextLeft - currentLeft) <= 1) {
      return;
    }

    container.scrollTo({
      left: nextLeft,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  });
}

function prefersReducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function renderResultMessage(message) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  elements.resultsList.append(empty);
}

function createResultText(value, valueClassName) {
  const valueElement = document.createElement("div");
  valueElement.className = valueClassName;
  valueElement.textContent = value || "";
  return valueElement;
}

function createSwipeIndicator(iconName, className) {
  const indicator = document.createElement("div");
  indicator.className = className;

  const icon = document.createElement("span");
  icon.className = "material-symbols-outlined";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = iconName;

  indicator.append(icon);
  return indicator;
}

function attachResultSwipe(card, item, imageId) {
  card.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) {
      return;
    }

    state.activeSwipe = {
      card,
      item,
      imageId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      deltaX: 0,
      isHorizontal: false,
    };

    if (typeof card.setPointerCapture === "function") {
      card.setPointerCapture(event.pointerId);
    }
  });

  card.addEventListener("pointermove", (event) => {
    const swipe = state.activeSwipe;

    if (!swipe || swipe.card !== card || swipe.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - swipe.startX;
    const deltaY = event.clientY - swipe.startY;
    const absoluteX = Math.abs(deltaX);
    const absoluteY = Math.abs(deltaY);

    if (!swipe.isHorizontal && !hasHorizontalSwipeIntent(absoluteX, absoluteY)) {
      return;
    }

    if (event.cancelable) {
      event.preventDefault();
    }

    swipe.isHorizontal = true;
    swipe.deltaX = Math.max(-RESULT_SWIPE_MAX_PX, Math.min(RESULT_SWIPE_MAX_PX, deltaX));
    card.dataset.suppressClick = "true";
    card.classList.add("is-swiping");
    card.classList.toggle("is-swipe-add", swipe.deltaX > 0);
    card.classList.toggle("is-swipe-remove", swipe.deltaX < 0);
    card.style.setProperty("--swipe-x", `${swipe.deltaX}px`);
    setResultSwipeProgress(card, swipe.deltaX);
  });

  card.addEventListener("pointerup", finishResultSwipe);
  card.addEventListener("pointercancel", cancelResultSwipe);
  card.addEventListener("touchmove", preventResultSwipeScroll, { passive: false });
}

function hasHorizontalSwipeIntent(absoluteX, absoluteY) {
  return absoluteX >= RESULT_SWIPE_INTENT_PX && absoluteX > absoluteY * RESULT_SWIPE_AXIS_LOCK_RATIO;
}

function preventResultSwipeScroll(event) {
  const swipe = state.activeSwipe;
  const [touch] = Array.from(event.touches || []);

  if (!swipe || swipe.card !== event.currentTarget || !touch) {
    return;
  }

  const absoluteX = Math.abs(touch.clientX - swipe.startX);
  const absoluteY = Math.abs(touch.clientY - swipe.startY);

  if (!swipe.isHorizontal && !hasHorizontalSwipeIntent(absoluteX, absoluteY)) {
    return;
  }

  if (event.cancelable) {
    event.preventDefault();
  }
}

function finishResultSwipe(event) {
  const swipe = state.activeSwipe;

  if (!swipe || swipe.pointerId !== event.pointerId) {
    return;
  }

  let swipeAction = null;

  if (Math.abs(swipe.deltaX) >= RESULT_SWIPE_THRESHOLD_PX) {
    if (swipe.deltaX > 0) {
      swipeAction = () => addCartItem(swipe.item, swipe.imageId);
    } else {
      swipeAction = () => removeOneCartItem(swipe.item, swipe.imageId);
    }
  }

  resetResultSwipe(swipe.card, swipeAction);
  state.activeSwipe = null;
}

function cancelResultSwipe(event) {
  const swipe = state.activeSwipe;

  if (!swipe || swipe.pointerId !== event.pointerId) {
    return;
  }

  resetResultSwipe(swipe.card);
  state.activeSwipe = null;
}

function resetResultSwipe(card, onComplete) {
  const content = card.querySelector(".menu-result-content");
  let didComplete = false;

  const complete = () => {
    if (didComplete) {
      return;
    }

    didComplete = true;
    content?.removeEventListener("transitionend", handleTransitionEnd);
    card.classList.remove("is-swipe-add", "is-swipe-remove");
    card.style.removeProperty("--swipe-x");
    card.style.removeProperty("--swipe-indicator-opacity");
    card.style.removeProperty("--swipe-icon-scale");
    onComplete?.();
  };

  const handleTransitionEnd = (event) => {
    if (event.target === content && event.propertyName === "transform") {
      complete();
    }
  };

  card.classList.remove("is-swiping");
  card.style.setProperty("--swipe-indicator-opacity", "0");
  card.style.setProperty("--swipe-icon-scale", "0.92");

  content?.addEventListener("transitionend", handleTransitionEnd);

  window.requestAnimationFrame(() => {
    card.style.setProperty("--swipe-x", "0px");
  });

  window.setTimeout(complete, 260);

  window.setTimeout(() => {
    card.dataset.suppressClick = "false";
  }, 0);
}

function setResultSwipeProgress(card, deltaX) {
  const progress = Math.min(1, Math.abs(deltaX) / RESULT_SWIPE_THRESHOLD_PX);
  const opacity = 0.24 + progress * 0.76;
  const iconScale = 0.92 + progress * 0.12;

  card.style.setProperty("--swipe-indicator-opacity", opacity.toFixed(3));
  card.style.setProperty("--swipe-icon-scale", iconScale.toFixed(3));
}

function createImageSearchButton(item) {
  const query = (item.originalText || item.translatedText || "").trim();

  if (!query) {
    return null;
  }

  const searchButton = document.createElement("button");
  searchButton.type = "button";
  searchButton.className = "image-search-button";
  searchButton.title = "Search images";
  searchButton.setAttribute("aria-label", `Search images for ${query}`);
  searchButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openImageSearch(query);
  });
  searchButton.addEventListener("keydown", (event) => {
    event.stopPropagation();
  });

  const icon = document.createElement("span");
  icon.className = "material-symbols-outlined";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "photo_library";
  searchButton.append(icon);

  return searchButton;
}

function openImageSearch(query) {
  const params = new URLSearchParams({
    tbm: "isch",
    q: query,
  });

  window.open(`https://www.google.com/search?${params.toString()}`, "_blank", "noopener,noreferrer");
}

function openNote(item) {
  elements.noteTitle.textContent = item.translatedText || item.originalText || "Menu item note";
  elements.noteText.textContent = item.note;
  elements.noteOverlay.hidden = false;
  elements.noteCloseButton.focus();
}

function closeNote() {
  elements.noteOverlay.hidden = true;
}

function getCartItem(item, imageId) {
  const itemKey = createCartItemKey(item, imageId);
  return state.cart.find((cartItem) => cartItem.itemKey === itemKey) || null;
}

function addCartItem(item, imageId) {
  const itemKey = createCartItemKey(item, imageId);
  const existingItem = state.cart.find((cartItem) => cartItem.itemKey === itemKey);

  if (existingItem) {
    existingItem.quantity += 1;
  } else {
    state.cart.push(createCartItem(item, imageId, itemKey));
  }

  setStatus("Added to order.", "success");
  renderResults();
  renderCart();
  saveCartSnapshot();
}

function removeOneCartItem(item, imageId) {
  const cartItem = getCartItem(item, imageId);

  if (!cartItem) {
    setStatus("Item is not in order.");
    return;
  }

  cartItem.quantity -= 1;

  if (cartItem.quantity <= 0) {
    state.cart = state.cart.filter((itemInCart) => itemInCart.id !== cartItem.id);
  }

  setStatus("Removed from order.");
  renderResults();
  renderCart();
  saveCartSnapshot();
}

function createCartItem(item, imageId, itemKey = createCartItemKey(item, imageId)) {
  return {
    id: createId(),
    imageId,
    itemKey,
    originalText: item.originalText || "",
    translatedText: item.translatedText || "",
    price: item.price || "",
    quantity: 1,
  };
}

function createCartItemKey(item, imageId) {
  return [
    imageId,
    normalizeCartKeyPart(item.originalText),
    normalizeCartKeyPart(item.translatedText),
    normalizeCartKeyPart(item.price),
  ].join("\u001f");
}

function normalizeCartKeyPart(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function removeCartEntriesForImages(imageIds) {
  const ids = new Set(imageIds);
  const nextCart = state.cart.filter((item) => !ids.has(item.imageId));

  if (nextCart.length === state.cart.length) {
    return;
  }

  state.cart = nextCart;
  renderCart();
  saveCartSnapshot();
}

function updateCartQuantity(cartItemId, delta) {
  const item = state.cart.find((cartItem) => cartItem.id === cartItemId);

  if (!item) {
    return;
  }

  item.quantity += delta;

  if (item.quantity <= 0) {
    state.cart = state.cart.filter((cartItem) => cartItem.id !== cartItemId);
  }

  renderResults();
  renderCart();
  saveCartSnapshot();
}

function getCartItemCount() {
  return state.cart.reduce((total, item) => total + item.quantity, 0);
}

function hasActiveResultItems() {
  return (getActiveEntry()?.results.length || 0) > 0;
}

function getCartLineAmountText(item) {
  const price = parseCartPrice(item.price);

  if (!price) {
    return item.price || "";
  }

  return formatCartAmount({
    ...price,
    amount: price.amount * item.quantity,
  });
}

function calculateCartTotal() {
  const candidates = [];
  let isPartial = false;

  for (const item of state.cart) {
    if (!String(item.price || "").trim()) {
      isPartial = true;
      continue;
    }

    const price = parseCartPrice(item.price);

    if (!price || !isCartTotalCandidate(price)) {
      isPartial = true;
      continue;
    }

    candidates.push({
      price,
      quantity: item.quantity,
      signKey: getCartPriceSignKey(price),
      styleKey: getCartPriceStyleKey(price),
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  const dominantSignKey = getDominantCartKey(candidates, "signKey");
  const dominantStyleKey = getDominantCartKey(
    candidates.filter((candidate) => candidate.signKey === dominantSignKey),
    "styleKey",
  );
  const stylePrice = candidates.find((candidate) => candidate.styleKey === dominantStyleKey)?.price || candidates[0].price;
  const total = {
    amount: 0,
    prefix: stylePrice.prefix,
    suffix: stylePrice.suffix,
    decimals: stylePrice.decimals,
    decimalSeparator: stylePrice.decimalSeparator,
    thousandsSeparator: stylePrice.thousandsSeparator,
    isPartial,
  };

  candidates.forEach((candidate) => {
    if (candidate.signKey !== dominantSignKey) {
      total.isPartial = true;
      return;
    }

    total.amount += candidate.price.amount * candidate.quantity;
    total.decimals = Math.max(total.decimals, candidate.price.decimals);
  });

  total.decimalSeparator = total.decimalSeparator || stylePrice.decimalSeparator;
  total.thousandsSeparator = total.thousandsSeparator || stylePrice.thousandsSeparator;

  return total;
}

function isCartTotalCandidate(price) {
  const signText = `${price.prefix} ${price.suffix}`;
  const ambiguousWords = /\b(from|starting|starts|start|add|extra|addon|add-on|supplement|upcharge|approx|about|around|market|varies)\b/i;

  return !/[+]/.test(signText) && !ambiguousWords.test(signText);
}

function getCartPriceSignKey(price) {
  return `${price.prefix}${price.suffix}`.replace(/\s+/g, "").toLowerCase();
}

function getCartPriceStyleKey(price) {
  return [
    price.prefix,
    price.suffix,
    price.decimalSeparator,
    price.thousandsSeparator,
  ].join("\u001f");
}

function getDominantCartKey(candidates, keyName) {
  const counts = new Map();

  candidates.forEach((candidate) => {
    counts.set(candidate[keyName], (counts.get(candidate[keyName]) || 0) + candidate.quantity);
  });

  let dominantKey = "";
  let dominantCount = -1;

  counts.forEach((count, key) => {
    if (count > dominantCount || (count === dominantCount && dominantKey === "" && key !== "")) {
      dominantKey = key;
      dominantCount = count;
    }
  });

  return dominantKey;
}

function parseCartPrice(value) {
  const text = String(value || "").trim();
  const matches = Array.from(text.matchAll(/\d[\d,.]*/g));

  if (matches.length !== 1) {
    return null;
  }

  const match = matches[0];
  const rawAmount = match[0];
  const normalizedAmount = normalizeCartAmount(rawAmount);
  const amount = Number(normalizedAmount.value);

  if (!Number.isFinite(amount)) {
    return null;
  }

  return {
    amount,
    prefix: text.slice(0, match.index).trim(),
    suffix: text.slice(match.index + rawAmount.length).trim(),
    decimals: normalizedAmount.decimals,
    decimalSeparator: normalizedAmount.decimalSeparator,
    thousandsSeparator: normalizedAmount.thousandsSeparator,
  };
}

function normalizeCartAmount(value) {
  const text = String(value || "");
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  let decimalSeparator = "";

  if (lastComma >= 0 && lastDot >= 0) {
    decimalSeparator = lastComma > lastDot ? "," : ".";
  } else if (lastComma >= 0) {
    decimalSeparator = inferDecimalSeparator(text, ",");
  } else if (lastDot >= 0) {
    decimalSeparator = inferDecimalSeparator(text, ".");
  }

  if (!decimalSeparator) {
    return {
      value: text.replace(/[,.]/g, ""),
      decimals: 0,
      decimalSeparator: "",
      thousandsSeparator: getThousandsSeparator(text, ""),
    };
  }

  const decimalIndex = text.lastIndexOf(decimalSeparator);
  const integerPart = text.slice(0, decimalIndex).replace(/[,.]/g, "");
  const decimalPart = text.slice(decimalIndex + 1).replace(/[,.]/g, "");

  return {
    value: `${integerPart || "0"}.${decimalPart}`,
    decimals: decimalPart.length,
    decimalSeparator,
    thousandsSeparator: getThousandsSeparator(text, decimalSeparator),
  };
}

function getThousandsSeparator(value, decimalSeparator) {
  const thousandsSeparator = decimalSeparator === "," ? "." : ",";

  if (value.includes(thousandsSeparator)) {
    return thousandsSeparator;
  }

  if (!decimalSeparator && value.includes(",")) {
    return ",";
  }

  if (!decimalSeparator && value.includes(".")) {
    return ".";
  }

  return "";
}

function inferDecimalSeparator(value, separator) {
  const parts = value.split(separator);
  const lastPart = parts[parts.length - 1] || "";

  if (parts.length === 2) {
    return lastPart.length > 0 && lastPart.length <= 2 ? separator : "";
  }

  const hasThousandsGroups = parts.slice(1).every((part) => part.length === 3);

  if (hasThousandsGroups) {
    return "";
  }

  return lastPart.length > 0 && lastPart.length <= 2 ? separator : "";
}

function formatCartAmount({ amount, prefix, suffix, decimals, decimalSeparator = ".", thousandsSeparator = ",", isPartial = false }) {
  const fixedAmount = formatCartNumber(amount, decimals, decimalSeparator, thousandsSeparator);
  const prefixGap = prefix && /[A-Za-z]$/.test(prefix) ? " " : "";
  const suffixGap = suffix && /^[A-Za-z]/.test(suffix) ? " " : "";
  const partialMarker = isPartial ? "+" : "";

  return `${prefix || ""}${prefixGap}${fixedAmount}${suffixGap}${suffix || ""}${partialMarker}`;
}

function formatCartNumber(amount, decimals, decimalSeparator, thousandsSeparator) {
  const [integerPart, decimalPart] = amount.toFixed(decimals).split(".");
  const groupedInteger = thousandsSeparator
    ? integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSeparator)
    : integerPart;

  if (!decimalPart) {
    return groupedInteger;
  }

  return `${groupedInteger}${decimalSeparator || "."}${decimalPart}`;
}

function renderCart() {
  const itemCount = getCartItemCount();
  const itemCountText = `${itemCount} item${itemCount === 1 ? "" : "s"}`;
  const shouldShowOrderBar = hasActiveResultItems() || itemCount > 0;
  const total = calculateCartTotal();
  const totalText = total ? formatCartAmount(total) : "";
  const orderBarText = itemCount > 0 && totalText ? `${itemCountText} • ${totalText}` : itemCount > 0 ? itemCountText : "Swipe";

  elements.orderBar.hidden = !shouldShowOrderBar;
  document.body.classList.toggle("has-order-bar", shouldShowOrderBar);
  elements.orderBarButton.setAttribute("aria-label", itemCount > 0 ? `Order, ${itemCountText}` : "Swipe right to add to order");
  elements.orderBarIcon.hidden = itemCount === 0;
  elements.orderBarSwipeIcon.hidden = itemCount > 0;
  elements.orderBarHintSuffix.hidden = itemCount > 0;
  elements.orderBarHintCartIcon.hidden = itemCount > 0;
  elements.orderBarCount.textContent = orderBarText;
  elements.orderModalCount.textContent = itemCountText;
  elements.orderCopyButton.hidden = itemCount === 0;
  elements.orderCopyButton.disabled = itemCount === 0;
  elements.orderTotalRow.hidden = !total;
  elements.orderTotalAmount.textContent = total ? formatCartAmount(total) : "";
  elements.orderList.classList.toggle("has-total", Boolean(total));

  if (!shouldShowOrderBar && !elements.orderModal.hidden) {
    closeOrderModal();
  }

  renderOrderList();
}

function createOrderEmptyIcon(iconName) {
  const icon = document.createElement("span");
  icon.className = `material-symbols-outlined order-empty-icon is-${iconName.replace(/_/g, "-")}`;
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = iconName;
  return icon;
}

function renderOrderList() {
  elements.orderList.innerHTML = "";

  if (state.cart.length === 0) {
    const empty = document.createElement("div");
    empty.className = "order-empty-state";

    const emptyLine = document.createElement("span");
    emptyLine.className = "order-empty-line";
    emptyLine.append("Pick favorites, then show this to staff", createOrderEmptyIcon("person_apron"));

    empty.append(emptyLine);
    elements.orderList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();

  state.cart.forEach((item) => {
    const row = document.createElement("article");
    row.className = "order-item";

    const textStack = document.createElement("div");
    textStack.className = "order-item-text";

    const original = document.createElement("p");
    original.className = "order-item-original";
    original.textContent = item.originalText || item.translatedText || "Menu item";

    const translation = document.createElement("p");
    translation.className = "order-item-translation";
    translation.textContent = item.translatedText || item.originalText || "";

    textStack.append(original, translation);

    const quantity = document.createElement("div");
    quantity.className = "order-item-quantity";
    quantity.textContent = `×${item.quantity}`;

    const side = document.createElement("div");
    side.className = "order-item-side";

    const price = document.createElement("div");
    price.className = "order-item-price";
    price.textContent = getCartLineAmountText(item);

    const controls = document.createElement("div");
    controls.className = "order-quantity-controls";
    controls.append(
      createQuantityButton("remove", `Remove one ${item.translatedText || item.originalText || "item"}`, () => updateCartQuantity(item.id, -1)),
      createQuantityButton("add", `Add one ${item.translatedText || item.originalText || "item"}`, () => updateCartQuantity(item.id, 1)),
    );

    side.append(price, controls);
    row.append(textStack, quantity, side);
    fragment.append(row);
  });

  elements.orderList.append(fragment);
}

function createQuantityButton(iconName, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "order-quantity-button";
  button.setAttribute("aria-label", label);
  button.addEventListener("click", onClick);

  const icon = document.createElement("span");
  icon.className = "material-symbols-outlined";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = iconName;

  button.append(icon);
  return button;
}

function openOrderModal() {
  renderCart();
  elements.orderModal.hidden = false;
  elements.orderModalClose.focus();
}

function closeOrderModal() {
  elements.orderModal.hidden = true;
}

async function maybeSuggestCompression(entries) {
  const largeEntries = entries.filter((entry) => {
    return entry.shouldSuggestCompression && !entry.compressionSuggestionShown && !entry.wasCompressed;
  });

  if (largeEntries.length === 0) {
    return;
  }

  largeEntries.forEach((entry) => {
    entry.compressionSuggestionShown = true;
  });
  scheduleUploadedPhotosSave();

  const largestEntry = largeEntries.reduce((largest, entry) => {
    return entry.workingFile.size > largest.workingFile.size ? entry : largest;
  }, largeEntries[0]);

  const message = document.createElement("p");
  message.textContent = `${largeEntries.length} image${largeEntries.length === 1 ? "" : "s"} look large. Compressing first can make upload and analysis faster. Largest image: ${formatBytes(largestEntry.workingFile.size)}.`;

  const shouldCompress = await showAppModal({
    body: message,
    confirmText: "Compress",
    cancelText: "Later",
    showCancel: true,
  });

  if (!shouldCompress) {
    return;
  }

  const largeEntryIds = new Set(largeEntries.map((entry) => entry.id));
  const currentLargeEntries = state.files.filter((entry) => {
    return largeEntryIds.has(entry.id) && !entry.wasCompressed;
  });

  if (currentLargeEntries.length > 0) {
    compressUploadedImages(currentLargeEntries);
  }
}

function openResultDetail(item) {
  const body = document.createElement("div");
  body.className = "modal-result-layout";

  const textStack = document.createElement("div");
  textStack.className = "modal-result-text";

  const original = document.createElement("p");
  original.className = "modal-original-text";
  original.textContent = item.originalText || "";

  const translation = document.createElement("p");
  translation.className = "modal-translation-text";
  translation.textContent = item.translatedText || "";

  textStack.append(original, translation);
  body.append(textStack);

  if (item.price) {
    const price = document.createElement("div");
    price.className = "modal-price-text";
    price.textContent = item.price;
    body.append(price);
  }

  showAppModal({
    body,
    confirmText: "",
    showCancel: false,
    hideActions: true,
  });
}

function hasApiKey() {
  return Boolean(elements.apiKey.value.trim());
}

function getInitialApiKey() {
  const hashKey = getApiKeyFromHash();

  if (hashKey) {
    localStorage.setItem(API_KEY_STORAGE_KEY, hashKey);
    return hashKey;
  }

  return localStorage.getItem(API_KEY_STORAGE_KEY) || "";
}

function getApiKeyFromHash() {
  return getHashParams().get(API_KEY_HASH_PARAM)?.trim() || "";
}

function getHashParams() {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  return new URLSearchParams(hash);
}

function updateApiKeyHash(key) {
  const params = getHashParams();

  if (key) {
    params.set(API_KEY_HASH_PARAM, key);
  } else {
    params.delete(API_KEY_HASH_PARAM);
  }

  const nextHash = params.toString();
  const nextUrl = `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ""}`;
  window.history.replaceState(null, "", nextUrl);
}

function syncApiKeyFromHash() {
  const key = getApiKeyFromHash();

  if (!key) {
    return;
  }

  elements.apiKey.value = key;
  localStorage.setItem(API_KEY_STORAGE_KEY, key);
  updateApiKeyState();
}

function showAppAlert(_title, messageText) {
  const message = document.createElement("p");
  message.textContent = messageText;

  return showAppModal({
    body: message,
    confirmText: "OK",
    showCancel: false,
  });
}

function getNothingToTranslateMessage() {
  return "All uploaded images have already been analyzed. Use Retry on an image to translate it again.";
}

function showNothingToTranslateAlert() {
  return showAppAlert("Nothing to translate", getNothingToTranslateMessage());
}

function showAppModal({ body, confirmText = "OK", cancelText = "Cancel", showCancel = true, hideActions = false }) {
  if (state.modalResolver) {
    closeAppModal(false);
  }

  elements.appModalBody.innerHTML = "";

  if (typeof body === "string") {
    const message = document.createElement("p");
    message.textContent = body;
    elements.appModalBody.append(message);
  } else if (body) {
    elements.appModalBody.append(body);
  }

  elements.appModalConfirm.textContent = confirmText;
  elements.appModalCancel.textContent = cancelText;
  elements.appModalCancel.hidden = !showCancel;
  elements.appModalConfirm.hidden = hideActions;
  elements.appModalActions.hidden = hideActions;
  elements.appModalActions.classList.toggle("single-action", !showCancel);
  elements.appModal.hidden = false;
  (hideActions ? elements.appModalClose : elements.appModalConfirm).focus();

  return new Promise((resolve) => {
    state.modalResolver = resolve;
  });
}

function closeAppModal(result) {
  if (elements.appModal.hidden) {
    return;
  }

  elements.appModal.hidden = true;

  if (state.modalResolver) {
    const resolver = state.modalResolver;
    state.modalResolver = null;
    resolver(Boolean(result));
  }
}

function openKeyModal() {
  elements.keyModalInput.value = elements.apiKey.value;
  updateKeyModalModelChoice();
  elements.keyModal.hidden = false;
  elements.keyModalInput.focus();
}

function closeKeyModal() {
  elements.keyModal.hidden = true;
}

function saveApiKeyFromModal() {
  const key = elements.keyModalInput.value.trim();
  const modelChoice = getKeyModalModelChoice();
  elements.apiKey.value = key;

  if (key) {
    localStorage.setItem(API_KEY_STORAGE_KEY, key);
  } else {
    localStorage.removeItem(API_KEY_STORAGE_KEY);
  }

  setSelectedModelChoice(modelChoice);
  updateApiKeyHash(key);
  updateApiKeyState();
  closeKeyModal();
}

function clearApiKeyFromModal() {
  elements.keyModalInput.value = "";
  elements.apiKey.value = "";
  localStorage.removeItem(API_KEY_STORAGE_KEY);
  updateApiKeyHash("");
  updateApiKeyState();
  closeKeyModal();
}

function updateApiKeyState() {
  const hasKey = hasApiKey();
  elements.apiKeyState.textContent = getSelectedModelConfig().label;
  elements.apiKeyCheck.hidden = !hasKey;
  elements.apiKeyButton.classList.toggle("is-set", hasKey);
}

function getSelectedModelChoice() {
  const storedChoice = localStorage.getItem(MODEL_STORAGE_KEY);
  return Object.hasOwn(GEMINI_MODELS, storedChoice) ? storedChoice : "flash";
}

function getSelectedModelConfig() {
  return GEMINI_MODELS[getSelectedModelChoice()] || GEMINI_MODELS.flash;
}

function getModelLabelByApiModel(apiModel) {
  const config = Object.values(GEMINI_MODELS).find((modelConfig) => modelConfig.apiModel === apiModel);
  return config?.label || apiModel;
}

function setSelectedModelChoice(choice) {
  const nextChoice = Object.hasOwn(GEMINI_MODELS, choice) ? choice : "flash";
  localStorage.setItem(MODEL_STORAGE_KEY, nextChoice);
}

function getKeyModalModelChoice() {
  return elements.modelInputs.find((input) => input.checked)?.value || getSelectedModelChoice();
}

function toggleKeyModalModelChoice(event) {
  const label = event.target.closest("label");

  if (!label || !elements.modelChoiceField.contains(label)) {
    return;
  }

  event.preventDefault();

  const currentChoice = getKeyModalModelChoice();
  const nextChoice = currentChoice === "flash" ? "lite" : "flash";
  setKeyModalModelChoice(nextChoice);
  setSelectedModelChoice(nextChoice);
  updateApiKeyState();
}

function setKeyModalModelChoice(choice) {
  elements.modelInputs.forEach((input) => {
    input.checked = input.value === choice;
  });
}

function updateKeyModalModelChoice() {
  setKeyModalModelChoice(getSelectedModelChoice());
}

function triggerUploadFromEmptyState(event) {
  if (state.files.length > 0 || state.isBusy) {
    return;
  }

  if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") {
    return;
  }

  event.preventDefault();
  elements.imageInput.click();
}

async function analyzeImages({ entries, forceCompress }) {
  if (state.isBusy) {
    return;
  }

  const validationError = validateReady(entries);
  if (validationError) {
    setStatus(validationError, "error");
    if (!hasApiKey()) {
      await showAppAlert("API key required", validationError);
    }
    return;
  }

  setBusy(true);

  try {
    let entriesToSend = entries;

    if (forceCompress) {
      setStatus("Compressing images...");
      entriesToSend = await compressEntries(entries);
      replaceEntries(entriesToSend);
      renderFiles();
    }

    const oversizedEntries = entriesToSend.filter(isEntryOversized);
    if (oversizedEntries.length > 0) {
      updateOversizePanel();
      setStatus("One or more images are too large. Compress them, analyze safe images, or remove them.", "error");
      return;
    }

    const payloadEstimate = estimateRequestBytes(entriesToSend);
    state.lastPayloadEstimate = payloadEstimate;
    updatePayloadMeter();

    entriesToSend.forEach((entry) => {
      entry.results = [];
      entry.error = "";
      entry.status = "idle";
      entry.processingModelLabel = "";
    });
    removeCartEntriesForImages(entriesToSend.map((entry) => entry.id));
    updateFlatResults();
    renderResults();
    renderCart();
    elements.oversizePanel.hidden = true;
    await saveProcessedResults();

    let successCount = 0;
    let failedCount = 0;
    let activeModel = getSelectedModelConfig().apiModel;
    const totalImages = entriesToSend.length;

    for (let index = 0; index < entriesToSend.length; index += 1) {
      const entry = entriesToSend[index];
      const modelLabel = getModelLabelByApiModel(activeModel);
      state.activeImageId = entry.id;
      entry.status = "processing";
      entry.error = "";
      entry.processingModelLabel = modelLabel;
      renderFiles();
      renderResults();
      renderCart();

      const label = totalImages === 1 ? `Analyzing ${entry.name} with ${modelLabel}...` : `Analyzing image ${index + 1} of ${totalImages} with ${modelLabel}...`;
      setStatus(label);
      updateProgress(index / totalImages);

      try {
        entry.results = await callGemini([entry], activeModel);
        entry.status = "done";
        successCount += 1;
        await saveProcessedResults();
      } catch (error) {
        entry.results = [];
        entry.error = error.message || "This image could not be processed.";
        entry.status = "error";
        updateFlatResults();
        renderFiles();
        renderResults();
        renderCart();
        await saveProcessedResults();

        const fallbackResult = await applyLiteForRun(entry, error);

        if (fallbackResult.applied) {
          activeModel = FALLBACK_MODEL;
        }

        if (fallbackResult.success) {
          successCount += 1;
        } else {
          failedCount += 1;
        }
      }

      updateFlatResults();
      renderFiles();
      renderResults();
      renderCart();
      updateProgress((index + 1) / totalImages);
      await saveProcessedResults();
    }

    const itemCount = state.results.length;
    const summary = `Done. Processed ${successCount} image${successCount === 1 ? "" : "s"} and extracted ${itemCount} item${itemCount === 1 ? "" : "s"}.`;
    setStatus(failedCount > 0 ? `${summary} ${failedCount} image${failedCount === 1 ? "" : "s"} failed.` : summary, failedCount > 0 ? "error" : "success");
  } catch (error) {
    setStatus(error.message || "Something went wrong while analyzing the menu.", "error");
  } finally {
    updateOversizePanel();
    setBusy(false);
  }
}

function validateReady(entries = state.files) {
  if (!elements.apiKey.value.trim()) {
    return "Paste a Gemini API key before analyzing.";
  }

  if (entries.length === 0) {
    return "Add at least one menu image before analyzing.";
  }

  return "";
}

class GeminiRequestError extends Error {
  constructor(message, status, model) {
    super(message);
    this.name = "GeminiRequestError";
    this.status = status;
    this.model = model;
  }
}

async function applyLiteForRun(entry, error) {
  if (!canRetryWithFallback(error)) {
    return { applied: false, success: false };
  }

  const shouldRetry = await confirmLiteForRun(error);

  if (!shouldRetry) {
    return { applied: false, success: false };
  }

  setSelectedModelChoice("lite");
  setKeyModalModelChoice("lite");
  updateApiKeyState();

  entry.status = "processing";
  entry.error = "";
  entry.processingModelLabel = getModelLabelByApiModel(FALLBACK_MODEL);
  setStatus(`Retrying ${entry.name} with ${entry.processingModelLabel}...`);
  renderFiles();
  renderResults();
  renderCart();

  try {
    entry.results = await callGemini([entry], FALLBACK_MODEL);
    entry.status = "done";
    await saveProcessedResults();
    return { applied: true, success: true };
  } catch (fallbackError) {
    entry.results = [];
    entry.error = fallbackError.message || "Lite retry failed.";
    entry.status = "error";
    await saveProcessedResults();
    return { applied: true, success: false };
  }
}

function canRetryWithFallback(error) {
  if (!(error instanceof GeminiRequestError) || error.model === FALLBACK_MODEL) {
    return false;
  }

  return ![400, 401, 403].includes(error.status);
}

function confirmLiteForRun(error) {
  const body = document.createElement("div");

  const message = document.createElement("p");
  message.textContent = "Flash is busy or failed. Use Lite for the rest of this translation?";

  const detail = document.createElement("p");
  detail.className = "modal-muted-text";
  detail.textContent = `This will retry the current image with ${FALLBACK_MODEL_LABEL}, then use Lite for the remaining images in this run. Gemini error: ${truncateText(error.message || "Request failed.", 180)}`;

  body.append(message, detail);

  return showAppModal({
    body,
    confirmText: "Use Lite",
    cancelText: "Skip",
    showCancel: true,
  });
}

function truncateText(value, maxLength) {
  const text = String(value || "");

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

async function callGemini(entries, model = DEFAULT_MODEL) {
  const apiKey = elements.apiKey.value.trim();
  const targetConfig = getTargetLanguageConfig();
  const parts = [];

  for (const entry of entries) {
    const data = await fileToBase64(entry.workingFile);
    parts.push({
      inline_data: {
        mime_type: entry.type,
        data,
      },
    });
  }

  parts.push({
    text: buildPrompt(targetConfig.promptValue),
  });

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts,
          },
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseJsonSchema: MENU_SCHEMA,
        },
      }),
    },
  );

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = payload?.error?.message || `Gemini request failed with HTTP ${response.status}.`;
    throw new GeminiRequestError(message, response.status, model);
  }

  return parseGeminiItems(payload);
}

function buildPrompt(targetLanguage) {
  return [
    "You are extracting and translating menu items from one or more menu images.",
    `Translate item names and short descriptions into ${targetLanguage}.`,
    "Detect the source language automatically.",
    "Return only JSON that matches the response schema.",
    "For each item, include translatedText, originalText, price, and note as strings.",
    "Copy the visible price exactly as written. If no price is visible, use an empty string.",
    "Use an empty note unless the item is unclear, truncated, partially unreadable, inferred, or likely affected by OCR uncertainty.",
    "Write notes in English.",
    "Do not invent menu items that are not visible in the images.",
    "If a row contains multiple sizes or variants, preserve the useful visible detail in translatedText or note.",
  ].join("\n");
}

function parseGeminiItems(payload) {
  const text = (payload?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned invalid JSON.");
  }

  if (!data || !Array.isArray(data.items)) {
    throw new Error("Gemini returned JSON without an items array.");
  }

  return data.items.map(normalizeItem).filter((item) => item.translatedText || item.originalText);
}

function normalizeItem(item) {
  return {
    translatedText: stringifyField(item?.translatedText),
    originalText: stringifyField(item?.originalText),
    price: stringifyField(item?.price),
    note: stringifyField(item?.note),
  };
}

function stringifyField(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function estimateRequestBytes(entries) {
  const base64Bytes = entries.reduce((total, entry) => {
    return total + Math.ceil(entry.workingFile.size / 3) * 4;
  }, 0);

  return base64Bytes + 16 * 1024;
}

function updatePayloadMeter() {
  const uploadHeaderTools = elements.uploadHeaderTools;

  if (state.files.length === 0) {
    elements.payloadMeter.textContent = "Add images to start";
    elements.compressAllButton.disabled = true;
    elements.compressAllButton.hidden = true;
    uploadHeaderTools.classList.add("is-empty");
    uploadHeaderTools.setAttribute("role", "button");
    uploadHeaderTools.setAttribute("tabindex", "0");
    uploadHeaderTools.setAttribute("aria-label", "Add menu images");
    uploadHeaderTools.title = "Add menu images";
    return;
  }

  elements.compressAllButton.hidden = false;
  uploadHeaderTools.classList.remove("is-empty");
  uploadHeaderTools.removeAttribute("role");
  uploadHeaderTools.removeAttribute("tabindex");
  uploadHeaderTools.removeAttribute("aria-label");
  uploadHeaderTools.removeAttribute("title");

  const totalImageBytes = state.files.reduce((total, entry) => total + entry.workingFile.size, 0);
  const oversizedCount = state.files.filter(isEntryOversized).length;
  const oversizedLabel = oversizedCount > 0 ? ` • ${oversizedCount} oversized` : "";

  elements.payloadMeter.textContent = `${formatBytes(totalImageBytes)} total${oversizedLabel}`;
  updateCompressionControls();
}

function updateOversizePanel() {
  const oversizedEntries = state.files.filter(isEntryOversized);

  if (state.files.length === 0 || oversizedEntries.length === 0) {
    elements.oversizePanel.hidden = true;
    return;
  }

  const safeCount = getMainTranslateEntries(state.files).filter((entry) => !isEntryOversized(entry)).length;

  elements.oversizePanel.hidden = false;
  elements.oversizeMessage.textContent = `${oversizedEntries.length} image${oversizedEntries.length === 1 ? "" : "s"} exceed the ${formatBytes(PAYLOAD_SAFETY_LIMIT_BYTES)} safe per-image request limit. Compress them, analyze only the safe images, or remove images.`;
  elements.batchButton.disabled = safeCount === 0 || state.isBusy;
  updateCompressionControls();
  elements.removeModeButton.disabled = state.isBusy;
}

async function compressEntries(entries) {
  const compressed = [];
  let compressedCount = 0;

  for (const entry of entries) {
    if (entry.wasCompressed) {
      compressed.push(entry);
      continue;
    }

    try {
      const workingFile = await compressImage(entry.workingFile, entry.name);

      if (workingFile.size >= entry.workingFile.size) {
        compressed.push(entry);
        continue;
      }

      compressedCount += 1;
      if (entry.previewUrl) {
        URL.revokeObjectURL(entry.previewUrl);
      }
      compressed.push({
        ...entry,
        workingFile,
        type: workingFile.type,
        previewUrl: URL.createObjectURL(workingFile),
        status: "idle",
        results: [],
        error: "",
        wasCompressed: true,
      });
    } catch {
      compressed.push(entry);
    }
  }

  if (compressedCount === 0) {
    setStatus("This browser could not make the selected images smaller. Try analyzing safe images or removing images.", "error");
  }

  return compressed;
}

async function compressImage(file, originalName) {
  const bitmap = await loadBitmap(file);
  const maxDimension = 1800;
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0, width, height);

  const blob = await canvasToBlob(canvas, "image/jpeg", 0.78);

  if (typeof bitmap.close === "function") {
    bitmap.close();
  }

  const fallbackName = originalName.replace(/\.[^.]+$/, "") || "menu";
  return new File([blob], `${fallbackName}-compressed.jpg`, { type: "image/jpeg" });
}

function loadBitmap(file) {
  if ("createImageBitmap" in window) {
    return createImageBitmap(file);
  }

  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This browser could not decode the image for compression."));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }

        reject(new Error("Image compression failed."));
      },
      type,
      quality,
    );
  });
}

function fileToBase64(file) {
  return fileToDataUrl(file).then((value) => {
    const commaIndex = value.indexOf(",");
    return commaIndex >= 0 ? value.slice(commaIndex + 1) : value;
  });
}

function fileToDataUrl(file) {
  if (photoDataUrlCache.has(file)) {
    return Promise.resolve(photoDataUrlCache.get(file));
  }

  if (photoDataUrlPromiseCache.has(file)) {
    return photoDataUrlPromiseCache.get(file);
  }

  const promise = new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      photoDataUrlCache.set(file, value);
      resolve(value);
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });

  photoDataUrlPromiseCache.set(file, promise);

  promise.catch(() => {
    photoDataUrlPromiseCache.delete(file);
  });

  return promise;
}

function dataUrlToFile(dataUrl, name, type) {
  const [header, data] = String(dataUrl || "").split(",");

  if (!header || !data || !header.startsWith("data:")) {
    return null;
  }

  try {
    const mimeType = header.match(/^data:([^;]+)/)?.[1] || type || "application/octet-stream";
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return new File([bytes], name || "menu-image", { type: type || mimeType });
  } catch {
    return null;
  }
}

function getTargetLanguageConfig() {
  return TARGET_LANGUAGES[elements.targetLanguage.value] || TARGET_LANGUAGES["zh-TW"];
}

function getFileType(file) {
  if (file.type) {
    return file.type;
  }

  const extension = file.name.split(".").pop()?.toLowerCase();
  const extensionTypes = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
  };

  return extensionTypes[extension] || "";
}

function createId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setBusy(isBusy) {
  state.isBusy = isBusy;
  elements.analyzeButton.disabled = isBusy;
  elements.clearButton.disabled = isBusy;
  elements.apiKey.disabled = isBusy;
  elements.apiKeyButton.disabled = isBusy;
  elements.targetLanguage.disabled = isBusy;
  elements.imageInput.disabled = isBusy;
  elements.replaceImageInput.disabled = isBusy;
  elements.progressBar.hidden = !isBusy;

  if (!isBusy) {
    updateProgress(0);
  }

  renderFiles();
  renderResults();
  renderCart();
  updateCompressionControls();
  updateOversizePanel();
}

function updateCompressionControls() {
  const canCompress = state.files.some((entry) => !entry.wasCompressed);
  elements.compressAllButton.disabled = state.isBusy || !canCompress;
  elements.compressButton.disabled = state.isBusy || !canCompress;
}

function setStatus(message, type = "") {
  elements.statusMessage.textContent = message;
  elements.statusMessage.className = `status-message${type ? ` ${type}` : ""}`;
}

function updateProgress(value) {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
  elements.progressFill.style.width = `${percent}%`;
}

function setCopyButtonSuccess(button, timerKey, resetIconClass = "fa-regular fa-copy") {
  const icon = button.querySelector("i");

  if (!icon) {
    return;
  }

  window.clearTimeout(state[timerKey]);
  icon.className = "fa-solid fa-check";
  button.classList.add("is-success");

  state[timerKey] = window.setTimeout(() => {
    icon.className = resetIconClass;
    button.classList.remove("is-success");
  }, 1100);
}

async function copyResultsText() {
  if (!hasAnyResults()) {
    return;
  }

  const text = formatResultsCopyText();

  if (!text) {
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    setCopyButtonSuccess(elements.copyButton, "copyResetTimer");
    setStatus("Results copied.", "success");
  } catch {
    setStatus("Could not copy results to the clipboard.", "error");
  }
}

async function copyOrderText() {
  if (state.cart.length === 0) {
    return;
  }

  const text = formatOrderCopyText();

  if (!text) {
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    setCopyButtonSuccess(elements.orderCopyButton, "orderCopyResetTimer");
    setStatus("Order copied.", "success");
  } catch {
    setStatus("Could not copy order to the clipboard.", "error");
  }
}

function formatResultsCopyText() {
  return state.files
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.results.length > 0)
    .map(({ entry, index }) => formatImageResultsCopyText(entry, index))
    .filter(Boolean)
    .join("\n\n");
}

function formatImageResultsCopyText(entry, index) {
  const items = entry.results.map(formatResultItemCopyText).filter(Boolean);

  if (items.length === 0) {
    return "";
  }

  return [`📜 Image ${index + 1}`, items.map((item) => `👉 ${item}`).join("\n\n")].join("\n");
}

function formatResultItemCopyText(item) {
  const translatedText = stringifyField(item.translatedText);
  const originalText = stringifyField(item.originalText);
  const price = stringifyField(item.price);
  const lines = [];

  if (translatedText) {
    lines.push(translatedText);
  }

  if (originalText && normalizeCopyText(originalText) !== normalizeCopyText(translatedText)) {
    lines.push(originalText);
  }

  if (price) {
    lines.push(`💵 ${price}`);
  }

  return lines.join("\n");
}

function formatOrderCopyText() {
  const items = state.cart.map(formatOrderItemCopyText).filter(Boolean);

  if (items.length === 0) {
    return "";
  }

  const itemCount = getCartItemCount();
  const total = calculateCartTotal();
  const itemCountText = `${itemCount} item${itemCount === 1 ? "" : "s"}`;
  const summary = total ? `💸 Total is ${formatCartAmount(total)}\n💸 ${itemCountText}` : `💸 ${itemCountText}`;
  const itemBlocks = items.map((item) => `👉 ${item}`);

  return [summary, itemBlocks.join("\n\n")].join("\n\n");
}

function formatOrderItemCopyText(item) {
  const originalText = stringifyField(item.originalText);
  const translatedText = stringifyField(item.translatedText);
  const primaryText = translatedText || originalText || "Menu item";
  const lineAmount = formatOrderItemCopyAmount(item);
  const lines = [primaryText];

  if (originalText && normalizeCopyText(originalText) !== normalizeCopyText(primaryText)) {
    lines.push(originalText);
  }

  lines.push(`×${item.quantity}`);

  if (lineAmount) {
    lines.push(`💵 ${lineAmount}`);
  }

  return lines.join("\n");
}

function formatOrderItemCopyAmount(item) {
  const rawPrice = stringifyField(item.price);

  if (!rawPrice) {
    return "";
  }

  const price = parseCartPrice(rawPrice);

  if (!price) {
    return item.quantity > 1 ? `${rawPrice} x ${item.quantity}` : rawPrice;
  }

  const totalAmount = formatCartAmount({
    ...price,
    amount: price.amount * item.quantity,
  });

  if (item.quantity <= 1) {
    return totalAmount;
  }

  return `${totalAmount} (${formatCartAmount(price)} x ${item.quantity})`;
}

function normalizeCopyText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  const precision = value >= 10 || index === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[index]}`;
}
