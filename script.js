"use strict";

const DEFAULT_MODEL = "gemini-flash-latest";
const FALLBACK_MODEL = "gemini-flash-lite-latest";
const FALLBACK_MODEL_LABEL = "Gemini Flash-Lite Latest";
const API_KEY_STORAGE_KEY = "menuTranslator.geminiApiKey";
const API_KEY_HASH_PARAM = "key";
const MODEL_STORAGE_KEY = "menuTranslator.geminiModel";
const LARGE_IMAGE_WARNING_BYTES = 2 * 1024 * 1024;
const INLINE_PAYLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
const PAYLOAD_SAFETY_LIMIT_BYTES = 19 * 1024 * 1024;
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
  activeImageId: "",
  modalResolver: null,
  replaceTargetImageId: "",
  copyResetTimer: 0,
  lastPayloadEstimate: 0,
  isBusy: false,
};

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
  updateOversizePanel();
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
    state.activeImageId = "";
    setStatus("Images cleared.");
    renderFiles();
    renderResults();
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

  elements.copyButton.addEventListener("click", copyResultsJson);
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
  updateOversizePanel();
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
}

function removeFile(id) {
  const removedEntry = state.files.find((entry) => entry.id === id);
  if (removedEntry?.previewUrl) {
    URL.revokeObjectURL(removedEntry.previewUrl);
  }

  state.files = state.files.filter((entry) => entry.id !== id);
  if (state.activeImageId === id) {
    state.activeImageId = state.files[0]?.id || "";
  }
  updateFlatResults();
  setStatus("Image removed.");
  renderFiles();
  renderResults();
  updateOversizePanel();
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
  updateFlatResults();
  setStatus("Image replaced. Run Analyze to process it.");
  renderFiles();
  renderResults();
  updateOversizePanel();
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
  return entries.filter((entry) => !isRetryEntry(entry));
}

function updateFlatResults() {
  state.results = state.files.flatMap((entry) => entry.results);
}

function replaceEntries(updatedEntries) {
  const updatedById = new Map(updatedEntries.map((entry) => [entry.id, entry]));
  state.files = state.files.map((entry) => updatedById.get(entry.id) || entry);
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
    updateFlatResults();
    renderFiles();
    renderResults();
    updateOversizePanel();

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
    const card = document.createElement("article");
    card.className = "menu-result-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Open original text for ${item.originalText || item.translatedText || "this menu item"}`);
    card.addEventListener("click", () => openResultDetail(item));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openResultDetail(item);
      }
    });

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

    if (item.note) {
      const iconRow = document.createElement("div");
      iconRow.className = "result-icon-row";

      const imageSearchButton = createImageSearchButton(item);
      if (imageSearchButton) {
        iconRow.append(imageSearchButton);
      }

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
      iconRow.append(noteButton);
      side.append(iconRow);
    } else {
      const imageSearchButton = createImageSearchButton(item);
      if (imageSearchButton) {
        side.append(imageSearchButton);
      }
    }

    card.append(textStack, side);
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
    updateFlatResults();
    renderResults();
    elements.oversizePanel.hidden = true;

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

      const label = totalImages === 1 ? `Analyzing ${entry.name} with ${modelLabel}...` : `Analyzing image ${index + 1} of ${totalImages} with ${modelLabel}...`;
      setStatus(label);
      updateProgress(index / totalImages);

      try {
        entry.results = await callGemini([entry], activeModel);
        entry.status = "done";
        successCount += 1;
      } catch (error) {
        entry.results = [];
        entry.error = error.message || "This image could not be processed.";
        entry.status = "error";
        updateFlatResults();
        renderFiles();
        renderResults();

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
      updateProgress((index + 1) / totalImages);
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

  try {
    entry.results = await callGemini([entry], FALLBACK_MODEL);
    entry.status = "done";
    return { applied: true, success: true };
  } catch (fallbackError) {
    entry.results = [];
    entry.error = fallbackError.message || "Lite retry failed.";
    entry.status = "error";
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
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      const commaIndex = value.indexOf(",");
      resolve(commaIndex >= 0 ? value.slice(commaIndex + 1) : value);
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
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

function setCopyButtonSuccess() {
  const icon = elements.copyButton.querySelector("i");

  if (!icon) {
    return;
  }

  window.clearTimeout(state.copyResetTimer);
  icon.className = "fa-solid fa-check";
  elements.copyButton.classList.add("is-success");

  state.copyResetTimer = window.setTimeout(() => {
    icon.className = "fa-regular fa-copy";
    elements.copyButton.classList.remove("is-success");
  }, 1100);
}

async function copyResultsJson() {
  if (!hasAnyResults()) {
    return;
  }

  const imageGroups = state.files
    .filter((entry) => entry.results.length > 0)
    .map((entry) => ({
      image: entry.name,
      items: entry.results,
    }));

  try {
    await navigator.clipboard.writeText(JSON.stringify({ images: imageGroups }, null, 2));
    setCopyButtonSuccess();
    setStatus("Result JSON copied.", "success");
  } catch {
    setStatus("Could not copy JSON to the clipboard.", "error");
  }
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
