import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const STORAGE_KEY = "keep-board-mvp-v2";
const THEME_KEY = "keep-board-theme";
const SETTINGS_KEY = "keep-board-settings";
const MIN_CARD_SPAN = 3;
const MAX_CARD_SPAN = 10;
const MIN_CARD_ROWS = 3;
const MAX_CARD_ROWS = 10;
const BOARD_UNIT = 68;
const BOARD_ROW = 44;
const BOARD_GAP = 16;
const BOARD_CANVAS_WIDTH = 1320;
const BOARD_DROP_STEP = 20;
const BOARD_ZOOM_MIN = 0.67;
const BOARD_ZOOM_MAX = 3;
const SWAP_OVERLAP_RATIO = 0.38;
const SWAP_ZONE_INSET_RATIO = 0.3;
const BOARD_EDGE_PADDING = 20;

const defaultSettings = {
  fontSize: 15,
  sortMode: "manual",
  boardZoom: 1,
  appBackgroundMode: "theme",
  appBackgroundColor: "",
  appBackgroundImage: "",
  topbarBackgroundMode: "theme",
  topbarBackgroundColor: "",
  topbarBackgroundImage: "",
};

const itemLabels = {
  note: "メモ",
  image: "画像",
  video: "動画",
  link: "リンク",
  board: "ボード",
  todo: "リスト",
  comment: "コメント",
  column: "Column",
  table: "Table",
  draw: "Draw",
  "shape-line": "Line",
  "shape-rect": "Rect",
  "shape-circle": "Circle",
};

function now() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function createInitialState() {
  const createdAt = now();
  const firstBoardId = createId("board");
  return {
    boards: [
      {
        id: firstBoardId,
        title: "最初のボード",
        parentBoardId: null,
        createdAt,
        updatedAt: createdAt,
        order: 0,
      },
    ],
    items: [],
  };
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("keep-board-mvp-v1");
  if (!saved) return createInitialState();

  try {
    return JSON.parse(saved);
  } catch {
    return createInitialState();
  }
}

function loadSettings() {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return defaultSettings;
  }
}

function sortByOrder(a, b) {
  return a.order - b.order || a.createdAt.localeCompare(b.createdAt);
}

function sortRecords(records, sortMode) {
  const copy = [...records];
  if (sortMode === "title") {
    return copy.sort((a, b) => (a.title || "").localeCompare(b.title || "", "ja"));
  }
  if (sortMode === "newest") {
    return copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  if (sortMode === "oldest") {
    return copy.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return copy.sort(sortByOrder);
}

function normalizeOrders(records) {
  const updatedAt = now();
  return records.map((record, index) => ({ ...record, order: index, updatedAt }));
}

function save(nextState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
  } catch (error) {
    console.error("Failed to persist board state. Keeping in-memory state only.", error);
  }
  return nextState;
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load image"));
    image.src = source;
  });
}

async function optimizeSettingsImageFile(file) {
  const raw = await readImageFile(file);
  if (!raw || typeof raw !== "string") return "";
  if (raw.length <= 2_000_000) return raw;

  try {
    const image = await loadImageElement(raw);
    const maxSide = 1920;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
    const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
    const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return raw;
    context.drawImage(image, 0, 0, width, height);
    const optimized = canvas.toDataURL("image/jpeg", 0.82);
    return optimized || raw;
  } catch {
    return raw;
  }
}

function probeMediaDimensions(source, type = "image") {
  return new Promise((resolve) => {
    if (!source) {
      resolve({ width: 0, height: 0 });
      return;
    }

    if (type === "video") {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.src = source;
      video.onloadedmetadata = () => resolve({ width: video.videoWidth || 0, height: video.videoHeight || 0 });
      video.onerror = () => resolve({ width: 0, height: 0 });
      return;
    }

    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 0, height: image.naturalHeight || 0 });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = source;
  });
}

function getAspectBasedCardSize(width, height, fallbackType) {
  if (!width || !height) {
    return {
      widthUnits: fallbackType === "image" || fallbackType === "video" ? 4 : 2,
      heightUnits: fallbackType === "image" || fallbackType === "video" ? 4 : 2,
      aspectRatio: 1,
    };
  }

  const ratio = width / height;
  const widthUnits = clamp(Math.round(clamp(ratio * 4.2, 3, 8)), MIN_CARD_SPAN, MAX_CARD_SPAN);
  const pixelWidth = widthUnits * BOARD_UNIT + (widthUnits - 1) * BOARD_GAP;
  const pixelHeight = pixelWidth / Math.max(ratio, 0.2);
  const heightUnits = clamp(
    Math.round((pixelHeight + BOARD_GAP) / (BOARD_ROW + BOARD_GAP)),
    MIN_CARD_ROWS,
    MAX_CARD_ROWS,
  );
  return { widthUnits, heightUnits, aspectRatio: ratio };
}

export default function App() {
  const [state, setState] = useState(loadState);
  const [currentBoardId, setCurrentBoardId] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
  const [isExternalDragOver, setIsExternalDragOver] = useState(false);
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || "light");
  const [settings, setSettings] = useState(loadSettings);
  const [activeCaptionId, setActiveCaptionId] = useState(null);
  const [lightboxId, setLightboxId] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [selectedLabels, setSelectedLabels] = useState([]);
  const [selectedItemIds, setSelectedItemIds] = useState([]);
  const [activeTool, setActiveTool] = useState(null);
  const [labelSortMode, setLabelSortMode] = useState("count-desc");
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [showShapePanel, setShowShapePanel] = useState(false);
  const [showLabelPanel, setShowLabelPanel] = useState(false);
  const mediaReplaceRef = useRef({ itemId: null });
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const clipboardRef = useRef([]);
  const externalDropBusyRef = useRef(false);
  const lastExternalDropRef = useRef({ signature: "", timestamp: 0 });

  const currentBoard = state.boards.find((board) => board.id === currentBoardId) || null;
  const rootBoards = useMemo(
    () => state.boards.filter((board) => board.parentBoardId === null).sort(sortByOrder),
    [state.boards],
  );
  const boardItems = useMemo(
    () => state.items.filter((item) => item.boardId === currentBoardId).sort(sortByOrder),
    [currentBoardId, state.items],
  );
  const visibleRootBoards = useMemo(
    () => sortRecords(rootBoards.filter((board) => matchesSearch(board, query)), settings.sortMode),
    [query, rootBoards, settings.sortMode],
  );
  const visibleBoardItems = useMemo(
    () =>
      sortRecords(
        boardItems.filter((item) => matchesSearch(item, query) && matchesLabel(item, selectedLabels)),
        settings.sortMode,
      ),
    [boardItems, query, selectedLabels, settings.sortMode],
  );
  const boardLabels = useMemo(
    () => [...new Set(boardItems.map((item) => item.label).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja")),
    [boardItems],
  );
  const boardLabelStats = useMemo(() => {
    const statsMap = new Map();
    for (const item of boardItems) {
      if (!item.label) continue;
      statsMap.set(item.label, (statsMap.get(item.label) || 0) + 1);
    }
    return [...statsMap.entries()].map(([label, count]) => ({ label, count }));
  }, [boardItems]);
  const visibleImages = visibleBoardItems.filter(
    (item) => (item.type === "image" || item.type === "video") && item.imagePath,
  );
  const lightboxIndex = visibleImages.findIndex((item) => item.id === lightboxId);
  const lightboxItem = lightboxIndex >= 0 ? visibleImages[lightboxIndex] : null;
  const selectedItem = selectedItemIds.length
    ? boardItems.find((item) => item.id === selectedItemIds[0]) || null
    : null;
  const selectedTextItem =
    selectedItem &&
    !selectedItem.sticker &&
    selectedItem.type !== "todo" &&
    selectedItem.type !== "image" &&
    selectedItem.type !== "video" &&
    selectedItem.type !== "board"
      ? selectedItem
      : null;
  const selectedImageItem =
    boardItems.find(
      (item) => selectedItemIds.includes(item.id) && (item.type === "image" || item.type === "video") && item.imagePath,
    ) || null;
  const canUndo = undoStackRef.current.length > 0;
  const canRedo = redoStackRef.current.length > 0;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--base-font-size", `${settings.fontSize}px`);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    setSelectedItemIds([]);
    setActiveCaptionId(null);
    setActiveTool(null);
    setShowAddPanel(false);
    setShowShapePanel(false);
    setShowLabelPanel(false);
    setIsAddMenuOpen(false);
  }, [currentBoardId]);

  useEffect(() => {
    function handleKeyDown(event) {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;

      if (lightboxId) return;

      if (event.key === "Escape" && activeTool) {
        event.preventDefault();
        setActiveTool(null);
        setContextMenu(null);
        setIsAddMenuOpen(false);
        setShowAddPanel(false);
        setShowShapePanel(false);
        setShowLabelPanel(false);
        return;
      }

      if (event.key === "Escape" && currentBoard) {
        event.preventDefault();
        setContextMenu(null);
        setIsAddMenuOpen(false);
        setShowAddPanel(false);
        setShowShapePanel(false);
        setShowLabelPanel(false);
        setCurrentBoardId(currentBoard.parentBoardId || null);
        return;
      }

      if (!(event.ctrlKey || event.metaKey)) {
        if ((event.key === "Delete" || event.key === "Backspace") && selectedItemIds.length) {
          event.preventDefault();
          deleteItemsByIds(selectedItemIds);
        }
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undoState();
      } else if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        redoState();
      } else if (key === "d") {
        event.preventDefault();
        duplicateSelectedItems();
      } else if (key === "x") {
        event.preventDefault();
        cutSelectedItems();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTool, currentBoard, lightboxId, selectedItemIds, state]);

  useEffect(() => {
    async function handlePaste(event) {
      if (!currentBoardId) return;
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing || lightboxId) return;

      try {
        const droppedItems = await createDroppedVisualItems(event.clipboardData);
        if (droppedItems.length) {
          event.preventDefault();
          droppedItems.forEach((droppedItem, index) => {
            const position = clampPosition(droppedItem, { x: 40 + index * 20, y: 40 + index * 20 });
            addDroppedItem(droppedItem, position);
          });
          return;
        }
      } catch (error) {
        console.error("Paste failed", error);
      }

      if (clipboardRef.current.length) {
        event.preventDefault();
        pasteClipboardItems();
      }
    }

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [currentBoardId, lightboxId, state]);

  const appShellStyle = buildSurfaceStyle(
    settings.appBackgroundMode,
    settings.appBackgroundColor,
    settings.appBackgroundImage,
    "var(--paper)",
  );
  const topbarStyle = buildSurfaceStyle(
    settings.topbarBackgroundMode,
    settings.topbarBackgroundColor,
    settings.topbarBackgroundImage,
    "var(--glass)",
  );

  function updateState(recipe, options = { recordHistory: true }) {
    setState((previous) => {
      const next = recipe(previous);
      if (next === previous) return previous;
      if (options.recordHistory) {
        undoStackRef.current.push(previous);
        if (undoStackRef.current.length > 60) undoStackRef.current.shift();
        redoStackRef.current = [];
      }
      return save(next);
    });
  }

  function undoState() {
    setState((previous) => {
      const snapshot = undoStackRef.current.pop();
      if (!snapshot) return previous;
      redoStackRef.current.push(previous);
      return save(snapshot);
    });
  }

  function redoState() {
    setState((previous) => {
      const snapshot = redoStackRef.current.pop();
      if (!snapshot) return previous;
      undoStackRef.current.push(previous);
      return save(snapshot);
    });
  }

  function getDescendantBoardIds(boardId, boards = state.boards) {
    return boards
      .filter((board) => board.parentBoardId === boardId)
      .flatMap((board) => [board.id, ...getDescendantBoardIds(board.id, boards)]);
  }

  function getBoardPath(board) {
    const path = [];
    let cursor = board;
    while (cursor) {
      path.unshift(cursor);
      cursor = cursor.parentBoardId
        ? state.boards.find((candidate) => candidate.id === cursor.parentBoardId)
        : null;
    }
    return path;
  }

  function createBoard(title, parentBoardId = currentBoardId) {
    const values = typeof title === "string" ? { title } : title;
    const createdAt = now();
    updateState((previous) => ({
      ...previous,
      boards: [
        ...previous.boards,
        {
          id: createId("board"),
          title: values.title,
          parentBoardId,
          fontColor: values.fontColor || "",
          fontWeight: values.fontWeight || "700",
          thumbnailImage: values.thumbnailImage || "",
          createdAt,
          updatedAt: createdAt,
          order: previous.boards.filter((board) => board.parentBoardId === parentBoardId).length,
        },
      ],
    }));
  }

  function updateBoard(boardId, title) {
    const values = typeof title === "string" ? { title } : title;
    updateState((previous) => ({
      ...previous,
      boards: previous.boards.map((board) =>
        board.id === boardId ? { ...board, ...values, updatedAt: now() } : board,
      ),
      items: previous.items.map((item) =>
        item.linkedBoardId === boardId ? { ...item, title: values.title, updatedAt: now() } : item,
      ),
    }));
  }

  function createSubBoard() {
    const createdAt = now();
    const boardId = createId("board");
    const order = boardItems.length;
    updateState((previous) => ({
      ...previous,
      boards: [
        ...previous.boards,
        {
          id: boardId,
          title: "新しいサブボード",
          parentBoardId: currentBoardId,
          fontColor: "",
          fontWeight: "700",
          thumbnailImage: "",
          createdAt,
          updatedAt: createdAt,
          order,
        },
      ],
      items: [
        ...previous.items,
        {
          id: createId("item"),
          boardId: currentBoardId,
          type: "board",
          title: "新しいサブボード",
          content: "",
          imagePath: "",
          url: "",
          linkedBoardId: boardId,
          widthUnits: 2,
          heightUnits: 3,
          order,
          createdAt,
          updatedAt: createdAt,
        },
      ],
    }));
  }

  function createQuickItem(type, position = null, overrides = {}) {
    const createdAt = now();
    const templates = {
      note: { title: "新しいメモ", content: "", widthUnits: 3, heightUnits: 3 },
      link: { title: "新しいリンク", content: "", url: "https://", widthUnits: 3, heightUnits: 2 },
      todo: { title: "リスト", content: "・やること", widthUnits: 3, heightUnits: 3 },
      comment: { title: "Comment", content: "コメントを書く", widthUnits: 3, heightUnits: 2 },
      column: { title: "Column", content: "見出し\n本文", widthUnits: 4, heightUnits: 5 },
      table: { title: "Table", content: "項目 | 内容\n--- | ---", widthUnits: 4, heightUnits: 4 },
      draw: { title: "Sticker", content: "", widthUnits: 4, heightUnits: 4, sticker: true, angleDeg: 0 },
      "shape-line": {
        title: "Line",
        content: "",
        widthUnits: 4,
        heightUnits: 1,
        sticker: true,
        angleDeg: 0,
        strokeColor: "#ffffff",
        strokeWidth: 4,
      },
      "shape-rect": {
        title: "Rect",
        content: "",
        widthUnits: 3,
        heightUnits: 3,
        sticker: true,
        angleDeg: 0,
        strokeColor: "#ffffff",
        strokeWidth: 4,
      },
      "shape-circle": {
        title: "Circle",
        content: "",
        widthUnits: 3,
        heightUnits: 3,
        sticker: true,
        angleDeg: 0,
        strokeColor: "#ffffff",
        strokeWidth: 4,
      },
    };
    const base = templates[type];
    if (!base) return;

    updateState((previous) => ({
      ...previous,
      items: (() => {
        const order = previous.items.filter((candidate) => candidate.boardId === currentBoardId).length;
        const draft = {
          id: createId("item"),
          boardId: currentBoardId,
          linkedBoardId: "",
          order,
          createdAt,
          updatedAt: createdAt,
          type,
          url: "",
          imagePath: "",
          label: "",
          ...base,
          ...overrides,
        };
        const fallbackPosition = {
          x: 260 + (order % 6) * 26,
          y: 80 + Math.floor(order / 6) * 26,
        };
        const placed = clampPosition(draft, position || fallbackPosition);
        return [...previous.items, { ...draft, x: placed.x, y: placed.y }];
      })(),
    }));
  }

  function appendTodoItem(itemId) {
    updateState((previous) => ({
      ...previous,
      items: previous.items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              content: `${item.content || ""}${item.content ? "\n" : ""}・新しい項目`,
              updatedAt: now(),
            }
          : item,
      ),
    }));
  }

  function toggleTodoLine(itemId, lineIndex) {
    updateState((previous) => ({
      ...previous,
      items: previous.items.map((item) => {
        if (item.id !== itemId) return item;
        const lines = (item.content || "").split(/\r?\n/);
        lines[lineIndex] = lines[lineIndex].trim().startsWith("[x]")
          ? lines[lineIndex].replace(/^\[x\]\s*/i, "")
          : `[x] ${lines[lineIndex].replace(/^\[( |x)\]\s*/i, "").replace(/^・\s*/, "")}`;
        return {
          ...item,
          content: lines.join("\n"),
          updatedAt: now(),
        };
      }),
    }));
  }

  function updateTodoLine(itemId, lineIndex, value) {
    updateState((previous) => ({
      ...previous,
      items: previous.items.map((item) => {
        if (item.id !== itemId) return item;
        const lines = (item.content || "").split(/\r?\n/);
        if (lineIndex < 0 || lineIndex >= lines.length) return item;
        const checked = lines[lineIndex].trim().startsWith("[x]");
        const nextLine = value.trim();
        lines[lineIndex] = checked ? `[x] ${nextLine}` : `・${nextLine}`;
        return {
          ...item,
          content: lines.join("\n"),
          updatedAt: now(),
        };
      }),
    }));
  }

  function openMediaReplacePicker(item) {
    mediaReplaceRef.current = { itemId: item.id };
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,video/*";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (file && mediaReplaceRef.current.itemId) {
        await replaceMediaAsset(mediaReplaceRef.current.itemId, file);
      }
    });
    input.click();
  }

  async function saveItem(type, values, item = null, position = null) {
    const createdAt = now();
    const imagePath = values.imageFile?.size
      ? await readImageFile(values.imageFile)
      : item?.imagePath || "";
    const dimensions =
      type === "image" || type === "video"
        ? await probeMediaDimensions(imagePath, type)
        : { width: 0, height: 0 };
    const mediaSize = getAspectBasedCardSize(dimensions.width, dimensions.height, type);

    updateState((previous) => {
      const record = {
        title: values.title,
        content: values.content,
        label: values.label,
        imagePath,
        url: values.url,
        aspectRatio: mediaSize.aspectRatio,
        ...(type === "image" || type === "video" ? mediaSize : {}),
        updatedAt: now(),
      };

      if (item) {
        return {
          ...previous,
          items: previous.items.map((candidate) =>
            candidate.id === item.id ? { ...candidate, ...record } : candidate,
          ),
        };
      }

      return {
        ...previous,
        items: [
          ...previous.items,
          (() => {
            const draft = {
            id: createId("item"),
            boardId: currentBoardId,
            type,
            linkedBoardId: "",
            widthUnits: type === "image" || type === "video" ? 4 : 2,
            heightUnits: type === "image" || type === "video" ? 4 : 2,
            order: boardItems.length,
            createdAt,
            ...record,
            };
            const clampedPosition = position ? clampPosition(draft, position) : null;
            return {
              ...draft,
              x: clampedPosition?.x,
              y: clampedPosition?.y,
            };
          })(),
        ],
      };
    });
  }

  function addDroppedItem(item, dropPosition = null) {
    const createdAt = now();
    updateState((previous) => ({
      ...previous,
      items: [
        ...previous.items,
        {
          id: createId("item"),
          boardId: currentBoardId,
          linkedBoardId: "",
          widthUnits: item.widthUnits || (item.type === "image" || item.type === "video" ? 4 : 2),
          heightUnits: item.heightUnits || (item.type === "image" || item.type === "video" ? 4 : 2),
          x: dropPosition?.x,
          y: dropPosition?.y,
          order: previous.items.filter((candidate) => candidate.boardId === currentBoardId).length,
          createdAt,
          updatedAt: createdAt,
          ...item,
        },
      ],
    }));
  }

  function deleteBoard(boardId, skipConfirm = false) {
    if (!skipConfirm && !confirm("このボードと中身を削除しますか？")) return;

    updateState((previous) => {
      const ids = new Set([boardId, ...getDescendantBoardIds(boardId, previous.boards)]);

      return {
        boards: previous.boards.filter((board) => !ids.has(board.id)),
        items: previous.items.filter(
          (item) => !ids.has(item.boardId) && !ids.has(item.linkedBoardId),
        ),
      };
    });

    if (boardId === currentBoardId) {
      setCurrentBoardId(null);
    }
  }

  function deleteItem(item) {
    if (item.type === "board") {
      deleteBoard(item.linkedBoardId, true);
      return;
    }

    updateState((previous) => {
      const remainingItems = previous.items.filter((candidate) => candidate.id !== item.id);
      const normalized = normalizeOrders(
        remainingItems.filter((candidate) => candidate.boardId === item.boardId).sort(sortByOrder),
      );
      const normalizedById = new Map(normalized.map((candidate) => [candidate.id, candidate]));
      return {
        ...previous,
        items: remainingItems.map((candidate) => normalizedById.get(candidate.id) || candidate),
      };
    });
  }

  function handleHomeDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    updateState((previous) => {
      const ordered = previous.boards
        .filter((board) => board.parentBoardId === null)
        .sort(sortByOrder);
      const oldIndex = ordered.findIndex((board) => board.id === active.id);
      const newIndex = ordered.findIndex((board) => board.id === over.id);
      const reordered = normalizeOrders(arrayMove(ordered, oldIndex, newIndex));
      const reorderedById = new Map(reordered.map((board) => [board.id, board]));
      return {
        ...previous,
        boards: previous.boards.map((board) => reorderedById.get(board.id) || board),
      };
    });
  }

  function handleItemDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    updateState((previous) => {
      const ordered = previous.items
        .filter((item) => item.boardId === currentBoardId)
        .sort(sortByOrder);
      const activeItem = ordered.find((item) => item.id === active.id);
      const overItem = ordered.find((item) => item.id === over.id);

      if (activeItem && overItem?.type === "board") {
        const targetBoardId = overItem.linkedBoardId;
        const activeBoardId = activeItem.linkedBoardId;
        const isMovingBoardIntoItself =
          activeItem.type === "board" &&
          (activeBoardId === targetBoardId ||
            getDescendantBoardIds(activeBoardId, previous.boards).includes(targetBoardId));

        if (!isMovingBoardIntoItself) {
          return {
            ...previous,
            items: previous.items.map((item) =>
              item.id === activeItem.id
                ? {
                    ...item,
                    boardId: targetBoardId,
                    order: previous.items.filter((candidate) => candidate.boardId === targetBoardId).length,
                    updatedAt: now(),
                  }
                : item,
            ),
            boards:
              activeItem.type === "board"
                ? previous.boards.map((board) =>
                    board.id === activeItem.linkedBoardId
                      ? { ...board, parentBoardId: targetBoardId, updatedAt: now() }
                      : board,
                  )
                : previous.boards,
          };
        }
      }

      const oldIndex = ordered.findIndex((item) => item.id === active.id);
      const newIndex = ordered.findIndex((item) => item.id === over.id);
      const reordered = normalizeOrders(arrayMove(ordered, oldIndex, newIndex));
      const reorderedById = new Map(reordered.map((item) => [item.id, item]));
      return {
        ...previous,
        items: previous.items.map((item) => reorderedById.get(item.id) || item),
      };
    });
  }

  function resizeMediaItem(itemId, nextSpan, nextRows) {
    updateState((previous) => {
      const target = previous.items.find((item) => item.id === itemId);
      if (!target) return previous;
      const minSpan = target.sticker ? 1 : MIN_CARD_SPAN;
      const minRows = target.sticker ? 1 : MIN_CARD_ROWS;
      const widthUnits = Math.min(MAX_CARD_SPAN, Math.max(minSpan, nextSpan));
      const heightUnits = Math.min(MAX_CARD_ROWS, Math.max(minRows, nextRows));
      return {
        ...previous,
        items: previous.items.map((item) =>
          item.id === itemId ? { ...item, widthUnits, heightUnits, updatedAt: now() } : item,
        ),
      };
    });
  }

  function moveItemsOnBoard(itemIds, positions) {
    updateState((previous) => {
      const boardItemsForLayout = previous.items.filter((item) => item.boardId === currentBoardId);
      const positioned = boardItemsForLayout.map((item, index) => {
        const base = withDefaultPosition(item, index);
        if (!positions[item.id]) return base;
        return {
          ...base,
          x: positions[item.id].x,
          y: positions[item.id].y,
          originX: base.x,
          originY: base.y,
          updatedAt: now(),
        };
      });
      const resolved = resolveBoardPlacement(positioned, itemIds);
      const resolvedById = new Map(resolved.map((item) => [item.id, item]));
      return {
        ...previous,
        items: previous.items.map((item) => resolvedById.get(item.id) || item),
      };
    });
  }

  function moveItemToBoard(item, targetBoardId) {
    const activeBoardId = item.linkedBoardId;
    const invalidMove =
      item.type === "board" &&
      (activeBoardId === targetBoardId || getDescendantBoardIds(activeBoardId).includes(targetBoardId));

    if (invalidMove) return;

    updateState((previous) => ({
      ...previous,
      items: previous.items.map((candidate) =>
        candidate.id === item.id
          ? {
              ...candidate,
              boardId: targetBoardId,
              x: undefined,
              y: undefined,
              order: previous.items.filter((target) => target.boardId === targetBoardId).length,
              updatedAt: now(),
            }
          : candidate,
      ),
      boards:
        item.type === "board"
          ? previous.boards.map((board) =>
              board.id === item.linkedBoardId
                ? { ...board, parentBoardId: targetBoardId, updatedAt: now() }
                : board,
            )
          : previous.boards,
    }));
  }

  async function replaceMediaAsset(itemId, file) {
    if (!file) return;
    const type = file.type.startsWith("video/") ? "video" : "image";
    const imagePath = await readImageFile(file);
    const dimensions = await probeMediaDimensions(imagePath, type);
    const mediaSize = getAspectBasedCardSize(dimensions.width, dimensions.height, type);

    updateState((previous) => ({
      ...previous,
      items: previous.items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              type,
              imagePath,
              aspectRatio: mediaSize.aspectRatio,
              widthUnits: mediaSize.widthUnits,
              heightUnits: mediaSize.heightUnits,
              updatedAt: now(),
            }
          : item,
      ),
    }));
  }

  function patchItem(itemId, patch) {
    updateState((previous) => ({
      ...previous,
      items: previous.items.map((item) => (item.id === itemId ? { ...item, ...patch, updatedAt: now() } : item)),
    }));
  }

  function duplicateSelectedItems(itemIds = selectedItemIds) {
    if (!currentBoardId || !itemIds.length) return;
    updateState((previous) => {
      const selected = previous.items
        .filter((item) => item.boardId === currentBoardId && itemIds.includes(item.id) && item.type !== "board")
        .map((item, index) => {
          const position = clampPosition(item, { x: (item.x || 0) + 40, y: (item.y || 0) + 40 + index * 10 });
          return {
            ...item,
            id: createId("item"),
            x: position.x,
            y: position.y,
            createdAt: now(),
            updatedAt: now(),
            order: previous.items.filter((candidate) => candidate.boardId === currentBoardId).length + index,
          };
        });

      if (!selected.length) return previous;
      return {
        ...previous,
        items: [...previous.items, ...selected],
      };
    });
  }

  function deleteItemsByIds(itemIds) {
    if (!itemIds.length) return;
    updateState((previous) => {
      const selectedIds = new Set(itemIds);
      const boardIdsToDelete = new Set(
        previous.items.filter((item) => selectedIds.has(item.id) && item.type === "board").map((item) => item.linkedBoardId),
      );
      const allBoardIds = new Set(
        [...boardIdsToDelete].flatMap((boardId) => [boardId, ...getDescendantBoardIds(boardId, previous.boards)]),
      );

      return {
        boards: previous.boards.filter((board) => !allBoardIds.has(board.id)),
        items: previous.items.filter(
          (item) => !selectedIds.has(item.id) && !allBoardIds.has(item.boardId) && !allBoardIds.has(item.linkedBoardId),
        ),
      };
    });
    setSelectedItemIds([]);
  }

  function cutSelectedItems() {
    const selected = state.items
      .filter((item) => item.boardId === currentBoardId && selectedItemIds.includes(item.id) && item.type !== "board")
      .map((item) => ({ ...item }));
    if (!selected.length) return;
    const minX = Math.min(...selected.map((item) => item.x || 0));
    const minY = Math.min(...selected.map((item) => item.y || 0));
    clipboardRef.current = selected.map((item) => ({
      ...item,
      x: (item.x || 0) - minX,
      y: (item.y || 0) - minY,
    }));
    deleteItemsByIds(selected.map((item) => item.id));
  }

  function pasteClipboardItems() {
    if (!currentBoardId || !clipboardRef.current.length) return;
    updateState((previous) => {
      const pasted = clipboardRef.current.map((item, index) => ({
        ...item,
        id: createId("item"),
        boardId: currentBoardId,
        x: clampPosition(item, { x: 40 + (item.x || 0), y: 40 + (item.y || 0) + index * 8 }).x,
        y: clampPosition(item, { x: 40 + (item.x || 0), y: 40 + (item.y || 0) + index * 8 }).y,
        createdAt: now(),
        updatedAt: now(),
        order: previous.items.filter((candidate) => candidate.boardId === currentBoardId).length + index,
      }));
      return {
        ...previous,
        items: [...previous.items, ...pasted],
      };
    });
  }

  function getBoardThumbnail(board) {
    if (board.thumbnailImage) return board.thumbnailImage;
    return state.items
      .filter((item) => item.boardId === board.id && item.type === "image" && item.imagePath)
      .sort(sortByOrder)[0]?.imagePath || "";
  }

  function openBoardContextMenu(event, board) {
    event.preventDefault();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      board,
    });
  }

  function openItemContextMenu(event, item) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      item,
    });
  }

  function openAdd(type) {
    setIsAddMenuOpen(false);
    if (type === "board") {
      createSubBoard();
    } else {
      setDialog({ kind: "item", type });
    }
  }

  function handleExternalDragOver(event) {
    if (document.body.dataset.internalCardDrag === "true") return;
    if (getSidebarToolFromDataTransfer(event.dataTransfer)) {
      setIsExternalDragOver(false);
      return;
    }
    event.preventDefault();
    if (currentBoardId && hasExternalDropData(event.dataTransfer)) {
      setIsExternalDragOver(true);
    }
  }

  function handleExternalDragLeave(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setIsExternalDragOver(false);
    }
  }

async function handleExternalDrop(event) {
    if (document.body.dataset.internalCardDrag === "true") return;
    if (getSidebarToolFromDataTransfer(event.dataTransfer)) {
      setIsExternalDragOver(false);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!currentBoardId) return;
    if (!hasExternalDropData(event.dataTransfer)) return;
    const dropSignature = buildDropSignature(event.dataTransfer);
    const dropNow = Date.now();
    if (
      dropSignature &&
      lastExternalDropRef.current.signature === dropSignature &&
      dropNow - lastExternalDropRef.current.timestamp < 900
    ) {
      return;
    }
    if (dropSignature) {
      lastExternalDropRef.current = { signature: dropSignature, timestamp: dropNow };
    }
    if (externalDropBusyRef.current) return;
    externalDropBusyRef.current = true;
    setIsExternalDragOver(false);

    const boardRoot = document.querySelector("[data-board-root='true']");
    const zoom = Number(boardRoot?.dataset.zoom || settings.boardZoom || 1);
    const rect = boardRoot?.getBoundingClientRect();
    const dropPosition =
      rect && boardRoot
        ? {
            x: (event.clientX - rect.left) / zoom,
            y: (event.clientY - rect.top) / zoom,
          }
        : null;

    try {
      const droppedItems = await createDroppedVisualItems(event.dataTransfer);
      if (droppedItems.length) {
        droppedItems.forEach((droppedItem, index) => {
          const offset = index * 28;
          const targetPosition = dropPosition ? { x: dropPosition.x + offset, y: dropPosition.y + offset } : null;
          const clampedPosition = targetPosition ? clampPosition(droppedItem, targetPosition) : null;
          addDroppedItem(droppedItem, clampedPosition);
        });
      }
    } catch (error) {
      console.error("External drop failed", error);
    } finally {
      externalDropBusyRef.current = false;
    }
  }

  useEffect(() => {
    function blockNativeDropNavigation(event) {
      if (document.body.dataset.internalCardDrag === "true") return;
      if (getSidebarToolFromDataTransfer(event.dataTransfer)) return;
      if (!event.dataTransfer) return;
      event.preventDefault();
    }

    window.addEventListener("dragover", blockNativeDropNavigation, { capture: true });
    window.addEventListener("drop", blockNativeDropNavigation, { capture: true });
    return () => {
      window.removeEventListener("dragover", blockNativeDropNavigation, { capture: true });
      window.removeEventListener("drop", blockNativeDropNavigation, { capture: true });
    };
  }, []);

  useEffect(() => {
    function clearDropHint() {
      setIsExternalDragOver(false);
    }

    window.addEventListener("dragend", clearDropHint);
    window.addEventListener("drop", clearDropHint);
    return () => {
      window.removeEventListener("dragend", clearDropHint);
      window.removeEventListener("drop", clearDropHint);
    };
  }, []);

  return (
    <div
      className={isExternalDragOver ? "app-shell external-drop-active" : "app-shell"}
      style={appShellStyle}
      onDragOver={handleExternalDragOver}
      onDragLeave={handleExternalDragLeave}
      onDrop={handleExternalDrop}
      onClick={() => setContextMenu(null)}
    >
      <header className="topbar" style={topbarStyle}>
        <button className="brand" type="button" onClick={() => setCurrentBoardId(null)}>
          <span className="brand-mark">K</span>
          <span className="brand-title">Keep Board</span>
        </button>
        <input
          className="search"
          placeholder={currentBoard ? "サムネイルを検索" : "ボードを検索"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="top-actions">
          <button
            className="toolbar-button compact"
            type="button"
            onClick={undoState}
            title="元に戻す"
            aria-label="元に戻す"
            disabled={!canUndo}
          >
            <span>↶</span>
          </button>
          <button
            className="toolbar-button compact"
            type="button"
            onClick={redoState}
            title="やり直す"
            aria-label="やり直す"
            disabled={!canRedo}
          >
            <span>↷</span>
          </button>
          {currentBoard && (
            <button
              className="toolbar-button compact icon-only"
              type="button"
              onClick={() => setCurrentBoardId(currentBoard.parentBoardId || null)}
              title="一つ上へ戻る"
              aria-label="一つ上へ戻る"
            >
              <span>↩</span>
            </button>
          )}
          <button
            className="toolbar-button compact"
            type="button"
            onClick={() => setDialog({ kind: "settings" })}
            title="設定"
            aria-label="設定"
          >
            <span>⚙</span>
          </button>
          <button
            className="toolbar-button accent icon-only board-create"
            type="button"
            onClick={() => setDialog({ kind: "board" })}
            title="新規ボード"
            aria-label="新規ボード"
          >
            <span>🗂️</span>
          </button>
        </div>
      </header>

      <main className={currentBoard ? "main board-main" : "main"}>
        {currentBoard ? (
          <>
            <section className="board-header">
              <div>
                <Breadcrumbs
                  path={getBoardPath(currentBoard)}
                  onHome={() => setCurrentBoardId(null)}
                  onMove={setCurrentBoardId}
                />
                {editingTitle ? (
                  <form
                    className="inline-title-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (titleDraft.trim()) updateBoard(currentBoard.id, titleDraft.trim());
                      setEditingTitle(false);
                    }}
                  >
                    <input
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                      onBlur={() => {
                        if (titleDraft.trim()) updateBoard(currentBoard.id, titleDraft.trim());
                        setEditingTitle(false);
                      }}
                      autoFocus
                    />
                  </form>
                ) : (
                  <h1
                    className="heading editable-heading"
                    onDoubleClick={() => {
                      setTitleDraft(currentBoard.title);
                      setEditingTitle(true);
                    }}
                  >
                    {currentBoard.title}
                  </h1>
                )}
              </div>
              <div className="menu">
                <button
                  className="toolbar-button accent icon-only board-add card-create"
                  type="button"
                  onClick={() => setIsAddMenuOpen((value) => !value)}
                  title="カードを追加"
                  aria-label="カードを追加"
                >
                  <span>🃏</span>
                </button>
                <div className="menu-panel" hidden={!isAddMenuOpen}>
                  <button type="button" onClick={() => openAdd("note")}>
                    メモ
                  </button>
                  <button type="button" onClick={() => openAdd("image")}>
                    画像
                  </button>
                  <button type="button" onClick={() => openAdd("video")}>
                    動画
                  </button>
                  <button type="button" onClick={() => openAdd("link")}>
                    リンク
                  </button>
                  <button type="button" onClick={() => openAdd("board")}>
                    サブボード
                  </button>
                </div>
              </div>
            </section>
            <BoardSidebar
              labels={boardLabels}
              labelStats={boardLabelStats}
              selectedLabels={selectedLabels}
              selectedItem={selectedItem}
              selectedTextItem={selectedTextItem}
              activeTool={activeTool}
              selectedImageItem={selectedImageItem}
              showAddPanel={showAddPanel}
              showShapePanel={showShapePanel}
              labelSortMode={labelSortMode}
              showLabelPanel={showLabelPanel}
              onToggleLabel={(label) =>
                setSelectedLabels((labels) =>
                  labels.includes(label) ? labels.filter((item) => item !== label) : [...labels, label],
                )
              }
              onClearLabels={() => setSelectedLabels([])}
              onToggleAddPanel={() => setShowAddPanel((current) => !current)}
              onToggleShapePanel={() => setShowShapePanel((current) => !current)}
              onLabelSortModeChange={setLabelSortMode}
              onToggleLabelPanel={() => setShowLabelPanel((current) => !current)}
              onStyleChange={(item, patch) => patchItem(item.id, patch)}
              onImageAction={(action, item) => {
                if (action === "crop") {
                  setDialog({ kind: "imageEdit", mode: "crop", item });
                } else if (action === "annotate") {
                  setDialog({ kind: "imageEdit", mode: "annotate", item });
                } else if (action === "edit-draw") {
                  setDialog({ kind: "drawEdit", item });
                }
              }}
              onPick={(tool) => {
                if (tool === "image" || tool === "video" || tool === "link" || tool === "note") {
                  setDialog({ kind: "item", type: tool });
                  return;
                }
                if (tool === "board") {
                  createSubBoard();
                  return;
                }
                if (tool === "draw" || tool.startsWith("shape-")) {
                  if (tool === "draw") {
                    setActiveTool((current) => (current === "draw" ? null : "draw"));
                    return;
                  }
                  setActiveTool((current) => (current === tool ? null : tool));
                  return;
                }
                createQuickItem(tool);
              }}
            />
            <BoardCanvas
              items={visibleBoardItems}
              boards={state.boards}
              zoom={settings.boardZoom}
              selectedIds={selectedItemIds}
              onSelectedIdsChange={setSelectedItemIds}
              onZoomChange={(boardZoom) => setSettings((current) => ({ ...current, boardZoom }))}
              getBoardThumbnail={getBoardThumbnail}
              activeCaptionId={activeCaptionId}
              onOpenBoard={setCurrentBoardId}
              onEditBoard={(board) => setDialog({ kind: "board", board })}
              onBoardContextMenu={openBoardContextMenu}
              onEdit={(target) => setDialog({ kind: "item", type: target.type, item: target })}
              onDelete={deleteItem}
              onTodoAdd={appendTodoItem}
              onTodoToggle={toggleTodoLine}
              onTodoEdit={updateTodoLine}
              onPatchItem={patchItem}
              onResize={resizeMediaItem}
              onToggleCaption={setActiveCaptionId}
              onOpenLightbox={setLightboxId}
              onItemContextMenu={openItemContextMenu}
              onMove={moveItemsOnBoard}
              onMoveToBoard={moveItemToBoard}
              activeTool={activeTool}
              onActiveToolChange={setActiveTool}
              onTextDoubleClick={(item) => {
                if (item.type === "draw") {
                  setDialog({ kind: "drawEdit", item });
                } else {
                  setDialog({ kind: "item", type: item.type, item });
                }
              }}
              onQuickAdd={(tool, position, overrides = {}) => {
                if (tool === "board") {
                  createSubBoard();
                  return;
                }
                if (tool === "draw") {
                  if (overrides.imagePath) {
                    createQuickItem("draw", position, overrides);
                    return;
                  }
                  setActiveTool("draw");
                  return;
                }
                if (tool === "image" || tool === "video") {
                  setDialog({ kind: "item", type: tool, position });
                  return;
                }
                createQuickItem(tool, position, overrides);
              }}
            />
            {!visibleBoardItems.length && (
              <p className="empty">{query ? "一致するカードがありません。" : "追加ボタンからカードを置けます。"}</p>
            )}
            <div className="drop-hint" aria-hidden={!isExternalDragOver}>
              ここにドロップしてカードを追加
            </div>
          </>
        ) : (
          <>
            <section className="board-header">
              <div>
                <h1 className="heading">ホーム</h1>
              </div>
            </section>
            <SortableGrid ids={visibleRootBoards.map((board) => board.id)} sensors={sensors} onDragEnd={handleHomeDragEnd}>
              {visibleRootBoards.map((board) => (
                <SortableCard key={board.id} id={board.id} span={3} rows={4}>
                  <BoardCard
                    board={board}
                    thumbnail={getBoardThumbnail(board)}
                    count={state.items.filter((item) => item.boardId === board.id).length}
                    onOpen={() => setCurrentBoardId(board.id)}
                    onEdit={() => setDialog({ kind: "board", board })}
                    onDelete={() => deleteBoard(board.id)}
                    onContextMenu={(event) => openBoardContextMenu(event, board)}
                  />
                </SortableCard>
              ))}
            </SortableGrid>
            {!rootBoards.length && <p className="empty">右上の新規ボードから始めましょう。</p>}
            {rootBoards.length > 0 && !visibleRootBoards.length && <p className="empty">一致するボードがありません。</p>}
          </>
        )}
      </main>

      {dialog?.kind === "board" && (
        <BoardDialog
          board={dialog.board}
          onClose={() => setDialog(null)}
          onSave={(values) => {
            if (dialog.board) {
              updateBoard(dialog.board.id, values);
            } else {
              createBoard(values, null);
            }
            setDialog(null);
          }}
        />
      )}

      {dialog?.kind === "item" && (
        <ItemDialog
          item={dialog.item}
          type={dialog.type}
          onClose={() => setDialog(null)}
          onSave={async (values) => {
            await saveItem(dialog.type, values, dialog.item, dialog.position || null);
            setDialog(null);
          }}
        />
      )}

      {dialog?.kind === "settings" && (
        <SettingsDialog
          settings={settings}
          theme={theme}
          onClose={() => setDialog(null)}
          onSave={(nextSettings, nextTheme) => {
            setSettings(nextSettings);
            setTheme(nextTheme);
            setDialog(null);
          }}
        />
      )}

      {dialog?.kind === "drawEdit" && (
        <DrawDialog
          initialImage={dialog.item?.imagePath || ""}
          title={dialog.item ? "Draw を編集" : "Draw Sticker"}
          onClose={() => setDialog(null)}
          onSave={(values) => {
            if (dialog.item) {
              patchItem(dialog.item.id, {
                imagePath: values.imagePath,
                widthUnits: values.widthUnits,
                heightUnits: values.heightUnits,
                sticker: true,
              });
            } else {
              createQuickItem("draw", dialog.position || { x: 40, y: 40 }, {
                imagePath: values.imagePath,
                widthUnits: values.widthUnits,
                heightUnits: values.heightUnits,
                sticker: true,
              });
            }
            setDialog(null);
          }}
        />
      )}

      {dialog?.kind === "imageEdit" && (
        <ImageEditDialog
          item={dialog.item}
          mode={dialog.mode}
          onClose={() => setDialog(null)}
          onSave={(nextImagePath) => {
            patchItem(dialog.item.id, { imagePath: nextImagePath });
            setDialog(null);
          }}
        />
      )}
      {contextMenu?.board && (
        <BoardContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onEdit={() => {
            setDialog({ kind: "board", board: contextMenu.board });
            setContextMenu(null);
          }}
          onDelete={() => {
            deleteBoard(contextMenu.board.id);
            setContextMenu(null);
          }}
        />
      )}

      {contextMenu?.item && (
        <ItemContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          item={contextMenu.item}
          onEdit={() => {
            setDialog({ kind: "item", type: contextMenu.item.type, item: contextMenu.item });
            setContextMenu(null);
          }}
          onDuplicate={() => {
            setContextMenu(null);
            duplicateSelectedItems([contextMenu.item.id]);
          }}
          onDownload={() => {
            const link = document.createElement("a");
            link.href = contextMenu.item.imagePath || contextMenu.item.url || "#";
            link.download = `${contextMenu.item.title || "card"}.${contextMenu.item.type === "video" ? "mp4" : "png"}`;
            link.click();
            setContextMenu(null);
          }}
          onOpenAsset={() => {
            window.open(contextMenu.item.imagePath || contextMenu.item.url, "_blank", "noopener,noreferrer");
            setContextMenu(null);
          }}
          onReplace={() => {
            openMediaReplacePicker(contextMenu.item);
            setContextMenu(null);
          }}
          onDrawEdit={() => {
            setDialog({ kind: "drawEdit", item: contextMenu.item });
            setContextMenu(null);
          }}
          onCrop={() => {
            setDialog({ kind: "imageEdit", mode: "crop", item: contextMenu.item });
            setContextMenu(null);
          }}
          onAnnotate={() => {
            setDialog({ kind: "imageEdit", mode: "annotate", item: contextMenu.item });
            setContextMenu(null);
          }}
          onDelete={() => {
            deleteItem(contextMenu.item);
            setContextMenu(null);
          }}
        />
      )}

      {lightboxItem && (
        <Lightbox
          item={lightboxItem}
          hasPrevious={lightboxIndex > 0}
          hasNext={lightboxIndex < visibleImages.length - 1}
          onClose={() => setLightboxId(null)}
          onPrevious={() => setLightboxId(visibleImages[lightboxIndex - 1]?.id || lightboxItem.id)}
          onNext={() => setLightboxId(visibleImages[lightboxIndex + 1]?.id || lightboxItem.id)}
          onTitleChange={(title) => patchItem(lightboxItem.id, { title })}
        />
      )}
    </div>
  );
}

function matchesSearch(record, query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [record.title, record.content, record.url, record.label]
    .filter(Boolean)
    .some((value) => value.toLowerCase().includes(normalized));
}

function matchesLabel(item, selectedLabels) {
  return selectedLabels.length === 0 || selectedLabels.includes(item.label);
}

function getItemSize(item) {
  const widthUnits = item.widthUnits || (item.type === "image" || item.type === "video" ? 4 : 3);
  const heightUnits = getItemRows(item);
  return {
    width: widthUnits * BOARD_UNIT + (widthUnits - 1) * BOARD_GAP,
    height: heightUnits * BOARD_ROW + (heightUnits - 1) * BOARD_GAP,
  };
}

function withDefaultPosition(item, index) {
  const width = getItemSize(item).width;
  const columns = Math.max(1, Math.floor(BOARD_CANVAS_WIDTH / Math.max(width + BOARD_GAP, 1)));
  return {
    ...item,
    x: Number.isFinite(item.x) ? item.x : (index % columns) * (width + BOARD_GAP),
    y: Number.isFinite(item.y) ? item.y : Math.floor(index / columns) * 260,
  };
}

function itemRect(item) {
  const size = getItemSize(item);
  return {
    x: item.x || 0,
    y: item.y || 0,
    width: size.width,
    height: size.height,
  };
}

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampPosition(item, position) {
  const size = getItemSize(item);
  const maxX = Math.max(0, BOARD_CANVAS_WIDTH - size.width - BOARD_EDGE_PADDING);
  return {
    x: clamp(Math.round(position.x / 10) * 10, 0, maxX),
    y: Math.max(0, Math.round(position.y / 10) * 10),
  };
}

function getOverlapArea(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function getOverlapRatio(a, b) {
  const overlapArea = getOverlapArea(a, b);
  if (!overlapArea) return 0;
  return overlapArea / Math.min(a.width * a.height, b.width * b.height);
}

function getRectCenter(rect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function isSwapZoneHit(movedRect, targetRect) {
  const center = getRectCenter(movedRect);
  const insetX = targetRect.width * SWAP_ZONE_INSET_RATIO;
  const insetY = targetRect.height * SWAP_ZONE_INSET_RATIO;
  return (
    center.x >= targetRect.x + insetX &&
    center.x <= targetRect.x + targetRect.width - insetX &&
    center.y >= targetRect.y + insetY &&
    center.y <= targetRect.y + targetRect.height - insetY
  );
}

function getLineAngle(from, to) {
  return Math.round((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI);
}

function distanceBetweenPositions(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function findNearestOpenPosition(item, items, preferredPosition, excludeIds = new Set()) {
  if (item.sticker) {
    return clampPosition(item, preferredPosition);
  }
  const size = getItemSize(item);
  const maxY =
    items.reduce((value, candidate) => Math.max(value, (candidate.y || 0) + itemRect(candidate).height), 0) + 2400;
  const start = clampPosition(item, preferredPosition);
  let best = null;

  function fits(candidate) {
    const rect = { x: candidate.x, y: candidate.y, width: size.width, height: size.height };
    return !items.some((other) => {
      if (other.id === item.id || excludeIds.has(other.id) || other.sticker) return false;
      return overlaps(rect, itemRect(other));
    });
  }

  const edgeSweeps = [
    start,
    clampPosition(item, { x: start.x - size.width - BOARD_GAP, y: start.y }),
    clampPosition(item, { x: start.x + size.width + BOARD_GAP, y: start.y }),
  ];

  for (const candidate of edgeSweeps) {
    if (fits(candidate)) return candidate;
  }

  for (let radius = 0; radius <= maxY + BOARD_CANVAS_WIDTH; radius += BOARD_DROP_STEP) {
    for (let y = Math.max(0, start.y - radius); y <= Math.min(maxY, start.y + radius); y += BOARD_DROP_STEP) {
      const horizontalReach = Math.max(0, radius - Math.abs(y - start.y));
      const candidates = horizontalReach ? [start.x, start.x - horizontalReach, start.x + horizontalReach] : [start.x];

      for (const rawX of candidates) {
        const candidate = clampPosition(item, { x: rawX, y });
        if (fits(candidate)) {
          const score = distanceBetweenPositions(candidate, start);
          if (!best || score < best.score) {
            best = { ...candidate, score };
          }
        }
      }
    }

    if (best) break;
  }

  return best ? { x: best.x, y: best.y } : start;
}

function resolveBoardPlacement(items, movedIds) {
  const movedSet = new Set(movedIds);
  const resolved = items.map((item) => ({ ...item }));
  const byId = new Map(resolved.map((item) => [item.id, item]));

  for (const item of resolved) {
    if (movedSet.has(item.id)) {
      Object.assign(item, clampPosition(item, item));
    }
  }

  if (movedIds.length === 1) {
    const moved = byId.get(movedIds[0]);
    if (moved?.sticker) {
      return resolved.map((item) => {
        const clone = { ...item };
        delete clone.originX;
        delete clone.originY;
        return clone;
      });
    }
    const stationary = resolved.filter((item) => item.id !== moved.id);
    const collisions = stationary
      .map((candidate) => ({
        candidate,
        ratio: getOverlapRatio(itemRect(moved), itemRect(candidate)),
        swapZoneHit: isSwapZoneHit(itemRect(moved), itemRect(candidate)),
      }))
      .filter((entry) => entry.ratio > 0)
      .sort((a, b) => b.ratio - a.ratio);

    if (collisions[0]) {
      if (collisions[0].ratio < SWAP_OVERLAP_RATIO || !collisions[0].swapZoneHit) {
        Object.assign(
          moved,
          findNearestOpenPosition(moved, stationary, { x: moved.x || 0, y: moved.y || 0 }),
        );
      } else {
        const target = collisions[0].candidate;
        const movedOrigin = { x: moved.originX ?? moved.x ?? 0, y: moved.originY ?? moved.y ?? 0 };
        const targetOrigin = { x: target.x || 0, y: target.y || 0 };

        Object.assign(moved, findNearestOpenPosition(moved, stationary, targetOrigin, new Set([target.id])));
        Object.assign(
          target,
          findNearestOpenPosition(
            target,
            resolved.filter((item) => item.id !== target.id),
            movedOrigin,
            new Set([moved.id]),
          ),
        );
      }
    }
  }

  const fixed = [];
  const moving = [];
  for (const item of resolved) {
    if (movedSet.has(item.id)) {
      moving.push(item);
    } else {
      fixed.push(item);
    }
  }

  for (const item of moving.sort((a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0))) {
    Object.assign(
      item,
      findNearestOpenPosition(item, [...fixed, ...moving.filter((candidate) => candidate.id !== item.id)], {
        x: item.x || 0,
        y: item.y || 0,
      }),
    );
    fixed.push(item);
  }

  return resolved.map((item) => {
    const clone = { ...item };
    delete clone.originX;
    delete clone.originY;
    return clone;
  });
}

function rectContainsPoint(rect, point) {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function getDragCollisionPreview(positionedById, dragState, offset) {
  if (!dragState || dragState.ids.length !== 1) return null;
  const moved = positionedById.get(dragState.ids[0]);
  if (!moved) return null;
  const movedRect = itemRect({
    ...moved,
    x: clampPosition(moved, { x: dragState.origins[moved.id].x + offset.x, y: dragState.origins[moved.id].y + offset.y }).x,
    y: clampPosition(moved, { x: dragState.origins[moved.id].x + offset.x, y: dragState.origins[moved.id].y + offset.y }).y,
  });
  const collisions = [...positionedById.values()]
    .filter((candidate) => candidate.id !== moved.id && !candidate.sticker)
    .map((candidate) => ({
      id: candidate.id,
      ratio: getOverlapRatio(movedRect, itemRect(candidate)),
      swapZoneHit: isSwapZoneHit(movedRect, itemRect(candidate)),
    }))
    .filter((entry) => entry.ratio > 0)
    .sort((a, b) => b.ratio - a.ratio);
  if (!collisions.length) return null;
  return {
    targetId: collisions[0].id,
    mode: collisions[0].ratio >= SWAP_OVERLAP_RATIO && collisions[0].swapZoneHit ? "swap" : "push",
  };
}

function normalizeSelectionRect(start, current) {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
}

function intersectsSelection(item, selection) {
  return overlaps(itemRect(item), selection);
}

function buildSurfaceStyle(mode, color, image, fallback) {
  const base = {
    backgroundColor: fallback,
    backgroundImage: "none",
  };

  if (mode === "solid" && color) {
    return {
      ...base,
      backgroundColor: color,
    };
  }

  if (mode === "image" && image) {
    const safeUrl = String(image).replace(/"/g, '\\"');
    return {
      ...base,
      backgroundImage: `linear-gradient(rgba(0, 0, 0, 0.18), rgba(0, 0, 0, 0.18)), url("${safeUrl}")`,
      backgroundPosition: "center",
      backgroundSize: "cover, contain",
      backgroundRepeat: "no-repeat, no-repeat",
    };
  }

  return base;
}

function getItemRows(item) {
  if (item.heightUnits) return item.heightUnits;
  if (item.aspectRatio && (item.type === "image" || item.type === "video")) {
    const widthUnits = item.widthUnits || 4;
    const width = widthUnits * BOARD_UNIT + (widthUnits - 1) * BOARD_GAP;
    return clamp(
      Math.round((width / Math.max(item.aspectRatio, 0.2) + BOARD_GAP) / (BOARD_ROW + BOARD_GAP)),
      MIN_CARD_ROWS,
      MAX_CARD_ROWS,
    );
  }
  if (item.type === "image" || item.type === "video") return 4;
  if (item.type === "board") return 3;
  return Math.min(6, Math.max(2, Math.ceil(((item.title || "").length + (item.content || "").length) / 80) + 2));
}

function parseTableRows(content) {
  const rawRows = (content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .split("|")
        .map((cell) => cell.trim())
        .filter((_, index, array) => !(array.length === 1 && index === 0 && !array[0])),
    );

  let rows = rawRows.length ? rawRows : [["項目", "内容"], ["", ""]];
  if (rows.length === 1) rows = [rows[0], Array(rows[0].length).fill("")];

  const separatorPattern = /^:?-{2,}:?$/;
  if (
    rows.length >= 2 &&
    rows[1].length > 0 &&
    rows[1].every((cell) => !cell || separatorPattern.test(cell))
  ) {
    rows.splice(1, 1);
  }

  const columnCount = Math.max(2, ...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => {
    const clone = [...row];
    while (clone.length < columnCount) clone.push("");
    return clone;
  });

  return normalizedRows;
}

function serializeTableRows(rows) {
  if (!rows.length) {
    return "項目 | 内容\n--- | ---\n | ";
  }

  const columnCount = Math.max(2, ...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => {
    const clone = [...row];
    while (clone.length < columnCount) clone.push("");
    return clone;
  });

  const header = normalizedRows[0];
  const body = normalizedRows.slice(1);
  const separator = Array(columnCount).fill("---");
  return [header.join(" | "), separator.join(" | "), ...body.map((row) => row.join(" | "))].join("\n");
}

function updateTableCellContent(content, rowIndex, cellIndex, value) {
  const rows = parseTableRows(content);
  if (!rows[rowIndex] || cellIndex < 0) return content;
  rows[rowIndex][cellIndex] = value;
  return serializeTableRows(rows);
}

function appendTableRowContent(content) {
  const rows = parseTableRows(content);
  const columnCount = Math.max(2, ...rows.map((row) => row.length));
  rows.push(Array(columnCount).fill(""));
  return serializeTableRows(rows);
}

function appendTableColumnContent(content) {
  const rows = parseTableRows(content);
  const nextColumnIndex = Math.max(0, ...rows.map((row) => row.length));
  rows.forEach((row, rowIndex) => {
    row.push(rowIndex === 0 ? `列${nextColumnIndex + 1}` : "");
  });
  return serializeTableRows(rows);
}

const IMAGE_FILE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "avif",
  "heic",
  "heif",
  "tif",
  "tiff",
]);

const VIDEO_FILE_EXTENSIONS = new Set([
  "mp4",
  "mov",
  "m4v",
  "webm",
  "avi",
  "mkv",
  "ogg",
  "ogv",
  "wmv",
  "flv",
  "mts",
  "m2ts",
]);

function getFileExtension(filename) {
  const matched = (filename || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return matched?.[1] || "";
}

function getDroppedMediaType(file) {
  if (!file) return "";
  if (file.type?.startsWith("image/")) return "image";
  if (file.type?.startsWith("video/")) return "video";
  const extension = getFileExtension(file.name);
  if (IMAGE_FILE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_FILE_EXTENSIONS.has(extension)) return "video";
  return "";
}

function collectDroppedFiles(dataTransfer) {
  if (!dataTransfer) return [];
  const directFiles = Array.from(dataTransfer.files || []);
  const itemFiles = Array.from(dataTransfer.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile?.())
    .filter(Boolean);
  const sourceFiles = directFiles.length ? directFiles : itemFiles;
  const unique = [];
  const seenStrict = new Set();
  const seenWeak = new Set();

  sourceFiles.forEach((file) => {
    const name = (file.name || "").trim().toLowerCase();
    const type = (file.type || "").trim().toLowerCase();
    const size = Number(file.size) || 0;
    const modified = Number(file.lastModified) || 0;
    const strictKey = `${name}|${type}|${size}|${modified}`;
    const weakKey = `${type}|${size}`;
    const weakEligible = size > 0 && (!name || !modified);
    if (seenStrict.has(strictKey)) return;
    if (weakEligible && seenWeak.has(weakKey)) return;
    seenStrict.add(strictKey);
    if (weakEligible) seenWeak.add(weakKey);
    unique.push(file);
  });

  return unique;
}

function buildDropSignature(dataTransfer) {
  if (!dataTransfer) return "";
  const files = collectDroppedFiles(dataTransfer);
  if (files.length) {
    return files
      .map((file) => `${(file.name || "").toLowerCase()}|${file.type || ""}|${file.size || 0}|${file.lastModified || 0}`)
      .sort()
      .join("||");
  }
  const uri = cleanDroppedUrl(dataTransfer.getData("text/uri-list"));
  const html = dataTransfer.getData("text/html") || "";
  const text = dataTransfer.getData("text/plain") || "";
  return `${uri}|${html.slice(0, 220)}|${text.slice(0, 220)}`;
}

async function resolveDroppedMediaFile(file) {
  try {
    const imagePath = await readImageFile(file);
    const declaredType = getDroppedMediaType(file);
    if (declaredType) {
      const declaredDimensions = await probeMediaDimensions(imagePath, declaredType);
      if (declaredDimensions.width > 0 && declaredDimensions.height > 0) {
        return { file, type: declaredType, imagePath, dimensions: declaredDimensions };
      }
    }

    const imageDimensions = await probeMediaDimensions(imagePath, "image");
    if (imageDimensions.width > 0 && imageDimensions.height > 0) {
      return { file, type: "image", imagePath, dimensions: imageDimensions };
    }

    const videoDimensions = await probeMediaDimensions(imagePath, "video");
    if (videoDimensions.width > 0 && videoDimensions.height > 0) {
      return { file, type: "video", imagePath, dimensions: videoDimensions };
    }
  } catch (error) {
    console.warn("Skipped unreadable dropped file", file?.name || "(unnamed)", error);
  }

  return null;
}

function hasExternalDropData(dataTransfer) {
  if (!dataTransfer) return false;
  if (getSidebarToolFromDataTransfer(dataTransfer)) return false;
  if (collectDroppedFiles(dataTransfer).length) return true;
  const types = Array.from(dataTransfer.types || []);
  return (
    types.includes("Files") ||
    types.includes("text/uri-list") ||
    types.includes("text/html") ||
    types.includes("text/plain")
  );
}

async function createItemFromDrop(dataTransfer) {
  const files = collectDroppedFiles(dataTransfer);
  let firstMedia = null;
  for (const file of files) {
    firstMedia = await resolveDroppedMediaFile(file);
    if (firstMedia) break;
  }

  if (firstMedia) {
    const { file, type, imagePath } = firstMedia;
    return {
      type,
      title: file.name.replace(/\.[^.]+$/, "") || (type === "video" ? "動画" : "画像"),
      content: "",
      imagePath,
      url: "",
      widthUnits: 4,
      heightUnits: 4,
    };
  }

  const html = dataTransfer.getData("text/html");
  const uri = cleanDroppedUrl(dataTransfer.getData("text/uri-list"));
  const text = dataTransfer.getData("text/plain").trim();
  const imageUrl = getImageUrlFromHtml(html) || (isImageUrl(uri) ? uri : "");
  const videoUrl = isVideoUrl(uri) ? uri : "";
  const url = uri || extractFirstUrl(text) || extractFirstUrl(html);

  if (videoUrl) {
    return {
      type: "video",
      title: titleFromUrl(videoUrl) || "動画",
      content: "",
      imagePath: videoUrl,
      url: videoUrl,
      widthUnits: 4,
      heightUnits: 4,
    };
  }

  if (imageUrl) {
    return {
      type: "image",
      title: titleFromUrl(imageUrl) || "画像",
      content: url && url !== imageUrl ? url : "",
      imagePath: imageUrl,
      url: imageUrl,
      widthUnits: 4,
      heightUnits: 4,
    };
  }

  if (url) {
    return {
      type: "link",
      title: titleFromUrl(url) || "リンク",
      content: text && text !== url ? text : "",
      imagePath: "",
      url,
      widthUnits: 2,
      heightUnits: 2,
    };
  }

  if (text) {
    return {
      type: "note",
      title: text.split(/\r?\n/)[0].slice(0, 60) || "ドロップメモ",
      content: text,
      imagePath: "",
      url: "",
      widthUnits: 2,
      heightUnits: 2,
    };
  }

  return null;
}

function cleanDroppedUrl(value) {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#")) || ""
  );
}

function extractFirstUrl(value) {
  return value.match(/https?:\/\/[^\s"'<>]+/)?.[0] || "";
}

function getImageUrlFromHtml(html) {
  if (!html) return "";
  const parsedDocument = new DOMParser().parseFromString(html, "text/html");
  return parsedDocument.querySelector("img")?.src || "";
}

function isImageUrl(value) {
  return /\.(apng|avif|gif|jpe?g|png|svg|webp)(\?.*)?$/i.test(value);
}

function isVideoUrl(value) {
  return /\.(mp4|m4v|mov|webm|ogv|ogg|avi|mkv)(\?.*)?$/i.test(value);
}

function titleFromUrl(value) {
  try {
    const url = new URL(value);
    const lastPath = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
    return lastPath.replace(/\.[^.]+$/, "") || url.hostname;
  } catch {
    return "";
  }
}

async function createDroppedVisualItem(dataTransfer) {
  const files = collectDroppedFiles(dataTransfer);
  let firstMedia = null;
  for (const file of files) {
    firstMedia = await resolveDroppedMediaFile(file);
    if (firstMedia) break;
  }

  if (firstMedia) {
    const { file, type, imagePath, dimensions } = firstMedia;
    return {
      type,
      title: file.name.replace(/\.[^.]+$/, "") || file.name,
      content: "",
      imagePath,
      url: "",
      ...getAspectBasedCardSize(dimensions.width, dimensions.height, type),
    };
  }

  const html = dataTransfer.getData("text/html");
  const uri = cleanDroppedUrl(dataTransfer.getData("text/uri-list"));
  const text = dataTransfer.getData("text/plain").trim();
  const imageUrl = getImageUrlFromHtml(html) || (isImageUrl(uri) ? uri : "");
  const videoUrl = isVideoUrl(uri) ? uri : "";
  const url = uri || extractFirstUrl(text) || extractFirstUrl(html);

  if (videoUrl) {
    const dimensions = await probeMediaDimensions(videoUrl, "video");
    return {
      type: "video",
      title: titleFromUrl(videoUrl) || "Video",
      content: "",
      imagePath: videoUrl,
      url: videoUrl,
      ...getAspectBasedCardSize(dimensions.width, dimensions.height, "video"),
    };
  }

  if (imageUrl) {
    const dimensions = await probeMediaDimensions(imageUrl, "image");
    return {
      type: "image",
      title: titleFromUrl(imageUrl) || "Image",
      content: url && url !== imageUrl ? url : "",
      imagePath: imageUrl,
      url: imageUrl,
      ...getAspectBasedCardSize(dimensions.width, dimensions.height, "image"),
    };
  }

  return createItemFromDrop(dataTransfer);
}

async function createDroppedVisualItems(dataTransfer) {
  const files = collectDroppedFiles(dataTransfer);
  const mediaFiles = (
    await Promise.all(
      files.map(async (file) => {
        const resolved = await resolveDroppedMediaFile(file);
        return resolved;
      }),
    )
  ).filter(Boolean);

  if (mediaFiles.length) {
    const mapped = await Promise.all(
      mediaFiles.map(async ({ file, type, imagePath, dimensions }) => {
        return {
          type,
          title: file.name.replace(/\.[^.]+$/, "") || (type === "video" ? "動画" : "画像"),
          content: "",
          imagePath,
          url: "",
          ...getAspectBasedCardSize(dimensions.width, dimensions.height, type),
        };
      }),
    );
    const unique = [];
    const seen = new Set();
    for (const item of mapped) {
      const key = `${item.type}|${item.imagePath}|${item.url || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }
    return unique;
  }

  const single = await createDroppedVisualItem(dataTransfer);
  return single ? [single] : [];
}

function SortableGrid({ children, ids, onDragEnd, sensors }) {
  if (!ids.length) return null;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        <section className="grid">{children}</section>
      </SortableContext>
    </DndContext>
  );
}

function SortableCard({ children, id, span = 2, rows = 2 }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    "--span": span,
    "--rows": rows,
  };

  return (
    <div
      ref={setNodeRef}
      className={isDragging ? "sortable dragging" : "sortable"}
      style={style}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

function BoardCanvas({
  items,
  boards,
  zoom,
  selectedIds,
  onSelectedIdsChange,
  onZoomChange,
  getBoardThumbnail,
  activeCaptionId,
  onOpenBoard,
  onEditBoard,
  onBoardContextMenu,
  onEdit,
  onDelete,
  onTodoAdd,
  onTodoToggle,
  onTodoEdit,
  onPatchItem,
  onResize,
  onToggleCaption,
  onOpenLightbox,
  onItemContextMenu,
  onMove,
  onMoveToBoard,
  activeTool,
  onActiveToolChange,
  onTextDoubleClick,
  onQuickAdd,
}) {
  const viewportRef = useRef(null);
  const boardRef = useRef(null);
  const toolCanvasRef = useRef(null);
  const drawColorInputRef = useRef(null);
  const drawDraftRef = useRef(null);
  const dragFrameRef = useRef(0);
  const [selectionRect, setSelectionRect] = useState(null);
  const [dragState, setDragState] = useState(null);
  const [panState, setPanState] = useState(null);
  const [shapeDraft, setShapeDraft] = useState(null);
  const [drawColor, setDrawColor] = useState("#ffffff");
  const [drawSize, setDrawSize] = useState(10);
  const [drawTool, setDrawTool] = useState("pen");
  const [drawStrokes, setDrawStrokes] = useState([]);
  const [drawRedoStrokes, setDrawRedoStrokes] = useState([]);
  const positionedItems = useMemo(() => items.map((item, index) => withDefaultPosition(item, index)), [items]);
  const positionedById = useMemo(
    () => new Map(positionedItems.map((item) => [item.id, item])),
    [positionedItems],
  );
  const canvasHeight =
    positionedItems.reduce((height, item) => Math.max(height, item.y + itemRect(item).height), 360) + 180;

  function paintStroke(context, stroke, scale = 1) {
    if (!stroke?.points?.length) return;
    context.save();
    context.globalCompositeOperation = stroke.mode === "eraser" ? "destination-out" : "source-over";
    context.strokeStyle = stroke.color || "#ffffff";
    context.lineWidth = Math.max(1, (stroke.size || 8) * scale);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let index = 1; index < stroke.points.length; index += 1) {
      const point = stroke.points[index];
      context.lineTo(point.x, point.y);
    }
    context.stroke();
    context.restore();
  }

  function redrawDrawCanvas(withDraft = drawDraftRef.current) {
    const canvas = toolCanvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of drawStrokes) paintStroke(context, stroke);
    if (withDraft) paintStroke(context, withDraft);
  }

  useEffect(() => {
    const canvas = toolCanvasRef.current;
    if (!canvas) return;
    canvas.width = BOARD_CANVAS_WIDTH;
    canvas.height = canvasHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.lineCap = "round";
    context.lineJoin = "round";
    redrawDrawCanvas();
  }, [activeTool, canvasHeight]);

  useEffect(() => {
    if (activeTool === "draw") {
      onSelectedIdsChange([]);
      setShapeDraft(null);
      return;
    }
    if (activeTool) return;
    drawDraftRef.current = null;
    setDrawStrokes([]);
    setDrawRedoStrokes([]);
    setShapeDraft(null);
    redrawDrawCanvas(null);
  }, [activeTool]);

  useEffect(() => {
    if (activeTool !== "draw") return;
    redrawDrawCanvas();
  }, [drawStrokes, canvasHeight, activeTool]);

  useEffect(() => {
    function handleGlobalPointerMove(event) {
      if (panState) {
        event.preventDefault();
        const viewport = viewportRef.current;
        if (!viewport) return;
        viewport.scrollLeft = panState.scrollLeft - (event.clientX - panState.startX);
        window.scrollTo({ top: Math.max(0, panState.scrollTop - (event.clientY - panState.startY)) });
        return;
      }

      if (selectionRect) {
        const current = toBoardPoint(event.clientX, event.clientY);
        const nextRect = normalizeSelectionRect(selectionRect.anchor, current);
        setSelectionRect({ ...selectionRect, current, rect: nextRect });
        onSelectedIdsChange(
          positionedItems.filter((item) => intersectsSelection(item, nextRect)).map((item) => item.id),
        );
        return;
      }

      if (drawDraftRef.current) {
        event.preventDefault();
        const point = toBoardPoint(event.clientX, event.clientY);
        drawDraftRef.current = {
          ...drawDraftRef.current,
          points: [...drawDraftRef.current.points, point],
        };
        redrawDrawCanvas();
        return;
      }

      if (shapeDraft) {
        event.preventDefault();
        const current = toBoardPoint(event.clientX, event.clientY);
        setShapeDraft((previous) => (previous ? { ...previous, current } : previous));
        return;
      }

      if (!dragState) return;
      event.preventDefault();
      const point = toBoardPoint(event.clientX, event.clientY);
      const deltaX = point.x - dragState.startPoint.x;
      const deltaY = point.y - dragState.startPoint.y;
      const nextOffset = { x: deltaX, y: deltaY };
      const collisionPreview = getDragCollisionPreview(positionedById, dragState, nextOffset);
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = requestAnimationFrame(() => {
        setDragState((currentState) => ({
          ...currentState,
          offset: nextOffset,
          collisionPreview,
        }));
      });
    }

    function handleGlobalPointerUp(event) {
      if (panState) {
        setPanState(null);
        return;
      }

      if (selectionRect) {
        setSelectionRect(null);
        return;
      }

      if (drawDraftRef.current) {
        const draft = drawDraftRef.current;
        drawDraftRef.current = null;
        if (draft.points.length >= 2) {
          setDrawStrokes((previous) => [...previous, draft]);
          setDrawRedoStrokes([]);
        }
        redrawDrawCanvas(null);
        return;
      }

      if (shapeDraft) {
        const rect = normalizeSelectionRect(shapeDraft.start, shapeDraft.current);
        let widthUnits = clamp(Math.ceil((rect.width + BOARD_GAP) / (BOARD_UNIT + BOARD_GAP)), 1, MAX_CARD_SPAN);
        let heightUnits = clamp(Math.ceil((rect.height + BOARD_GAP) / (BOARD_ROW + BOARD_GAP)), 1, MAX_CARD_ROWS);
        let angleDeg = 0;
        let position = { x: rect.x, y: rect.y };

        if (shapeDraft.tool === "shape-line") {
          const dx = shapeDraft.current.x - shapeDraft.start.x;
          const dy = shapeDraft.current.y - shapeDraft.start.y;
          const length = Math.max(24, Math.hypot(dx, dy));
          const lineHeightPx = 20;
          widthUnits = clamp(Math.ceil((length + BOARD_GAP) / (BOARD_UNIT + BOARD_GAP)), 1, MAX_CARD_SPAN);
          heightUnits = 1;
          angleDeg = getLineAngle(shapeDraft.start, shapeDraft.current);
          const pixelWidth = widthUnits * BOARD_UNIT + (widthUnits - 1) * BOARD_GAP;
          const pixelHeight = lineHeightPx;
          const centerX = (shapeDraft.start.x + shapeDraft.current.x) / 2;
          const centerY = (shapeDraft.start.y + shapeDraft.current.y) / 2;
          position = { x: centerX - pixelWidth / 2, y: centerY - pixelHeight / 2 };
        }

        onQuickAdd(
          shapeDraft.tool,
          clampPosition({ type: shapeDraft.tool, widthUnits, heightUnits, sticker: true }, position),
          {
            widthUnits,
            heightUnits,
            sticker: true,
            angleDeg,
            strokeColor: "#ffffff",
            strokeWidth: 4,
          },
        );
        setShapeDraft(null);
        onActiveToolChange(null);
        return;
      }

      if (!dragState) return;
      const dropBoard = document
        .elementsFromPoint(event.clientX, event.clientY)
        .map((element) => element.closest?.("[data-board-drop-id]"))
        .find(Boolean);
      const targetBoardId = dropBoard?.dataset.boardDropId;

      const movedIds = dragState.ids;
      const preview = Object.fromEntries(
        movedIds.map((id) => {
          const origin = dragState.origins[id];
          const item = positionedById.get(id);
          const position = clampPosition(item, {
            x: origin.x + (dragState.offset?.x || 0),
            y: origin.y + (dragState.offset?.y || 0),
          });
          return [id, position];
        }),
      );
      setDragState(null);
      cancelAnimationFrame(dragFrameRef.current);
      window.setTimeout(() => {
        delete document.body.dataset.internalCardDrag;
      }, 0);

      if (targetBoardId && movedIds.length === 1) {
        const moved = positionedById.get(movedIds[0]);
        if (targetBoardId && targetBoardId !== moved.linkedBoardId) {
          onMoveToBoard(moved, targetBoardId);
          return;
        }
      }

      onMove(movedIds, preview);
    }

    window.addEventListener("pointermove", handleGlobalPointerMove, { passive: false });
    window.addEventListener("pointerup", handleGlobalPointerUp);
    window.addEventListener("pointercancel", handleGlobalPointerUp);
    return () => {
      cancelAnimationFrame(dragFrameRef.current);
      window.removeEventListener("pointermove", handleGlobalPointerMove);
      window.removeEventListener("pointerup", handleGlobalPointerUp);
      window.removeEventListener("pointercancel", handleGlobalPointerUp);
    };
  }, [
    activeTool,
    dragState,
    drawStrokes,
    onMove,
    onMoveToBoard,
    onSelectedIdsChange,
    panState,
    positionedById,
    positionedItems,
    selectionRect,
    shapeDraft,
  ]);

  function toBoardPoint(clientX, clientY) {
    const boardRect = boardRef.current?.getBoundingClientRect();
    if (!boardRect) return { x: 0, y: 0 };
    return {
      x: (clientX - boardRect.left) / zoom,
      y: (clientY - boardRect.top) / zoom,
    };
  }

  function handleViewportPointerDown(event) {
    if (event.button === 1) {
      event.preventDefault();
      const viewport = viewportRef.current;
      if (!viewport) return;
      setPanState({
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: viewport.scrollLeft,
        scrollTop: window.scrollY,
      });
      return;
    }

    if (event.button !== 0) return;
    if (event.target.closest(".free-card, button, a, input, textarea, select, video")) return;

    if (activeTool === "draw") {
      event.preventDefault();
      const start = toBoardPoint(event.clientX, event.clientY);
      drawDraftRef.current = {
        mode: drawTool,
        color: drawColor,
        size: drawSize,
        points: [start],
      };
      redrawDrawCanvas();
      return;
    }

    if (activeTool?.startsWith("shape-")) {
      event.preventDefault();
      const start = toBoardPoint(event.clientX, event.clientY);
      setShapeDraft({ tool: activeTool, start, current: start });
      return;
    }

    const anchor = toBoardPoint(event.clientX, event.clientY);
    onSelectedIdsChange([]);
    setSelectionRect({
      anchor,
      current: anchor,
      rect: { x: anchor.x, y: anchor.y, width: 0, height: 0 },
    });
  }

  function handleWheel(event) {
    if (!event.ctrlKey) {
      event.preventDefault();
      const viewport = viewportRef.current;
      if (viewport && event.deltaX) {
        viewport.scrollLeft += event.deltaX;
      }
      window.scrollBy({ top: event.deltaY, behavior: "auto" });
      return;
    }
    event.preventDefault();
    const viewport = viewportRef.current;
    if (!viewport) return;

    const nextZoom = clamp(Number((zoom - event.deltaY * 0.0015).toFixed(2)), BOARD_ZOOM_MIN, BOARD_ZOOM_MAX);
    if (nextZoom === zoom) return;

    const boardRect = boardRef.current?.getBoundingClientRect();
    const pointerX = event.clientX - (boardRect?.left || 0);
    const pointerY = event.clientY - (boardRect?.top || 0);
    const contentX = (viewport.scrollLeft + pointerX) / zoom;
    const contentY = (viewport.scrollTop + pointerY) / zoom;

    onZoomChange(nextZoom);
    requestAnimationFrame(() => {
      viewport.scrollLeft = contentX * nextZoom - pointerX;
      window.scrollTo({ top: contentY * nextZoom - pointerY });
    });
  }

  function handleCardPointerDown(event, item) {
    if (activeTool === "draw") return;
    if (event.button !== 0) return;
    if (event.target.closest("button, a, input, textarea, select, video, .resize-handle")) return;

    const point = toBoardPoint(event.clientX, event.clientY);
    const nextSelection =
      event.ctrlKey || event.metaKey
        ? selectedIds.includes(item.id)
          ? selectedIds.filter((id) => id !== item.id)
          : [...selectedIds, item.id]
        : selectedIds.includes(item.id)
          ? selectedIds
          : [item.id];

    const dragIds = nextSelection.length ? nextSelection : [item.id];
    onSelectedIdsChange(dragIds);
    document.body.dataset.internalCardDrag = "true";
    setDragState({
      ids: dragIds,
      startPoint: point,
      offset: { x: 0, y: 0 },
      origins: Object.fromEntries(
        dragIds.map((id) => {
          const positioned = positionedById.get(id);
          return [id, { x: positioned.x || 0, y: positioned.y || 0 }];
        }),
      ),
      collisionPreview: null,
    });
  }

  function handleBoardDragOver(event) {
    const tool = getSidebarToolFromDataTransfer(event.dataTransfer);
    if (!tool) return;
    event.preventDefault();
  }

  function handleBoardDrop(event) {
    const tool = getSidebarToolFromDataTransfer(event.dataTransfer);
    if (!tool) return;
    event.preventDefault();
    event.stopPropagation();
    const position = clampPosition(
      { widthUnits: 4, heightUnits: 4, type: tool, sticker: tool.startsWith("shape-") || tool === "draw" },
      toBoardPoint(event.clientX, event.clientY),
    );
    onQuickAdd(tool, position);
  }

  function handleDrawUndo() {
    setDrawStrokes((previous) => {
      if (!previous.length) return previous;
      const next = previous.slice(0, -1);
      const removed = previous[previous.length - 1];
      setDrawRedoStrokes((redo) => [...redo, removed]);
      return next;
    });
  }

  function handleDrawRedo() {
    setDrawRedoStrokes((previous) => {
      if (!previous.length) return previous;
      const restored = previous[previous.length - 1];
      setDrawStrokes((strokes) => [...strokes, restored]);
      return previous.slice(0, -1);
    });
  }

  function handleDrawDiscard() {
    drawDraftRef.current = null;
    setDrawStrokes([]);
    setDrawRedoStrokes([]);
    redrawDrawCanvas(null);
    onActiveToolChange(null);
  }

  function trimCanvasContent(sourceCanvas) {
    const context = sourceCanvas.getContext("2d");
    if (!context) return sourceCanvas;
    const { width, height } = sourceCanvas;
    const pixels = context.getImageData(0, 0, width, height).data;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const alpha = pixels[(y * width + x) * 4 + 3];
        if (alpha <= 2) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (maxX < minX || maxY < minY) return sourceCanvas;
    const trimmed = document.createElement("canvas");
    trimmed.width = Math.max(8, maxX - minX + 1);
    trimmed.height = Math.max(8, maxY - minY + 1);
    const trimmedContext = trimmed.getContext("2d");
    if (!trimmedContext) return sourceCanvas;
    trimmedContext.drawImage(sourceCanvas, minX, minY, trimmed.width, trimmed.height, 0, 0, trimmed.width, trimmed.height);
    return trimmed;
  }

  function handleDrawSave() {
    if (!drawStrokes.length) {
      handleDrawDiscard();
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const stroke of drawStrokes) {
      const pad = Math.max(1, stroke.size || 8) / 2 + 4;
      for (const point of stroke.points) {
        minX = Math.min(minX, point.x - pad);
        minY = Math.min(minY, point.y - pad);
        maxX = Math.max(maxX, point.x + pad);
        maxY = Math.max(maxY, point.y + pad);
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return;
    }
    const width = Math.max(12, Math.ceil(maxX - minX));
    const height = Math.max(12, Math.ceil(maxY - minY));
    const offscreen = document.createElement("canvas");
    offscreen.width = width;
    offscreen.height = height;
    const context = offscreen.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    for (const stroke of drawStrokes) {
      const translated = {
        ...stroke,
        points: stroke.points.map((point) => ({ x: point.x - minX, y: point.y - minY })),
      };
      paintStroke(context, translated);
    }
    const trimmed = trimCanvasContent(offscreen);
    const widthUnits = clamp(Math.ceil((trimmed.width + BOARD_GAP) / (BOARD_UNIT + BOARD_GAP)), 1, MAX_CARD_SPAN);
    const heightUnits = clamp(Math.ceil((trimmed.height + BOARD_GAP) / (BOARD_ROW + BOARD_GAP)), 1, MAX_CARD_ROWS);
    const position = clampPosition({ type: "draw", widthUnits, heightUnits, sticker: true }, { x: minX, y: minY });
    onQuickAdd("draw", position, {
      imagePath: trimmed.toDataURL("image/png"),
      widthUnits,
      heightUnits,
      sticker: true,
    });
    drawDraftRef.current = null;
    setDrawStrokes([]);
    setDrawRedoStrokes([]);
    redrawDrawCanvas(null);
    onActiveToolChange(null);
  }

  return (
    <div
      ref={viewportRef}
      className={panState ? "board-viewport panning" : "board-viewport"}
      onPointerDown={handleViewportPointerDown}
      onWheel={handleWheel}
      onDragOver={handleBoardDragOver}
      onDrop={handleBoardDrop}
    >
      <div
        className="board-scale-shell"
        style={{
          width: BOARD_CANVAS_WIDTH * zoom,
          minHeight: canvasHeight * zoom,
        }}
      >
        {activeTool === "draw" && (
          <div className="draw-toolbar-board" onPointerDown={(event) => event.stopPropagation()}>
            <button
              className={drawTool === "pen" ? "draw-mode-btn active" : "draw-mode-btn"}
              type="button"
              onClick={() => setDrawTool("pen")}
            >
              ペン
            </button>
            <button
              className={drawTool === "eraser" ? "draw-mode-btn active" : "draw-mode-btn"}
              type="button"
              onClick={() => setDrawTool("eraser")}
            >
              消しゴム
            </button>
            <label className="field draw-field compact draw-color-field">
              <span>色</span>
              <button
                className="draw-color-button"
                type="button"
                onClick={() => drawColorInputRef.current?.click()}
                aria-label="色を選択"
              >
                <span className="draw-color-swatch" style={{ background: drawColor }} />
              </button>
              <input
                ref={drawColorInputRef}
                className="draw-color-native"
                type="color"
                value={drawColor}
                onChange={(event) => setDrawColor(event.target.value)}
              />
            </label>
            <label className="field draw-field compact">
              <span>太さ: {drawSize}px</span>
              <input
                type="range"
                min="1"
                max="36"
                value={drawSize}
                onChange={(event) => setDrawSize(Number(event.target.value))}
              />
            </label>
            <button className="draw-mini-btn" type="button" onClick={handleDrawUndo} disabled={!drawStrokes.length}>
              Undo
            </button>
            <button className="draw-mini-btn" type="button" onClick={handleDrawRedo} disabled={!drawRedoStrokes.length}>
              Redo
            </button>
            <button className="draw-mini-btn" type="button" onClick={handleDrawDiscard}>
              Discard
            </button>
            <button className="draw-save-btn" type="button" onClick={handleDrawSave}>
              Save
            </button>
          </div>
        )}
        <section
          ref={boardRef}
          className={activeTool === "draw" ? "free-board tool-active draw-mode" : activeTool ? "free-board tool-active" : "free-board"}
          data-board-root="true"
          data-zoom={zoom}
          style={{
            width: BOARD_CANVAS_WIDTH,
            minHeight: canvasHeight,
            transform: `scale(${zoom})`,
            transformOrigin: "top left",
          }}
        >
          {positionedItems.map((item) => (
            <FreeCard
              key={item.id}
              item={positionedById.get(item.id) || item}
              boards={boards}
              selected={selectedIds.includes(item.id)}
              dragging={dragState?.ids.includes(item.id)}
              dragOffset={dragState?.ids.includes(item.id) ? dragState.offset : null}
              dropIndicator={
                dragState?.collisionPreview?.targetId === item.id ? dragState.collisionPreview.mode : null
              }
              getBoardThumbnail={getBoardThumbnail}
              activeCaptionId={activeCaptionId}
              onOpenBoard={onOpenBoard}
              onEditBoard={onEditBoard}
              onBoardContextMenu={onBoardContextMenu}
              onEdit={onEdit}
              onDelete={onDelete}
              onTodoAdd={onTodoAdd}
              onTodoToggle={onTodoToggle}
              onTodoEdit={onTodoEdit}
              onPatchItem={onPatchItem}
              onResize={onResize}
              onToggleCaption={onToggleCaption}
              onOpenLightbox={onOpenLightbox}
              onItemContextMenu={onItemContextMenu}
              onPointerDown={handleCardPointerDown}
              onTextDoubleClick={onTextDoubleClick}
            />
          ))}
          <canvas
            ref={toolCanvasRef}
            className={activeTool ? "board-tool-canvas active" : "board-tool-canvas"}
            style={{ width: BOARD_CANVAS_WIDTH, height: canvasHeight }}
          />
          {shapeDraft && (
            <div
              className={`shape-preview ${shapeDraft.tool}`}
              style={{
                left: Math.min(shapeDraft.start.x, shapeDraft.current.x),
                top: Math.min(shapeDraft.start.y, shapeDraft.current.y),
                width: Math.max(12, Math.abs(shapeDraft.current.x - shapeDraft.start.x)),
                height: Math.max(12, Math.abs(shapeDraft.current.y - shapeDraft.start.y)),
                transform:
                  shapeDraft.tool === "shape-line"
                    ? `rotate(${getLineAngle(shapeDraft.start, shapeDraft.current)}deg)`
                    : undefined,
                transformOrigin: shapeDraft.tool === "shape-line" ? "left center" : undefined,
              }}
            />
          )}
          {selectionRect?.rect && (
            <div
              className="selection-box"
              style={{
                left: selectionRect.rect.x,
                top: selectionRect.rect.y,
                width: selectionRect.rect.width,
                height: selectionRect.rect.height,
              }}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function FreeCard({
  item,
  boards,
  selected,
  dragging,
  dragOffset,
  dropIndicator,
  getBoardThumbnail,
  activeCaptionId,
  onOpenBoard,
  onEditBoard,
  onBoardContextMenu,
  onEdit,
  onDelete,
  onTodoAdd,
  onTodoToggle,
  onTodoEdit,
  onPatchItem,
  onResize,
  onToggleCaption,
  onOpenLightbox,
  onItemContextMenu,
  onPointerDown,
  onTextDoubleClick,
}) {
  const board = boards.find((candidate) => candidate.id === item.linkedBoardId);
  const size = getItemSize(item);

  return (
    <div
      className={[
        "free-card",
        selected ? "selected-free" : "",
        dragging ? "dragging-free" : "",
        dropIndicator ? `drop-${dropIndicator}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        left: item.x || 0,
        top: item.y || 0,
        width: size.width,
        height: size.height,
        transform: dragOffset ? `translate3d(${dragOffset.x}px, ${dragOffset.y}px, 0)` : undefined,
      }}
      onDragStart={(event) => event.preventDefault()}
      onPointerDown={(event) => onPointerDown(event, item)}
      onDoubleClick={() => {
        if (item.type === "image" || item.type === "video") onOpenLightbox(item.id);
      }}
    >
      <ItemCard
        item={item}
        board={board}
        thumbnail={getBoardThumbnail(board || {})}
        isCaptionVisible={activeCaptionId === item.id}
        onOpenBoard={onOpenBoard}
        onEditBoard={onEditBoard}
        onBoardContextMenu={onBoardContextMenu}
        onEdit={onEdit}
        onDelete={onDelete}
        onTodoAdd={onTodoAdd}
        onTodoToggle={onTodoToggle}
        onTodoEdit={onTodoEdit}
        onPatchItem={onPatchItem}
        onResize={onResize}
        onToggleCaption={onToggleCaption}
        onOpenLightbox={onOpenLightbox}
        onItemContextMenu={onItemContextMenu}
        onTextDoubleClick={onTextDoubleClick}
      />
    </div>
  );
}

function getSidebarToolFromDataTransfer(dataTransfer) {
  if (!dataTransfer) return "";
  const direct = dataTransfer.getData("application/x-keep-tool");
  if (direct) return direct;
  const text = dataTransfer.getData("text/plain");
  const matched = text.match(/^keep-tool:(.+)$/);
  return matched?.[1] || "";
}

function BoardSidebar({
  labels,
  labelStats,
  selectedLabels,
  selectedItem,
  selectedTextItem,
  activeTool,
  selectedImageItem,
  showAddPanel,
  showShapePanel,
  labelSortMode,
  showLabelPanel,
  onToggleLabel,
  onClearLabels,
  onPick,
  onToggleAddPanel,
  onToggleShapePanel,
  onLabelSortModeChange,
  onToggleLabelPanel,
  onStyleChange,
  onImageAction,
}) {
  const addTools = [
    { id: "note", label: "Note", icon: "📝" },
    { id: "image", label: "Image", icon: "🖼" },
    { id: "link", label: "Link", icon: "🔗" },
    { id: "todo", label: "リスト", icon: "☑" },
    { id: "comment", label: "Comment", icon: "💬" },
    { id: "column", label: "Column", icon: "▤" },
    { id: "table", label: "Table", icon: "▦" },
    { id: "board", label: "Board", icon: "◫" },
  ];
  const shapeTools = [
    { id: "shape-line", label: "Line", icon: "／" },
    { id: "shape-rect", label: "Rect", icon: "▭" },
    { id: "shape-circle", label: "Circle", icon: "◯" },
    { id: "draw", label: "Draw", icon: "✎" },
  ];
  const sortedLabelStats = [...labelStats].sort((a, b) => {
    if (labelSortMode === "name-asc") return a.label.localeCompare(b.label, "ja");
    if (labelSortMode === "name-desc") return b.label.localeCompare(a.label, "ja");
    if (labelSortMode === "selected-first") {
      const aSelected = selectedLabels.includes(a.label) ? 1 : 0;
      const bSelected = selectedLabels.includes(b.label) ? 1 : 0;
      if (aSelected !== bSelected) return bSelected - aSelected;
      return b.count - a.count || a.label.localeCompare(b.label, "ja");
    }
    return b.count - a.count || a.label.localeCompare(b.label, "ja");
  });
  return (
    <aside className="board-sidebar">
      <div className="board-sidebar-tab">Tools</div>
      <div className="board-sidebar-panel">
        <section className="sidebar-section">
          <div className="sidebar-title">メニュー</div>
          <div className="sidebar-root-grid">
            <button className={showAddPanel ? "tool-button active" : "tool-button"} type="button" onClick={onToggleAddPanel}>
              <span>＋</span>
              <small>カード</small>
            </button>
            <button className={showShapePanel ? "tool-button active" : "tool-button"} type="button" onClick={onToggleShapePanel}>
              <span>✎</span>
              <small>図形</small>
            </button>
            <button className={showLabelPanel ? "tool-button active" : "tool-button"} type="button" onClick={onToggleLabelPanel}>
              <span>#</span>
              <small>ラベル</small>
            </button>
          </div>
          {showLabelPanel && (
            <div className="label-panel sidebar-subpanel">
              <label className="field">
                <span>並び替え</span>
                <select value={labelSortMode} onChange={(event) => onLabelSortModeChange(event.target.value)}>
                  <option value="count-desc">使用数が多い順</option>
                  <option value="selected-first">選択中を先頭</option>
                  <option value="name-asc">名前 昇順</option>
                  <option value="name-desc">名前 降順</option>
                </select>
              </label>
              {!labels.length && <p className="sidebar-empty">このボードにはまだラベルがありません。</p>}
              {sortedLabelStats.map((entry) => (
                <label className="label-check" key={entry.label}>
                  <input
                    type="checkbox"
                    checked={selectedLabels.includes(entry.label)}
                    onChange={() => onToggleLabel(entry.label)}
                  />
                  <span>{entry.label}</span>
                  <small>{entry.count}</small>
                </label>
              ))}
              {!!selectedLabels.length && (
                <button className="ghost sidebar-clear" type="button" onClick={onClearLabels}>
                  すべて表示
                </button>
              )}
            </div>
          )}
        </section>

        {showAddPanel && (
          <section className="sidebar-section">
            <div className="sidebar-title">カード追加</div>
            <div className="sidebar-tool-grid">
              {addTools.map((tool) => (
                <button
                  key={tool.id}
                  className={activeTool === tool.id ? "tool-button active" : "tool-button"}
                  type="button"
                  draggable
                  onClick={() => onPick(tool.id)}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "copy";
                    event.dataTransfer.setData("application/x-keep-tool", tool.id);
                    event.dataTransfer.setData("text/plain", `keep-tool:${tool.id}`);
                  }}
                >
                  <span>{tool.icon}</span>
                  <small>{tool.label}</small>
                </button>
              ))}
            </div>
          </section>
        )}

        {showShapePanel && (
          <section className="sidebar-section">
            <div className="sidebar-title">図形追加</div>
            <div className="sidebar-tool-grid">
              {shapeTools.map((tool) => (
                <button
                  key={tool.id}
                  className={activeTool === tool.id ? "tool-button active" : "tool-button"}
                  type="button"
                  draggable
                  onClick={() => onPick(tool.id)}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "copy";
                    event.dataTransfer.setData("application/x-keep-tool", tool.id);
                    event.dataTransfer.setData("text/plain", `keep-tool:${tool.id}`);
                  }}
                >
                  <span>{tool.icon}</span>
                  <small>{tool.label}</small>
                </button>
              ))}
            </div>
          </section>
        )}

        {selectedImageItem && (
          <section className="sidebar-section">
            <div className="sidebar-title">画像ツール</div>
            <button className="tool-button image-tool" type="button" onClick={() => onImageAction("crop", selectedImageItem)}>
              <span>✂</span>
              <small>クリップ</small>
            </button>
            {selectedImageItem.type === "image" && (
              <button className="tool-button image-tool" type="button" onClick={() => onImageAction("annotate", selectedImageItem)}>
                <span>✎</span>
                <small>書き込み</small>
              </button>
            )}
          </section>
        )}

        {selectedTextItem && (
          <section className="sidebar-section">
            <div className="sidebar-title">テキストツール</div>
            <label className="field">
              <span>文字色</span>
              <input
                type="color"
                value={selectedTextItem.textColor || "#232323"}
                onChange={(event) => onStyleChange(selectedTextItem, { textColor: event.target.value })}
              />
            </label>
            <div className="sidebar-text-tools">
              <button
                className={selectedTextItem.fontWeight === "700" ? "tool-button compact active" : "tool-button compact"}
                type="button"
                onClick={() => onStyleChange(selectedTextItem, { fontWeight: selectedTextItem.fontWeight === "700" ? "400" : "700" })}
              >
                <span>B</span>
              </button>
              <button
                className={selectedTextItem.fontStyle === "italic" ? "tool-button compact active" : "tool-button compact"}
                type="button"
                onClick={() => onStyleChange(selectedTextItem, { fontStyle: selectedTextItem.fontStyle === "italic" ? "normal" : "italic" })}
              >
                <span>I</span>
              </button>
              <button
                className={
                  selectedTextItem.textDecoration === "underline" ? "tool-button compact active" : "tool-button compact"
                }
                type="button"
                onClick={() =>
                  onStyleChange(selectedTextItem, {
                    textDecoration: selectedTextItem.textDecoration === "underline" ? "none" : "underline",
                  })
                }
              >
                <span>U</span>
              </button>
            </div>
            <label className="field">
              <span>寄せ</span>
              <select
                value={selectedTextItem.textAlign || "left"}
                onChange={(event) => onStyleChange(selectedTextItem, { textAlign: event.target.value })}
              >
                <option value="left">左</option>
                <option value="center">中央</option>
                <option value="right">右</option>
              </select>
            </label>
          </section>
        )}

        {selectedItem?.sticker && (
          <section className="sidebar-section">
            <div className="sidebar-title">オブジェクト調整</div>
            {selectedItem.type === "draw" && (
              <>
                <button className="tool-button image-tool" type="button" onClick={() => onImageAction("edit-draw", selectedItem)}>
                  <span>✎</span>
                  <small>Draw編集</small>
                </button>
                <button className="tool-button image-tool" type="button" onClick={() => onImageAction("crop", selectedItem)}>
                  <span>✂</span>
                  <small>クリップ</small>
                </button>
              </>
            )}
            {selectedItem.type !== "draw" && (
              <>
                <label className="field">
                  <span>色</span>
                  <input
                    type="color"
                    value={selectedItem.strokeColor || "#ffffff"}
                    onChange={(event) => onStyleChange(selectedItem, { strokeColor: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>太さ: {selectedItem.strokeWidth || 4}px</span>
                  <input
                    type="range"
                    min="1"
                    max="16"
                    value={selectedItem.strokeWidth || 4}
                    onChange={(event) => onStyleChange(selectedItem, { strokeWidth: Number(event.target.value) })}
                  />
                </label>
              </>
            )}
            <label className="field">
              <span>角度: {Math.round(selectedItem.angleDeg || 0)}°</span>
              <input
                type="range"
                min="-180"
                max="180"
                value={selectedItem.angleDeg || 0}
                onChange={(event) => onStyleChange(selectedItem, { angleDeg: Number(event.target.value) })}
              />
            </label>
          </section>
        )}

      </div>
    </aside>
  );
}

function Breadcrumbs({ path, onHome, onMove }) {
  return (
    <nav className="crumbs" aria-label="パンくず">
      <button className="crumb" type="button" onClick={onHome}>
        ホーム
      </button>
      {path.map((board, index) => (
        <span className="crumb-group" key={board.id}>
          <span> / </span>
          <button
            className="crumb"
            type="button"
            aria-current={index === path.length - 1 ? "page" : undefined}
            onClick={() => index !== path.length - 1 && onMove(board.id)}
          >
            {board.title}
          </button>
        </span>
      ))}
    </nav>
  );
}

function BoardCard({ board, thumbnail, count, onOpen, onContextMenu }) {
  return (
    <article
      className="card board-card"
      data-board-drop-id={board.id}
      onClick={onOpen}
      onContextMenu={onContextMenu}
    >
      {thumbnail && (
        <div className="board-thumb">
          <img src={thumbnail} alt="" />
        </div>
      )}
      <div className="card-body">
        <h2
          className="card-title board-title"
          style={{
            color: board.fontColor || undefined,
            fontWeight: board.fontWeight || undefined,
          }}
        >
          {board.title}
        </h2>
        <p className="card-content">{count} 件のカード</p>
      </div>
    </article>
  );
}

function EditableText({ value, className, multiline = false, placeholder = "", displayAs = "div", style, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");

  useEffect(() => {
    if (!editing) setDraft(value || "");
  }, [value, editing]);

  if (!editing) {
    const text = value || placeholder;
    const Tag = displayAs;
    return (
      <Tag
        className={className}
        style={style}
        onDoubleClick={(event) => {
          event.stopPropagation();
          setDraft(value || "");
          setEditing(true);
        }}
      >
        {text}
      </Tag>
    );
  }

  const save = () => {
    onSave(draft);
    setEditing(false);
  };

  return multiline ? (
    <textarea
      className={`${className} inline-editor`}
      style={style}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={save}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setDraft(value || "");
          setEditing(false);
        }
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          save();
        }
      }}
      autoFocus
    />
  ) : (
    <input
      className={`${className} inline-editor`}
      style={style}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={save}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          save();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setDraft(value || "");
          setEditing(false);
        }
      }}
      autoFocus
    />
  );
}

function ItemCard({
  item,
  board,
  thumbnail,
  isCaptionVisible,
  onOpenBoard,
  onEditBoard,
  onBoardContextMenu,
  onEdit,
  onDelete,
  onTodoAdd,
  onTodoToggle,
  onTodoEdit,
  onPatchItem,
  onResize,
  onToggleCaption,
  onOpenLightbox,
  onItemContextMenu,
  onTextDoubleClick,
}) {
  const itemTextStyle = {
    color: item.textColor || undefined,
    fontWeight: item.fontWeight || undefined,
    fontStyle: item.fontStyle || undefined,
    textDecoration: item.textDecoration || undefined,
    textAlign: item.textAlign || undefined,
  };

  if (item.type === "board") {
    return (
      <article
        className="card board-card"
        data-board-drop-id={board?.id || ""}
        onDoubleClick={() => board && onOpenBoard(board.id)}
        onContextMenu={(event) => board && onBoardContextMenu(event, board)}
      >
        {thumbnail && (
          <div className="board-thumb">
            <img src={thumbnail} alt="" />
          </div>
        )}
        <div className="card-body">
          <h2
            className="card-title board-title"
            style={{
              color: board?.fontColor || undefined,
              fontWeight: board?.fontWeight || undefined,
            }}
          >
            {board?.title || item.title}
          </h2>
          <p className="card-content">サブボード</p>
        </div>
        <ResizeHandle item={item} onResize={onResize} />
      </article>
    );
  }

  if (item.type === "image" && item.imagePath) {
    return (
      <article
        className={isCaptionVisible ? "card media-card caption-visible" : "card media-card"}
        onClick={() => onToggleCaption(isCaptionVisible ? null : item.id)}
        onDoubleClick={() => onOpenLightbox(item.id)}
        onContextMenu={(event) => onItemContextMenu(event, item)}
        onDragStart={(event) => event.preventDefault()}
      >
        <div className="media-frame">
          <img src={item.imagePath} alt={item.title || "画像カード"} draggable="false" />
          <div className="media-caption">
            {item.label && <div className="chip">{item.label}</div>}
            <EditableText
              value={item.title}
              className="caption-title"
              placeholder="Untitled"
              displayAs="div"
              style={itemTextStyle}
              onSave={(nextTitle) => onPatchItem(item.id, { title: nextTitle })}
            />
            <EditableText
              value={item.content}
              className="caption-content"
              placeholder="メモを入力"
              multiline
              displayAs="div"
              style={itemTextStyle}
              onSave={(nextContent) => onPatchItem(item.id, { content: nextContent })}
            />
          </div>
        </div>
        <ResizeHandle item={item} onResize={onResize} />
      </article>
    );
  }

  if (item.type === "video" && item.imagePath) {
    return (
      <article
        className={isCaptionVisible ? "card media-card caption-visible" : "card media-card"}
        onClick={() => onToggleCaption(isCaptionVisible ? null : item.id)}
        onDoubleClick={() => onOpenLightbox(item.id)}
        onContextMenu={(event) => onItemContextMenu(event, item)}
        onDragStart={(event) => event.preventDefault()}
      >
        <div className="media-frame">
          <video src={item.imagePath} controls muted preload="metadata" draggable="false" />
          <div className="media-caption">
            {item.label && <div className="chip">{item.label}</div>}
            <EditableText
              value={item.title}
              className="caption-title"
              placeholder="Untitled"
              displayAs="div"
              style={itemTextStyle}
              onSave={(nextTitle) => onPatchItem(item.id, { title: nextTitle })}
            />
            <EditableText
              value={item.content}
              className="caption-content"
              placeholder="メモを入力"
              multiline
              displayAs="div"
              style={itemTextStyle}
              onSave={(nextContent) => onPatchItem(item.id, { content: nextContent })}
            />
          </div>
        </div>
        <ResizeHandle item={item} onResize={onResize} />
      </article>
    );
  }

  if (item.type === "draw" && item.imagePath) {
    return (
      <article
        className="card sticker-card"
        onContextMenu={(event) => onItemContextMenu(event, item)}
        onDoubleClick={() => onTextDoubleClick(item)}
      >
        <img
          className="sticker-image"
          src={item.imagePath}
          alt={item.title || "Draw sticker"}
          draggable="false"
          style={{ transform: `rotate(${item.angleDeg || 0}deg)` }}
        />
        <ResizeHandle item={item} onResize={onResize} />
      </article>
    );
  }

  if (item.type === "shape-line") {
    return (
      <article className="card sticker-card" onContextMenu={(event) => onItemContextMenu(event, item)}>
        <div
          className="sticker-line"
          style={{
            "--line-angle": `${item.angleDeg || 0}deg`,
            "--stroke-color": item.strokeColor || "#ffffff",
            "--stroke-width": `${item.strokeWidth || 4}px`,
          }}
        />
        <ResizeHandle item={item} onResize={onResize} />
      </article>
    );
  }

  if (item.type === "shape-rect") {
    return (
      <article
        className="card sticker-card sticker-rect"
        style={{
          "--stroke-color": item.strokeColor || "#ffffff",
          "--stroke-width": `${item.strokeWidth || 4}px`,
          transform: `rotate(${item.angleDeg || 0}deg)`,
        }}
        onContextMenu={(event) => onItemContextMenu(event, item)}
      >
        <ResizeHandle item={item} onResize={onResize} />
      </article>
    );
  }

  if (item.type === "shape-circle") {
    return (
      <article
        className="card sticker-card sticker-circle"
        style={{
          "--stroke-color": item.strokeColor || "#ffffff",
          "--stroke-width": `${item.strokeWidth || 4}px`,
          transform: `rotate(${item.angleDeg || 0}deg)`,
        }}
        onContextMenu={(event) => onItemContextMenu(event, item)}
      >
        <ResizeHandle item={item} onResize={onResize} />
      </article>
    );
  }

  if (item.type === "todo") {
    const lines = (item.content || "・やること").split(/\r?\n/).filter(Boolean);
    return (
      <article
        className="card todo-card"
        onContextMenu={(event) => onItemContextMenu(event, item)}
        onDoubleClick={() => onTextDoubleClick(item)}
      >
        <div className="card-body">
          <div className="todo-head">
            <EditableText
              value={item.title}
              className="card-title"
              placeholder="リスト"
              displayAs="h2"
              style={itemTextStyle}
              onSave={(nextTitle) => onPatchItem(item.id, { title: nextTitle })}
            />
            <button
              className="todo-add"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onTodoAdd(item.id);
              }}
            >
              ＋
            </button>
          </div>
          <div className="todo-list">
            {lines.map((line, index) => (
              <label className="todo-row" key={`${item.id}-${index}`}>
                <input
                  type="checkbox"
                  checked={line.trim().startsWith("[x]")}
                  onChange={() => onTodoToggle(item.id, index)}
                />
                <EditableText
                  value={line.replace(/^\[( |x)\]\s*/i, "").replace(/^・\s*/, "")}
                  className="todo-line-text"
                  placeholder="項目"
                  displayAs="span"
                  style={itemTextStyle}
                  onSave={(nextLine) => onTodoEdit(item.id, index, nextLine)}
                />
              </label>
            ))}
          </div>
        </div>
      </article>
    );
  }

  if (item.type === "comment") {
    return (
      <article
        className="card comment-card"
        onContextMenu={(event) => onItemContextMenu(event, item)}
        onDoubleClick={() => onTextDoubleClick(item)}
      >
        <div className="card-body">
          <div className="card-kicker">Comment</div>
          <EditableText
            value={item.content}
            className="card-content"
            placeholder="コメントを書く"
            multiline
            displayAs="p"
            style={itemTextStyle}
            onSave={(nextContent) => onPatchItem(item.id, { content: nextContent })}
          />
        </div>
      </article>
    );
  }

  if (item.type === "column") {
    const [headline, ...bodyLines] = (item.content || "").split(/\r?\n/);
    return (
      <article
        className="card column-card"
        onContextMenu={(event) => onItemContextMenu(event, item)}
        onDoubleClick={() => onTextDoubleClick(item)}
      >
        <div className="card-body">
          <div className="card-kicker">Column</div>
          <EditableText
            value={item.title}
            className="card-title"
            placeholder="Column"
            displayAs="h2"
            style={itemTextStyle}
            onSave={(nextTitle) => onPatchItem(item.id, { title: nextTitle })}
          />
          <EditableText
            value={headline || ""}
            className="column-headline"
            placeholder="見出し"
            displayAs="p"
            style={itemTextStyle}
            onSave={(nextHeadline) => onPatchItem(item.id, { content: [nextHeadline, ...bodyLines].join("\n").trim() })}
          />
          <EditableText
            value={bodyLines.join("\n")}
            className="card-content"
            multiline
            placeholder="本文"
            displayAs="p"
            style={itemTextStyle}
            onSave={(nextBody) => onPatchItem(item.id, { content: [headline || "", ...nextBody.split(/\r?\n/)].join("\n").trim() })}
          />
        </div>
      </article>
    );
  }

  if (item.type === "table") {
    const rows = parseTableRows(item.content);
    const columnCount = Math.max(2, ...rows.map((row) => row.length));
    return (
      <article
        className="card table-card"
        onContextMenu={(event) => onItemContextMenu(event, item)}
        onDoubleClick={() => onTextDoubleClick(item)}
      >
        <div className="card-body">
          <div className="card-kicker">Table</div>
          <EditableText
            value={item.title}
            className="card-title"
            placeholder="Table"
            displayAs="h2"
            style={itemTextStyle}
            onSave={(nextTitle) => onPatchItem(item.id, { title: nextTitle })}
          />
          <div className="table-tools">
            <button
              className="ghost"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onPatchItem(item.id, { content: appendTableRowContent(item.content || "") });
              }}
            >
              行を追加
            </button>
            <button
              className="ghost"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onPatchItem(item.id, { content: appendTableColumnContent(item.content || "") });
              }}
            >
              列を追加
            </button>
          </div>
          <div className="table-grid" style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}>
            {rows.map((row, rowIndex) =>
              row.map((cell, cellIndex) => (
                <div className="table-cell" key={`${rowIndex}-${cellIndex}`}>
                  <EditableText
                    value={cell}
                    className={rowIndex === 0 ? "table-cell-text table-cell-text-head" : "table-cell-text"}
                    placeholder={rowIndex === 0 ? `列${cellIndex + 1}` : "値"}
                    displayAs="span"
                    style={itemTextStyle}
                    onSave={(nextCell) =>
                      onPatchItem(item.id, {
                        content: updateTableCellContent(item.content || "", rowIndex, cellIndex, nextCell),
                      })
                    }
                  />
                </div>
              )),
            )}
          </div>
        </div>
      </article>
    );
  }

  return (
    <article
      className="card"
      onContextMenu={(event) => onItemContextMenu(event, item)}
      onDoubleClick={() => onTextDoubleClick(item)}
    >
      <div className="card-body">
        <div className="card-kicker">{itemLabels[item.type]}</div>
        <EditableText
          value={item.title}
          className="card-title"
          placeholder={itemLabels[item.type]}
          displayAs="h2"
          style={itemTextStyle}
          onSave={(nextTitle) => onPatchItem(item.id, { title: nextTitle })}
        />
        {item.label && <span className="chip inline-chip">{item.label}</span>}
        <EditableText
          value={item.content}
          className="card-content"
          placeholder=""
          multiline
          displayAs="p"
          style={itemTextStyle}
          onSave={(nextContent) => onPatchItem(item.id, { content: nextContent })}
        />
        {item.type === "link" && item.url && (
          <a className="card-link" href={item.url} target="_blank" rel="noreferrer">
            {item.url}
          </a>
        )}
      </div>
    </article>
  );
}

function ResizeHandle({ item, onResize }) {
  function handlePointerDown(event) {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const startSpan = item.widthUnits || 3;
    const startRows = item.heightUnits || 4;

    function handlePointerMove(moveEvent) {
      const delta = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      const stepsX = Math.round(delta / 38);
      const stepsY = Math.round(deltaY / 34);
      onResize(item.id, startSpan + stepsX, startRows + stepsY);
    }

    function handlePointerUp() {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  }

  return (
    <button
      className="resize-handle"
      type="button"
      onPointerDown={handlePointerDown}
      title="サイズを調整"
      aria-label="サイズを調整"
    />
  );
}

function CardActions({ onEdit, onDelete }) {
  return (
    <div className="card-actions" onClick={(event) => event.stopPropagation()}>
      <button className="ghost" type="button" onClick={onEdit}>
        編集
      </button>
      <button className="ghost danger" type="button" onClick={onDelete}>
        削除
      </button>
    </div>
  );
}

function BoardDialog({ board, onClose, onSave }) {
  const [title, setTitle] = useState(board?.title || "");
  const [fontColor, setFontColor] = useState(board?.fontColor || "#232323");
  const [fontWeight, setFontWeight] = useState(board?.fontWeight || "700");
  const [thumbnailImage, setThumbnailImage] = useState(board?.thumbnailImage || "");

  async function handleThumbnailChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setThumbnailImage(await readImageFile(file));
  }

  return (
    <Dialog onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!title.trim()) return;
          onSave({
            title: title.trim(),
            fontColor,
            fontWeight,
            thumbnailImage,
          });
        }}
      >
        <h2>{board ? "ボードを編集" : "ボードを作成"}</h2>
        <label className="field">
          <span>タイトル</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} required autoFocus />
        </label>
        <label className="field">
          <span>タイトル色</span>
          <input value={fontColor} onChange={(event) => setFontColor(event.target.value)} type="color" />
        </label>
        <label className="field">
          <span>タイトルの太さ</span>
          <select value={fontWeight} onChange={(event) => setFontWeight(event.target.value)}>
            <option value="500">標準</option>
            <option value="700">太字</option>
            <option value="900">極太</option>
          </select>
        </label>
        <label className="field">
          <span>サムネイル画像</span>
          <input type="file" accept="image/*" onChange={handleThumbnailChange} />
        </label>
        {thumbnailImage && (
          <div className="thumb-preview">
            <img src={thumbnailImage} alt="" />
            <button className="ghost" type="button" onClick={() => setThumbnailImage("")}>
              サムネイルを削除
            </button>
          </div>
        )}
        <DialogActions onClose={onClose} />
      </form>
    </Dialog>
  );
}

function ItemDialog({ item, type, onClose, onSave }) {
  const [title, setTitle] = useState(item?.title || "");
  const [content, setContent] = useState(item?.content || "");
  const [label, setLabel] = useState(item?.label || "");
  const [url, setUrl] = useState(item?.url || "");
  const [imageFile, setImageFile] = useState(null);

  return (
    <Dialog onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim()) return;
          onSave({
            title: title.trim(),
            content: content.trim(),
            label: label.trim(),
            url: url.trim(),
            imageFile,
          });
        }}
      >
        <h2>{item ? `${itemLabels[type]}を編集` : `${itemLabels[type]}を作成`}</h2>
        <label className="field">
          <span>タイトル</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} required autoFocus />
        </label>
        <label className="field">
          <span>{type === "image" ? "メモ" : "本文"}</span>
          <textarea value={content} onChange={(event) => setContent(event.target.value)} />
        </label>
        <label className="field">
          <span>ラベル</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="例: お気に入り / 資料 / キャラ" />
        </label>
        {type === "link" && (
          <label className="field">
            <span>URL</span>
            <input value={url} onChange={(event) => setUrl(event.target.value)} type="url" required />
          </label>
        )}
        {(type === "image" || type === "video") && (
          <label className="field">
            <span>{type === "video" ? "動画" : "画像"}</span>
            <input
              type="file"
              accept={type === "video" ? "video/*" : "image/*"}
              required={!item?.imagePath}
              onChange={(event) => setImageFile(event.target.files?.[0] || null)}
            />
          </label>
        )}
        <DialogActions onClose={onClose} />
      </form>
    </Dialog>
  );
}

function Dialog({ children, onClose }) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </section>
    </div>
  );
}

function DialogActions({ onClose }) {
  return (
    <div className="dialog-actions">
      <button className="secondary" type="button" onClick={onClose}>
        キャンセル
      </button>
      <button className="primary" type="submit">
        保存
      </button>
    </div>
  );
}

function BoardContextMenu({ x, y, onEdit, onDelete }) {
  return (
    <div className="context-menu" style={{ left: x, top: y }} onClick={(event) => event.stopPropagation()}>
      <button type="button" onClick={onEdit}>
        ボードを編集
      </button>
      <button className="danger" type="button" onClick={onDelete}>
        ボードを削除
      </button>
    </div>
  );
}

function ItemContextMenu({
  x,
  y,
  item,
  onEdit,
  onDuplicate,
  onDownload,
  onOpenAsset,
  onReplace,
  onDrawEdit,
  onCrop,
  onAnnotate,
  onDelete,
}) {
  return (
    <div className="context-menu" style={{ left: x, top: y }} onClick={(event) => event.stopPropagation()}>
      {(item.type === "image" || item.type === "video") && (
        <>
          <button type="button" onClick={onOpenAsset}>
            画像を開く
          </button>
          <button type="button" onClick={onDownload}>
            画像をダウンロード
          </button>
          <button type="button" onClick={onEdit}>
            画像を置換 / 編集
          </button>
          <button type="button" onClick={onReplace}>
            ファイルを置換
          </button>
          {item.type === "image" && (
            <>
              <button type="button" onClick={onCrop}>
                画像をクリップ
              </button>
              <button type="button" onClick={onAnnotate}>
                画像に書き込み
              </button>
            </>
          )}
        </>
      )}
      {item.type === "draw" && (
        <>
          <button type="button" onClick={onDrawEdit}>
            Draw を編集
          </button>
          <button type="button" onClick={onCrop}>
            Draw をクリップ
          </button>
        </>
      )}
      {item.type !== "image" && item.type !== "video" && (
        <button type="button" onClick={onEdit}>
          カードを編集
        </button>
      )}
      <button type="button" onClick={onDuplicate}>
        複製
      </button>
      <button className="danger" type="button" onClick={onDelete}>
        カードを削除
      </button>
    </div>
  );
}

function SettingsDialog({ settings, theme, onClose, onSave }) {
  const [draft, setDraft] = useState(settings);
  const [draftTheme, setDraftTheme] = useState(theme);

  async function handleImageSettingChange(key, event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const image = await optimizeSettingsImageFile(file);
      if (!image) throw new Error("invalid image");
      setDraft((current) => ({ ...current, [key]: image }));
    } catch (error) {
      console.error("Failed to apply settings background image", error);
      alert("背景画像の読み込みに失敗しました。別の画像でお試しください。");
    } finally {
      event.target.value = "";
    }
  }

  return (
    <Dialog onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave(draft, draftTheme);
        }}
      >
        <h2>設定</h2>
        <label className="field">
          <span>表示モード</span>
          <select value={draftTheme} onChange={(event) => setDraftTheme(event.target.value)}>
            <option value="light">ライト</option>
            <option value="dark">ダーク</option>
          </select>
        </label>
        <label className="field">
          <span>初期フォントサイズ: {draft.fontSize}px</span>
          <input
            type="range"
            min="13"
            max="19"
            value={draft.fontSize}
            onChange={(event) => setDraft({ ...draft, fontSize: Number(event.target.value) })}
          />
        </label>
        <label className="field">
          <span>ソート</span>
          <select value={draft.sortMode} onChange={(event) => setDraft({ ...draft, sortMode: event.target.value })}>
            <option value="manual">手動順</option>
            <option value="newest">追加順 新しい順</option>
            <option value="oldest">追加順 古い順</option>
            <option value="title">50音順</option>
          </select>
        </label>
        <label className="field">
          <span>ボード初期ズーム: {Math.round((draft.boardZoom || 1) * 100)}%</span>
          <input
            type="range"
            min={BOARD_ZOOM_MIN}
            max="1.5"
            step="0.01"
            value={draft.boardZoom || 1}
            onChange={(event) => setDraft({ ...draft, boardZoom: Number(event.target.value) })}
          />
        </label>
        <section className="settings-group">
          <h3>全体背景</h3>
          <label className="field">
            <span>モード</span>
            <select
              value={draft.appBackgroundMode}
              onChange={(event) => setDraft({ ...draft, appBackgroundMode: event.target.value })}
            >
              <option value="theme">テーマ標準</option>
              <option value="solid">単色</option>
              <option value="image">画像</option>
            </select>
          </label>
          {draft.appBackgroundMode === "solid" && (
            <label className="field">
              <span>背景色</span>
              <input
                type="color"
                value={draft.appBackgroundColor || (draftTheme === "dark" ? "#111315" : "#f6f7f8")}
                onChange={(event) => setDraft({ ...draft, appBackgroundColor: event.target.value })}
              />
            </label>
          )}
          {draft.appBackgroundMode === "image" && (
            <label className="field">
              <span>背景画像</span>
              <input type="file" accept="image/*" onChange={(event) => handleImageSettingChange("appBackgroundImage", event)} />
            </label>
          )}
        </section>
        <section className="settings-group">
          <h3>上部バー背景</h3>
          <label className="field">
            <span>モード</span>
            <select
              value={draft.topbarBackgroundMode}
              onChange={(event) => setDraft({ ...draft, topbarBackgroundMode: event.target.value })}
            >
              <option value="theme">テーマ標準</option>
              <option value="solid">単色</option>
              <option value="image">画像</option>
            </select>
          </label>
          {draft.topbarBackgroundMode === "solid" && (
            <label className="field">
              <span>バー背景色</span>
              <input
                type="color"
                value={draft.topbarBackgroundColor || (draftTheme === "dark" ? "#1b1e21" : "#ffffff")}
                onChange={(event) => setDraft({ ...draft, topbarBackgroundColor: event.target.value })}
              />
            </label>
          )}
          {draft.topbarBackgroundMode === "image" && (
            <label className="field">
              <span>バー背景画像</span>
              <input type="file" accept="image/*" onChange={(event) => handleImageSettingChange("topbarBackgroundImage", event)} />
            </label>
          )}
        </section>
        <DialogActions onClose={onClose} />
      </form>
    </Dialog>
  );
}

function DrawDialog({ initialImage = "", title = "Draw Sticker", onClose, onSave }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const [brushColor, setBrushColor] = useState("#ffffff");
  const [brushSize, setBrushSize] = useState(6);
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!context) return;
    context.fillStyle = "rgba(0,0,0,0)";
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.lineWidth = 6;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#ffffff";
    if (!initialImage) return;
    const image = new Image();
    image.onload = () => {
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const snapshot = canvas.toDataURL("image/png");
      setHistory([snapshot]);
      setHistoryIndex(0);
    };
    image.src = initialImage;
    if (!initialImage) {
      const snapshot = canvas.toDataURL("image/png");
      setHistory([snapshot]);
      setHistoryIndex(0);
    }
  }, [initialImage]);

  function clearCanvas() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const snapshot = canvas.toDataURL("image/png");
    setHistory((previous) => [...previous.slice(0, historyIndex + 1), snapshot]);
    setHistoryIndex((index) => index + 1);
  }

  function restoreHistory(targetIndex) {
    if (targetIndex < 0 || targetIndex >= history.length) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!context) return;
    const image = new Image();
    image.onload = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      setHistoryIndex(targetIndex);
    };
    image.src = history[targetIndex];
  }

  function saveSnapshot() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const snapshot = canvas.toDataURL("image/png");
    setHistory((previous) => {
      const next = [...previous.slice(0, historyIndex + 1), snapshot];
      setHistoryIndex(next.length - 1);
      return next;
    });
  }

  function getPoint(event) {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvasRef.current.width,
      y: ((event.clientY - rect.top) / rect.height) * canvasRef.current.height,
    };
  }

  function startDraw(event) {
    const context = canvasRef.current.getContext("2d");
    const point = getPoint(event);
    drawingRef.current = true;
    context.beginPath();
    context.moveTo(point.x, point.y);
    context.strokeStyle = brushColor;
    context.lineWidth = brushSize;
  }

  function moveDraw(event) {
    if (!drawingRef.current) return;
    const context = canvasRef.current.getContext("2d");
    const point = getPoint(event);
    context.lineTo(point.x, point.y);
    context.stroke();
  }

  function endDraw() {
    if (drawingRef.current) {
      saveSnapshot();
    }
    drawingRef.current = false;
  }

  return (
    <Dialog onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const imagePath = canvasRef.current.toDataURL("image/png");
          const dimensions = getAspectBasedCardSize(canvasRef.current.width, canvasRef.current.height, "image");
          onSave({ imagePath, widthUnits: dimensions.widthUnits, heightUnits: dimensions.heightUnits });
        }}
      >
        <h2>{title}</h2>
        <div className="draw-toolbar">
          <label className="field draw-field">
            <span>色</span>
            <input type="color" value={brushColor} onChange={(event) => setBrushColor(event.target.value)} />
          </label>
          <label className="field draw-field">
            <span>太さ: {brushSize}px</span>
            <input
              type="range"
              min="1"
              max="30"
              value={brushSize}
              onChange={(event) => setBrushSize(Number(event.target.value))}
            />
          </label>
          <button
            className="secondary"
            type="button"
            onClick={() => restoreHistory(historyIndex - 1)}
            disabled={historyIndex <= 0}
          >
            Undo
          </button>
          <button
            className="secondary"
            type="button"
            onClick={() => restoreHistory(historyIndex + 1)}
            disabled={historyIndex >= history.length - 1}
          >
            Redo
          </button>
        </div>
        <canvas
          ref={canvasRef}
          className="draw-canvas"
          width="720"
          height="420"
          onPointerDown={startDraw}
          onPointerMove={moveDraw}
          onPointerUp={endDraw}
          onPointerLeave={endDraw}
        />
        <div className="dialog-actions draw-actions">
          <button className="secondary" type="button" onClick={clearCanvas}>
            クリア
          </button>
        </div>
        <DialogActions onClose={onClose} />
      </form>
    </Dialog>
  );
}

function ImageEditDialog({ item, mode, onClose, onSave }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const drawingRef = useRef(false);
  const cropDraftRef = useRef(null);
  const textTransformRef = useRef(null);
  const [brushColor, setBrushColor] = useState("#ffef7f");
  const [brushSize, setBrushSize] = useState(5);
  const [annotateTool, setAnnotateTool] = useState("draw");
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [imageRect, setImageRect] = useState(null);
  const [cropRect, setCropRect] = useState(null);
  const [textAnnotations, setTextAnnotations] = useState([]);
  const [activeTextId, setActiveTextId] = useState(null);
  const [wrapSize, setWrapSize] = useState({ width: 900, height: 520 });
  const activeText = textAnnotations.find((annotation) => annotation.id === activeTextId) || null;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !item?.imagePath) return;
    const image = new Image();
    image.onload = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      const scale = Math.min(canvas.width / image.width, canvas.height / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      const x = (canvas.width - width) / 2;
      const y = (canvas.height - height) / 2;
      context.drawImage(image, x, y, width, height);
      setImageRect({ x, y, width, height, naturalWidth: image.width, naturalHeight: image.height });
      setCropRect(null);
      const snapshot = canvas.toDataURL("image/png");
      setHistory([snapshot]);
      setHistoryIndex(0);
    };
    image.src = item.imagePath;
    setTextAnnotations([]);
    setActiveTextId(null);
  }, [item?.id, item?.imagePath, mode]);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setWrapSize({ width: rect.width || 900, height: rect.height || 520 });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function saveSnapshot() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const snapshot = canvas.toDataURL("image/png");
    setHistory((previous) => {
      const next = [...previous.slice(0, historyIndex + 1), snapshot];
      setHistoryIndex(next.length - 1);
      return next;
    });
  }

  function restoreHistory(targetIndex) {
    if (targetIndex < 0 || targetIndex >= history.length) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!context) return;
    const image = new Image();
    image.onload = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      setHistoryIndex(targetIndex);
    };
    image.src = history[targetIndex];
  }

  function updateAnnotation(annotationId, patch) {
    setTextAnnotations((previous) =>
      previous.map((annotation) => (annotation.id === annotationId ? { ...annotation, ...patch } : annotation)),
    );
  }

  function addTextAnnotationAtPoint(point, initialText = "Text") {
    const annotationId = createId("annotext");
    setTextAnnotations((previous) => [
      ...previous,
      {
        id: annotationId,
        text: initialText,
        x: clamp(Math.round(point.x), 0, 900),
        y: clamp(Math.round(point.y), 0, 520),
        fontSize: Math.max(14, brushSize * 4),
        color: brushColor,
        angleDeg: 0,
      },
    ]);
    setActiveTextId(annotationId);
  }

  function removeActiveTextAnnotation() {
    if (!activeTextId) return;
    setTextAnnotations((previous) => previous.filter((annotation) => annotation.id !== activeTextId));
    setActiveTextId(null);
  }

  function duplicateActiveTextAnnotation() {
    if (!activeText) return;
    const duplicateId = createId("annotext");
    setTextAnnotations((previous) => [
      ...previous,
      {
        ...activeText,
        id: duplicateId,
        x: clamp((activeText.x || 0) + 18, 0, 900),
        y: clamp((activeText.y || 0) + 18, 0, 520),
      },
    ]);
    setActiveTextId(duplicateId);
  }

  function getPoint(event) {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvasRef.current.width,
      y: ((event.clientY - rect.top) / rect.height) * canvasRef.current.height,
    };
  }

  function beginTextTransform(event, annotation, mode = "move") {
    event.preventDefault();
    event.stopPropagation();
    setActiveTextId(annotation.id);
    textTransformRef.current = {
      mode,
      annotationId: annotation.id,
      startX: event.clientX,
      startY: event.clientY,
      originX: annotation.x,
      originY: annotation.y,
      originSize: annotation.fontSize,
    };

    function handlePointerMove(moveEvent) {
      const wrapRect = wrapRef.current?.getBoundingClientRect();
      if (!wrapRect || !textTransformRef.current) return;
      const scaleX = 900 / Math.max(wrapRect.width, 1);
      const scaleY = 520 / Math.max(wrapRect.height, 1);
      const deltaX = (moveEvent.clientX - textTransformRef.current.startX) * scaleX;
      const deltaY = (moveEvent.clientY - textTransformRef.current.startY) * scaleY;
      if (textTransformRef.current.mode === "resize") {
        const nextSize = clamp(Math.round(textTransformRef.current.originSize + deltaY * 0.5 + deltaX * 0.15), 10, 220);
        updateAnnotation(textTransformRef.current.annotationId, { fontSize: nextSize });
      } else {
        updateAnnotation(textTransformRef.current.annotationId, {
          x: clamp(Math.round(textTransformRef.current.originX + deltaX), 0, 900),
          y: clamp(Math.round(textTransformRef.current.originY + deltaY), 0, 520),
        });
      }
    }

    function handlePointerUp() {
      textTransformRef.current = null;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  }

  function startPointer(event) {
    if (!imageRect) return;
    const point = getPoint(event);
    if (mode === "annotate") {
      if (annotateTool === "text") {
        return;
      }
      const context = canvasRef.current.getContext("2d");
      drawingRef.current = true;
      context.beginPath();
      context.moveTo(point.x, point.y);
      context.lineWidth = brushSize;
      context.lineCap = "round";
      context.strokeStyle = brushColor;
      return;
    }
    cropDraftRef.current = point;
    setCropRect({ x: point.x, y: point.y, width: 0, height: 0 });
  }

  function movePointer(event) {
    if (mode === "annotate") {
      if (!drawingRef.current) return;
      const context = canvasRef.current.getContext("2d");
      const point = getPoint(event);
      context.lineTo(point.x, point.y);
      context.stroke();
      return;
    }
    if (!cropDraftRef.current) return;
    const point = getPoint(event);
    setCropRect({
      x: Math.min(cropDraftRef.current.x, point.x),
      y: Math.min(cropDraftRef.current.y, point.y),
      width: Math.abs(point.x - cropDraftRef.current.x),
      height: Math.abs(point.y - cropDraftRef.current.y),
    });
  }

  function endPointer() {
    if (drawingRef.current) saveSnapshot();
    drawingRef.current = false;
    cropDraftRef.current = null;
  }

  function handleAnnotationWrapDoubleClick(event) {
    if (mode !== "annotate" || annotateTool !== "text") return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest(".annotation-text")) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const point = {
      x: ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 900,
      y: ((event.clientY - rect.top) / Math.max(rect.height, 1)) * 520,
    };
    addTextAnnotationAtPoint(point, "");
  }

  function handleSave(event) {
    event.preventDefault();
    if (mode === "annotate") {
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;
      for (const annotation of textAnnotations) {
        if (!annotation.text?.trim()) continue;
        context.fillStyle = annotation.color || brushColor;
        context.font = `${annotation.fontSize || 18}px "Segoe UI", sans-serif`;
        context.textBaseline = "top";
        context.save();
        context.translate(annotation.x || 0, annotation.y || 0);
        context.rotate((((annotation.angleDeg || 0) * Math.PI) / 180) || 0);
        context.fillText(annotation.text, 0, 0);
        context.restore();
      }
      onSave(canvas.toDataURL("image/png"));
      return;
    }
    if (!cropRect || !imageRect || cropRect.width < 4 || cropRect.height < 4) return;
    const cropX = clamp(cropRect.x, imageRect.x, imageRect.x + imageRect.width);
    const cropY = clamp(cropRect.y, imageRect.y, imageRect.y + imageRect.height);
    const cropWidth = clamp(cropRect.width, 4, imageRect.x + imageRect.width - cropX);
    const cropHeight = clamp(cropRect.height, 4, imageRect.y + imageRect.height - cropY);
    const sx = ((cropX - imageRect.x) / imageRect.width) * imageRect.naturalWidth;
    const sy = ((cropY - imageRect.y) / imageRect.height) * imageRect.naturalHeight;
    const sw = (cropWidth / imageRect.width) * imageRect.naturalWidth;
    const sh = (cropHeight / imageRect.height) * imageRect.naturalHeight;
    const image = new Image();
    image.onload = () => {
      const offscreen = document.createElement("canvas");
      offscreen.width = Math.max(8, Math.round(sw));
      offscreen.height = Math.max(8, Math.round(sh));
      const context = offscreen.getContext("2d");
      context.drawImage(image, sx, sy, sw, sh, 0, 0, offscreen.width, offscreen.height);
      onSave(offscreen.toDataURL("image/png"));
    };
    image.src = item.imagePath;
  }

  useEffect(() => {
    function handleKeyDown(event) {
      const target = event.target;
      const editingInput = target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if ((event.key === "Delete" || event.key === "Backspace") && activeTextId && !editingInput) {
        event.preventDefault();
        removeActiveTextAnnotation();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d" && activeTextId) {
        event.preventDefault();
        duplicateActiveTextAnnotation();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTextId, activeText]);

  return (
    <Dialog onClose={onClose}>
      <form onSubmit={handleSave}>
        <h2>{mode === "crop" ? "画像をクリップ" : "画像に書き込み"}</h2>
        {mode === "annotate" && (
          <div className="draw-toolbar">
            <label className="field draw-field">
              <span>色</span>
              <input
                type="color"
                value={
                  annotateTool === "text" && activeTextId
                    ? textAnnotations.find((annotation) => annotation.id === activeTextId)?.color || brushColor
                    : brushColor
                }
                onChange={(event) => {
                  const nextColor = event.target.value;
                  setBrushColor(nextColor);
                  if (annotateTool === "text" && activeTextId) {
                    updateAnnotation(activeTextId, { color: nextColor });
                  }
                }}
              />
            </label>
            <label className="field draw-field">
              <span>{annotateTool === "draw" ? `太さ: ${brushSize}px` : "テキストサイズ"}</span>
              <input
                type="range"
                min={annotateTool === "draw" ? "1" : "10"}
                max={annotateTool === "draw" ? "30" : "220"}
                value={
                  annotateTool === "draw"
                    ? brushSize
                    : textAnnotations.find((annotation) => annotation.id === activeTextId)?.fontSize || 24
                }
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (annotateTool === "draw") {
                    setBrushSize(next);
                  } else if (activeTextId) {
                    updateAnnotation(activeTextId, { fontSize: next });
                  }
                }}
              />
            </label>
            <button
              className={annotateTool === "draw" ? "toolbar-button compact accent" : "toolbar-button compact"}
              type="button"
              onClick={() => setAnnotateTool("draw")}
            >
              線
            </button>
            <button
              className={annotateTool === "text" ? "toolbar-button compact accent" : "toolbar-button compact"}
              type="button"
              onClick={() => setAnnotateTool("text")}
            >
              文字
            </button>
            {annotateTool === "text" && (
              <>
                <button className="secondary" type="button" onClick={duplicateActiveTextAnnotation} disabled={!activeText}>
                  複製
                </button>
                <button className="secondary" type="button" onClick={removeActiveTextAnnotation} disabled={!activeText}>
                  削除
                </button>
                <label className="field draw-field compact">
                  <span>角度</span>
                  <input
                    type="range"
                    min="-180"
                    max="180"
                    value={activeText?.angleDeg || 0}
                    onChange={(event) => activeText && updateAnnotation(activeText.id, { angleDeg: Number(event.target.value) })}
                    disabled={!activeText}
                  />
                </label>
              </>
            )}
            <button
              className="secondary"
              type="button"
              onClick={() => restoreHistory(historyIndex - 1)}
              disabled={historyIndex <= 0}
            >
              Undo
            </button>
            <button
              className="secondary"
              type="button"
              onClick={() => restoreHistory(historyIndex + 1)}
              disabled={historyIndex >= history.length - 1}
            >
              Redo
            </button>
          </div>
        )}
        <div className="image-edit-wrap" ref={wrapRef} onDoubleClick={handleAnnotationWrapDoubleClick}>
          <canvas
            ref={canvasRef}
            className={mode === "crop" ? "draw-canvas crop-canvas" : "draw-canvas"}
            width="900"
            height="520"
            onPointerDown={startPointer}
            onPointerMove={movePointer}
            onPointerUp={endPointer}
            onPointerLeave={endPointer}
          />
          {mode === "annotate" && (
            <div className="annotation-layer">
              {textAnnotations.map((annotation) => {
                const scaleX = wrapSize.width / 900;
                const scaleY = wrapSize.height / 520;
                const left = (annotation.x || 0) * scaleX;
                const top = (annotation.y || 0) * scaleY;
                const fontSize = (annotation.fontSize || 24) * scaleX;
                const selected = activeTextId === annotation.id;
                return (
                  <div
                    key={annotation.id}
                    className={selected ? "annotation-text selected" : "annotation-text"}
                    style={{
                      left,
                      top,
                      color: annotation.color || "#ffffff",
                      fontSize,
                      transform: `rotate(${annotation.angleDeg || 0}deg)`,
                      transformOrigin: "left top",
                    }}
                    onPointerDown={(event) => beginTextTransform(event, annotation, "move")}
                  >
                    <button
                      className="annotation-move"
                      type="button"
                      onPointerDown={(event) => beginTextTransform(event, annotation, "move")}
                      aria-label="テキストを移動"
                    >
                      ⠿
                    </button>
                    <input
                      value={annotation.text}
                      onChange={(event) => updateAnnotation(annotation.id, { text: event.target.value })}
                      onPointerDown={(event) => event.stopPropagation()}
                    />
                    {selected && (
                      <button
                        className="annotation-resize"
                        type="button"
                        onPointerDown={(event) => beginTextTransform(event, annotation, "resize")}
                        aria-label="テキストサイズを調整"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {mode === "crop" && cropRect && (
            <div
              className="crop-overlay"
              style={{
                left: `${(cropRect.x / 900) * 100}%`,
                top: `${(cropRect.y / 520) * 100}%`,
                width: `${(cropRect.width / 900) * 100}%`,
                height: `${(cropRect.height / 520) * 100}%`,
              }}
            />
          )}
        </div>
        <DialogActions onClose={onClose} />
      </form>
    </Dialog>
  );
}

function Lightbox({ item, hasPrevious, hasNext, onClose, onPrevious, onNext, onTitleChange }) {
  const [isZoomed, setIsZoomed] = useState(false);
  const [showChrome, setShowChrome] = useState(true);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(item.title || "");
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [mediaNaturalSize, setMediaNaturalSize] = useState({
    width: item.mediaWidth || 0,
    height: item.mediaHeight || 0,
  });
  const hideTimerRef = useRef(null);

  const zoomMetrics = useMemo(() => {
    const viewportWidth = Math.max(0, viewportSize.width);
    const viewportHeight = Math.max(0, viewportSize.height);
    const naturalWidth = Math.max(0, mediaNaturalSize.width);
    const naturalHeight = Math.max(0, mediaNaturalSize.height);
    if (!viewportWidth || !viewportHeight || !naturalWidth || !naturalHeight) return null;
    const ratio = naturalWidth / naturalHeight;
    let width = viewportWidth;
    let height = width / ratio;
    if (height > viewportHeight) {
      height = viewportHeight;
      width = height * ratio;
    }
    return {
      width,
      height,
    };
  }, [mediaNaturalSize.height, mediaNaturalSize.width, viewportSize.height, viewportSize.width]);

  function pingChrome() {
    setShowChrome(true);
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setShowChrome(false), 1400);
  }

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && hasPrevious) onPrevious();
      if (event.key === "ArrowRight" && hasNext) onNext();
      pingChrome();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasNext, hasPrevious, onClose, onNext, onPrevious]);

  useEffect(() => {
    pingChrome();
    setIsEditingTitle(false);
    setTitleDraft(item.title || "");
    setMediaNaturalSize({ width: item.mediaWidth || 0, height: item.mediaHeight || 0 });
  }, [item.id]);

  useEffect(() => () => window.clearTimeout(hideTimerRef.current), []);

  useEffect(() => {
    function updateViewportSize() {
      setViewportSize({
        width: document.documentElement.clientWidth || window.innerWidth || 0,
        height: document.documentElement.clientHeight || window.innerHeight || 0,
      });
    }
    updateViewportSize();
    window.addEventListener("resize", updateViewportSize);
    return () => window.removeEventListener("resize", updateViewportSize);
  }, []);

  return (
    <div
      className={`${isZoomed ? "lightbox zoomed" : "lightbox"} ${showChrome ? "chrome-visible" : "chrome-hidden"}`}
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      onMouseMove={pingChrome}
      onPointerDown={pingChrome}
    >
      <button className="lightbox-close" type="button" onClick={onClose} aria-label="閉じる">
        ×
      </button>
      <button
        className="lightbox-nav lightbox-prev"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          pingChrome();
          onPrevious();
        }}
        disabled={!hasPrevious}
        aria-label="前の画像"
      >
        ‹
      </button>
      <figure
        className="lightbox-figure"
        style={
          isZoomed && zoomMetrics
            ? {
                width: `${zoomMetrics.width}px`,
                height: `${zoomMetrics.height}px`,
              }
            : undefined
        }
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={() => {
          pingChrome();
          setIsZoomed((value) => !value);
        }}
      >
        {item.type === "video" ? (
          <video
            src={item.imagePath}
            controls
            autoPlay
            onLoadedMetadata={(event) =>
              setMediaNaturalSize({
                width: event.currentTarget.videoWidth || item.mediaWidth || 0,
                height: event.currentTarget.videoHeight || item.mediaHeight || 0,
              })
            }
            style={
              isZoomed && zoomMetrics ? { width: `${zoomMetrics.width}px`, height: `${zoomMetrics.height}px` } : undefined
            }
            onDoubleClick={(event) => {
              event.stopPropagation();
              pingChrome();
              setIsZoomed((value) => !value);
            }}
          />
        ) : (
          <img
            src={item.imagePath}
            alt={item.title || "画像"}
            onLoad={(event) =>
              setMediaNaturalSize({
                width: event.currentTarget.naturalWidth || item.mediaWidth || 0,
                height: event.currentTarget.naturalHeight || item.mediaHeight || 0,
              })
            }
            style={
              isZoomed && zoomMetrics ? { width: `${zoomMetrics.width}px`, height: `${zoomMetrics.height}px` } : undefined
            }
            onDoubleClick={(event) => {
              event.stopPropagation();
              pingChrome();
              setIsZoomed((value) => !value);
            }}
          />
        )}
        <figcaption>
          {item.label && <span className="chip">{item.label}</span>}
          {isEditingTitle ? (
            <input
              className="lightbox-title-input"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={() => {
                const next = titleDraft.trim();
                if (next) onTitleChange(next);
                setIsEditingTitle(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  const next = titleDraft.trim();
                  if (next) onTitleChange(next);
                  setIsEditingTitle(false);
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setTitleDraft(item.title || "");
                  setIsEditingTitle(false);
                }
              }}
              autoFocus
            />
          ) : (
            <strong
              className="editable-lightbox-title"
              onDoubleClick={(event) => {
                event.stopPropagation();
                setTitleDraft(item.title || "");
                setIsEditingTitle(true);
              }}
            >
              {item.title || "Untitled"}
            </strong>
          )}
          {item.content && <span>{item.content}</span>}
        </figcaption>
      </figure>
      <button
        className="lightbox-nav lightbox-next"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          pingChrome();
          onNext();
        }}
        disabled={!hasNext}
        aria-label="次の画像"
      >
        ›
      </button>
    </div>
  );
}

